// 压缩阈值扫描：用真实每步增量（miss tokens）回放不同 policy，比较"上下文重发"成本。
// 这是账单里 87.8% 的大头所在：平均每步要重发 35.7 万 token。
// 运行：node tools/policy-sweep.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles, parseLog, estimateCompactionSavings } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

const deltasBySession = []
for (const [, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }
  const { steps } = parseLog(text)
  const deltas = steps.map((s) => s.miss).filter((n) => n > 0)
  if (deltas.length > 20) deltasBySession.push(deltas)
}

const policies = [
  { label: '0.8 / 0.16 (shipped default)', thresholdRatio: 0.8, retainRatio: 0.16 },
  { label: '0.4 / 0.12 (current)', thresholdRatio: 0.4, retainRatio: 0.12 },
  { label: '0.35 / 0.10', thresholdRatio: 0.35, retainRatio: 0.1 },
  { label: '0.30 / 0.10', thresholdRatio: 0.3, retainRatio: 0.1 },
  { label: '0.25 / 0.08', thresholdRatio: 0.25, retainRatio: 0.08 },
  { label: '0.20 / 0.06', thresholdRatio: 0.2, retainRatio: 0.06 },
]

const results = []
for (const p of policies) {
  let cost = 0
  let events = 0
  let steps = 0
  for (const deltas of deltasBySession) {
    const r = estimateCompactionSavings(deltas, {
      thresholdRatio: p.thresholdRatio,
      retainRatio: p.retainRatio,
      baseThresholdRatio: p.thresholdRatio,
      baseRetainRatio: p.retainRatio,
    })
    if (!r) continue
    cost += r.currentCost
    events += r.currentEvents
    steps += r.steps
  }
  results.push({ ...p, cost, events, steps })
}

const base = results[0].cost
console.log(`sessions=${deltasBySession.length} steps=${results[0].steps}`)
console.log('policy'.padEnd(34) + 'compaction cost'.padStart(18) + 'vs shipped'.padStart(12) + 'vs current'.padStart(12) + 'events'.padStart(8))
const current = results.find((r) => r.label.startsWith('0.4'))
for (const r of results) {
  const vsBase = ((r.cost / base - 1) * 100).toFixed(1) + '%'
  const vsCurrent = ((r.cost / current.cost - 1) * 100).toFixed(1) + '%'
  console.log(
    r.label.padEnd(34) +
    (r.cost / 1e9).toFixed(2).padStart(13) + 'B' +
    vsBase.padStart(12) +
    (r.label === current.label ? '—' : vsCurrent).padStart(12) +
    String(r.events).padStart(8),
  )
}
console.log('\n注意：这是压缩层单独的回放（不含工具治理），假设每步新增内容不变；')
console.log('阈值越低，上下文越小但压缩次数越多，且可能因丢失细节导致 agent 多走步——后者不在模型里。')
