// 输出（×15 计价）花在哪：assistant 正文 vs 各工具的入参。
// 运行：node tools/output-audit.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

let outTokens = 0
let steps = 0
let assistantTextChars = 0
let reasoningChars = 0
const argChars = new Map()
let calls = 0

for (const [, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    const d = e.data || {}
    if (e.type === 'assistant/message') {
      const usage = d.usage
      if (usage && (usage.outputTokens != null || usage.out != null)) {
        outTokens += Number(usage.outputTokens ?? usage.out) || 0
        steps += 1
      }
      const blocks = Array.isArray(d.message?.content) ? d.message.content : []
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string') assistantTextChars += b.text.length
        if (b?.type === 'reasoning' && typeof b.text === 'string') reasoningChars += b.text.length
        if (b?.type === 'thinking' && typeof b.thinking === 'string') reasoningChars += b.thinking.length
      }
      continue
    }
    if (e.type === 'tool/call') {
      calls += 1
      const name = String(d.name ?? '?')
      const raw = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
      argChars.set(name, (argChars.get(name) ?? 0) + raw.length)
    }
  }
}

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(1) + 'K')
const totalArgs = [...argChars.values()].reduce((a, b) => a + b, 0)
const CHAR_PER_TOK = 0.306

console.log(`sessions=${sessions.length} steps=${steps} measured outTokens=${fmt(outTokens)}`)
console.log(`assistant text chars=${fmt(assistantTextChars)} (≈ ${fmt(assistantTextChars * CHAR_PER_TOK)} tok)`)
console.log(`reasoning chars=${fmt(reasoningChars)}`)
console.log(`tool-call argument chars=${fmt(totalArgs)} (≈ ${fmt(totalArgs * CHAR_PER_TOK)} tok) over ${calls} calls`)
console.log('\nwhere the output goes (by argument chars)')
const top = [...argChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
for (const [name, chars] of top) {
  console.log('  ' + name.padEnd(26) + fmt(chars).padStart(8) + '  ≈' + fmt(chars * CHAR_PER_TOK).padStart(8) + ' tok  ' + ((chars / totalArgs) * 100).toFixed(1) + '%')
}
console.log('\ntotals: args + assistant text ≈ ' + fmt((totalArgs + assistantTextChars) * CHAR_PER_TOK) + ' tok vs measured ' + fmt(outTokens) + ' tok')
