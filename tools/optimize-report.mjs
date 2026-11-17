// 效果优化实验：把最近 N 天真实会话日志里的工具结果，用不同配置重放一遍，
// 算出「能省多少字符 / 多少账单当量」，用来判断调参和新规则值不值得做。
// 运行：node tools/optimize-report.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const TOK_PER_CHAR = 0.306
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-optimize-'))

function makeHandler(config, tag) {
  let handler = null
  const ctx = {
    on(_event, fn) { handler = fn },
    tools: { register() {} },
  }
  apply(ctx, {
    artifactDir: path.join(tmp, 'artifacts-' + tag),
    manifest: path.join(tmp, 'manifest-' + tag + '.jsonl'),
    ...config,
  })
  if (!handler) throw new Error('handler not registered')
  return handler
}

// ---- 收集真实工具结果 ----
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

const samples = [] // { sessionId, tool, text, k, args }
const toolChars = new Map()
let multiBlock = 0

for (const [sessionId, entry] of sessions) {
  let text
  try {
    text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8')
  } catch {
    continue
  }
  const calls = new Map()
  const results = []
  const compactions = []
  let assistantCount = 0
  let totalAssistants = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!event || typeof event !== 'object') continue
    const data = event.data || {}

    if (event.type === 'tool/call') {
      calls.set(data.callId, { name: String(data.name || 'unknown'), arguments: data.arguments })
      continue
    }
    if (event.type === 'compaction/summary') {
      compactions.push(assistantCount)
      continue
    }
    if (event.type === 'assistant/message') {
      assistantCount += 1
      totalAssistants = assistantCount
      continue
    }
    if (event.type !== 'tool/result') continue

    const message = data.message || {}
    const blocks = Array.isArray(message.content) ? message.content : []
    const textBlocks = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    if (textBlocks.length !== 1) { multiBlock += 1; continue }
    const call = calls.get(message.toolCallId)
    results.push({ tool: call ? call.name : 'unknown', args: call ? call.arguments : '', chars: textBlocks[0].text.length, text: textBlocks[0].text, stepIndex: assistantCount })
  }

  for (const result of results) {
    let k = totalAssistants - result.stepIndex
    for (const index of compactions) if (index > result.stepIndex) { k = index - result.stepIndex; break }
    if (k <= 0) continue
    toolChars.set(result.tool, (toolChars.get(result.tool) || 0) + result.chars)
    samples.push({ sessionId, tool: result.tool, args: result.args, text: result.text, k })
  }
}

const totalObserved = [...toolChars.values()].reduce((a, b) => a + b, 0)
console.log(`sessions=${sessions.length} results=${samples.length} multiBlockSkipped=${multiBlock}`)
console.log(`total tool-result chars observed: ${(totalObserved / 1e6).toFixed(2)}M\n`)
console.log('top tools by observed chars')
for (const [tool, chars] of [...toolChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ' + tool.padEnd(36), (chars / 1e6).toFixed(2) + 'M')
}
console.log('')

// ---- 配置对照组 ----
const configs = [
  { tag: 'current', label: 'current (minChars 2000, pwsh 4000)', config: {} },
  { tag: 'min1200', label: 'minChars 1200', config: { minChars: 1200 } },
  { tag: 'min1200-caps', label: '+ pwsh cap 2500 / inspect 8000', config: { minChars: 1200, caps: { pwsh: 2500, cordis_inspect_query: 8000 } } },
  { tag: 'read6k', label: '+ read cap 6000 (risky: triggers re-reads)', config: { minChars: 1200, caps: { pwsh: 2500, cordis_inspect_query: 8000, read: 6000 } } },
  { tag: 'min800', label: 'minChars 800 + caps', config: { minChars: 800, caps: { pwsh: 2500, cordis_inspect_query: 8000 } } },
  { tag: 'mcp', label: '+ proxy_run cap 4000', config: { minChars: 1200, caps: { pwsh: 2500, cordis_inspect_query: 8000, 'mcp__local-proxy__proxy_run': 4000 } } },
  { tag: 'read20k', label: '+ read cap 20000 (only huge files)', config: { minChars: 1200, caps: { pwsh: 2500, cordis_inspect_query: 8000, 'mcp__local-proxy__proxy_run': 4000, read: 20000 } } },
  { tag: 'tight', label: '+ job_output 4000 / grep 6000', config: { minChars: 1200, caps: { pwsh: 2500, cordis_inspect_query: 8000, 'mcp__local-proxy__proxy_run': 4000, job_output: 4000, grep: 6000 } } },
]

const report = []
for (const variant of configs) {
  const handler = makeHandler(variant.config, variant.tag)
  let events = 0
  let savedChars = 0
  let billEquiv = 0
  let byTool = new Map()

  for (const sample of samples) {
    const exec = { name: sample.tool, callId: 'c', arguments: sample.args, sessionId: sample.sessionId }
    const result = { content: [{ type: 'text', text: sample.text }] }
    const decided = await handler(exec, result, async () => result)
    const visible = (decided && decided.content && decided.content[0] && decided.content[0].text) || sample.text
    const saved = sample.text.length - visible.length
    if (saved <= 0) continue
    events += 1
    savedChars += saved
    billEquiv += saved * TOK_PER_CHAR * (10 + Math.max(0, sample.k - 1))
    byTool.set(sample.tool, (byTool.get(sample.tool) || 0) + saved)
  }

  report.push({ ...variant, events, savedChars, billEquiv, byTool })
}

const base = report[0]
console.log('config'.padEnd(52) + 'events'.padStart(8) + 'saved'.padStart(10) + 'bill equiv'.padStart(14) + 'vs current'.padStart(12))
for (const row of report) {
  const delta = base.billEquiv > 0 ? ((row.billEquiv / base.billEquiv - 1) * 100).toFixed(1) + '%' : '—'
  console.log(
    row.label.padEnd(52) +
    String(row.events).padStart(8) +
    (row.savedChars / 1e6).toFixed(2).padStart(10) + 'M' +
    (row.billEquiv / 1e6).toFixed(1).padStart(13) + 'M' +
    (row === base ? '' : delta).padStart(12),
  )
}

console.log('\nwhere the extra savings come from (top tools, saved chars)')
for (const row of report.slice(1)) {
  const top = [...row.byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  console.log('  ' + row.tag.padEnd(14) + top.map(([t, c]) => t + ':' + (c / 1e3).toFixed(0) + 'K').join('  '))
}

fs.rmSync(tmp, { recursive: true, force: true })
