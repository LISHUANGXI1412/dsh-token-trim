// compaction 指令的真实成本：直接读 compaction/summary 事件里的 usage（摘要调用本身），
// 再和整个会话的计费对比。同时也算"压缩后重灌"的那一步。
// 运行：node tools/compaction-cost.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles, PRICES } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

let totalCost = 0
let totalSteps = 0
let compactionCalls = 0
let compactionCost = 0
let compactionIn = 0
let compactionCacheRead = 0
let compactionOut = 0
let shadowedTokens = 0
let refillCost = 0
let refillTokens = 0
const perSession = []

for (const [sessionId, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }
  let sessionCost = 0
  let sessionSteps = 0
  let sessionCompactions = 0
  let sessionCompactionCost = 0
  let pendingRefill = false
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    const usage = e.data?.usage
    if (e.type === 'compaction/summary') {
      if (!usage) continue
      const inTok = Number(usage.inputTokens) || 0
      const cr = Number(usage.cacheReadTokens) || 0
      const out = Number(usage.outputTokens) || 0
      const cost = inTok * PRICES.miss + cr * PRICES.hit + out * PRICES.out
      compactionCalls += 1
      compactionCost += cost
      compactionIn += inTok
      compactionCacheRead += cr
      compactionOut += out
      shadowedTokens += Number(e.data?.shadowedTokenCount) || 0
      sessionCompactions += 1
      sessionCompactionCost += cost
      pendingRefill = true
      continue
    }
    if (e.type !== 'assistant/message' || !usage) continue
    const inTok = Number(usage.inputTokens) || 0
    const cost = inTok * PRICES.miss + (Number(usage.cacheReadTokens) || 0) * PRICES.hit + (Number(usage.outputTokens) || 0) * PRICES.out
    if (pendingRefill) {
      // 压缩后的第一步：上下文要重新写入缓存，按未命中计价
      refillCost += inTok * PRICES.miss
      refillTokens += inTok
      pendingRefill = false
    }
    totalCost += cost
    totalSteps += 1
    sessionCost += cost
    sessionSteps += 1
  }
  totalCost += sessionCompactionCost
  perSession.push({ sessionId, steps: sessionSteps, compactions: sessionCompactions, cost: sessionCost + sessionCompactionCost, compactionCost: sessionCompactionCost })
}

const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e3).toFixed(1) + 'K')
console.log(`sessions=${sessions.length} steps=${totalSteps} compactions=${compactionCalls}`)
console.log(`total cost            ${fmt(totalCost)}`)
console.log(`compaction call cost  ${fmt(compactionCost)}  (${((compactionCost / totalCost) * 100).toFixed(1)}% of total)`)
console.log(`  summary input  ${fmt(compactionIn)} tok  ≈ ${fmt(compactionIn * PRICES.miss)}`)
console.log(`  cache read     ${fmt(compactionCacheRead)} tok ≈ ${fmt(compactionCacheRead * PRICES.hit)}`)
console.log(`  summary output ${fmt(compactionOut)} tok  ≈ ${fmt(compactionOut * PRICES.out)}`)
console.log(`  avg shadowed tokens per compaction: ${Math.round(shadowedTokens / Math.max(1, compactionCalls))}`)
console.log(`refill after compaction ${fmt(refillTokens)} tok ≈ ${fmt(refillCost)} (${((refillCost / totalCost) * 100).toFixed(1)}% of total)`)
console.log(`compaction total (summary call + refill) ≈ ${fmt(compactionCost + refillCost)} (${(((compactionCost + refillCost) / totalCost) * 100).toFixed(1)}%)`)
const withCompaction = perSession.filter((s) => s.compactions > 0)
console.log(`\nsessions with compaction: ${withCompaction.length}/${perSession.length}`)
for (const s of withCompaction.sort((a, b) => b.compactionCost - a.compactionCost).slice(0, 6)) {
  console.log('  ' + String(s.compactions).padStart(2) + 'x  ' + fmt(s.compactionCost).padStart(7) + ' / total ' + fmt(s.cost).padStart(7) + '  (' + ((s.compactionCost / s.cost) * 100).toFixed(1) + '%)')
}
