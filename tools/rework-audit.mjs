// 返工统计审计：不信任 manifest 的自报数，直接从会话日志重算一遍。
// 关注三件事：
//   1) 同 tool+target 30 分钟内的"重跑"到底有多少次；
//   2) 其中参数**完全一致**（真重跑）和**改过参数**（通常是有意修正）各占多少；
//   3) 每次重跑实际多花了多少 token（用相邻 step 的实测增量，而不是平均值）。
// 运行：node tools/rework-audit.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles, parseLog } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const WINDOW = 30 * 60 * 1000

function targetOf(args) {
  if (!args || typeof args !== 'object') return undefined
  const fileish = args.file_path ?? args.filePath ?? args.path
  if (typeof fileish === 'string' && fileish.trim()) return fileish.trim().slice(0, 160)
  const cmdish = args.command ?? args.cmd
  if (typeof cmdish === 'string' && cmdish.trim()) return cmdish.trim().replace(/\s+/g, ' ').slice(0, 80)
  const pattern = args.pattern
  if (typeof pattern === 'string' && pattern.trim()) return pattern.trim().slice(0, 80)
  return undefined
}

const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

let calls = 0
let withTarget = 0
let pairs = 0
let identical = 0
let modified = 0
const gaps = []
const identicalSamples = []
const modifiedSamples = []

for (const [, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }

  // 时间线：tool/call 带 time；assistant/message 是计费步
  const timeline = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (e.type === 'tool/call') {
      const d = e.data || {}
      let args = d.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch {} }
      timeline.push({ kind: 'call', time: Number(e.time) || 0, tool: String(d.name || '?'), target: targetOf(args), raw: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '') })
    } else if (e.type === 'assistant/message') {
      const usage = e.data?.usage
      if (!usage) continue
      timeline.push({ kind: 'step', time: Number(e.time) || 0, tokens: (Number(usage.cacheReadTokens) || 0) + (Number(usage.inputTokens) || 0) })
    }
  }

  const lastSeen = new Map()
  for (let i = 0; i < timeline.length; i += 1) {
    const item = timeline[i]
    if (item.kind !== 'call') continue
    calls += 1
    if (!item.target) continue
    withTarget += 1
    const key = item.tool + '|' + item.target
    const prev = lastSeen.get(key)
    if (prev && item.time - prev.time <= WINDOW) {
      pairs += 1
      const same = prev.raw === item.raw
      if (same) identical += 1
      else modified += 1
      gaps.push(item.time - prev.time)
      // 这次重跑之后的第一个 step 就是多花的部分（保守：整步都算给它）
      for (let j = i + 1; j < timeline.length; j += 1) {
        if (timeline[j].kind === 'step') {
          if (same && identicalSamples.length < 5) identicalSamples.push({ tool: item.tool, target: item.target.slice(0, 60), extra: timeline[j].tokens })
          if (!same && modifiedSamples.length < 5) modifiedSamples.push({ tool: item.tool, target: item.target.slice(0, 60), extra: timeline[j].tokens })
          break
        }
      }
    }
    lastSeen.set(key, { time: item.time, raw: item.raw })
  }
}

const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

console.log(`sessions=${sessions.length} tool_calls=${calls} with_target=${withTarget}`)
console.log(`same tool+target within ${WINDOW / 60000}min: ${pairs}`)
console.log(`  identical arguments (true rerun): ${identical}`)
console.log(`  modified arguments (likely deliberate): ${modified}`)
console.log(`  gap median: ${(median(gaps) / 60000).toFixed(1)} min`)
console.log('\nidentical-rerun examples (extra tokens in the following step):')
for (const s of identicalSamples) console.log('  ' + s.tool.padEnd(22) + String(s.extra).padStart(8) + '  ' + s.target)
console.log('\nmodified-argument examples:')
for (const s of modifiedSamples) console.log('  ' + s.tool.padEnd(22) + String(s.extra).padStart(8) + '  ' + s.target)
