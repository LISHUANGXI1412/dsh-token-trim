// 反事实回放：用真实会话日志逐 step 计算「如果没有 token-trim，账单会是多少」。
//
// 模型（每一步都可在 README 里核对）：
//   1. 一条被改写的结果在第 i0 个请求进入上下文（取 ts 之后的第一个 assistant/message）；
//   2. 它一直留在上下文里，直到下一次 compaction（compaction/summary）把它换掉；
//   3. 于是"多出来的 token"在 k 个请求里被重复支付：
//        - 第一步是未命中（新内容）→ 价格 ×10
//        - 之后 k-1 步是缓存命中 → 价格 ×1
//   4. 反事实账单 = 当前账单 + Σ(savedTokens × (10 + (k-1)))
//
// 只统计能对齐到真实 step 的改写；legacy 行（没有 session）只计数不参与。
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from '../vendor/fzstd/index.mjs'

export const PRICES = { hit: 1, miss: 10, out: 15 }
export const TOK_PER_CHAR = 0.306
const MAX_LOG_BYTES = 32 * 1024 * 1024

/** 扫描 sessions 根目录，建立 sessionId -> 文件 的索引。 */
export function indexSessionFiles(sessionsRoot) {
  const map = new Map()
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.name === 'session.v4.jsonl.zstd') {
        const id = path.basename(dir)
        try {
          const stat = fs.statSync(full)
          if (stat.size <= MAX_LOG_BYTES) map.set(id, { file: full, size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {}
      }
    }
  }
  walk(sessionsRoot, 0)
  return map
}

/** 解析日志文本：保留每一步的时间、用量，以及 compaction 发生在第几步之后。 */
export function parseLog(text) {
  const steps = []
  const compactions = []
  let current = 0
  for (const line of String(text).split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'compaction/summary') {
      compactions.push(steps.length)
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue
    const hit = Number(usage.cacheReadTokens) || 0
    const miss = Number(usage.inputTokens) || 0
    const out = Number(usage.outputTokens) || 0
    const prompt = hit + miss
    steps.push({ time: Number(event.time) || 0, hit, miss, out, prompt })
    current += 1
  }
  return { steps, compactions }
}

export function replaySession({ steps, compactions, rewrites, tokPerChar = TOK_PER_CHAR }) {
  let savedEquiv = 0
  let aligned = 0
  let skipped = 0
  for (const rewrite of rewrites) {
    const savedTokens = (Number(rewrite.originalChars) - Number(rewrite.visibleChars)) * tokPerChar
    if (!(savedTokens > 0)) continue
    const ts = Number(rewrite.ts) || 0
    if (!ts) {
      skipped += 1
      continue
    }
    let i0 = -1
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i].time > ts) {
        i0 = i
        break
      }
    }
    if (i0 < 0) {
      // 改写发生在最后一次请求之后：它在本次会话里没有被重复发送过
      skipped += 1
      continue
    }
    let end = steps.length
    for (const index of compactions) {
      if (index > i0) {
        end = index
        break
      }
    }
    const k = end - i0
    if (k <= 0) {
      skipped += 1
      continue
    }
    savedEquiv += savedTokens * (PRICES.miss + Math.max(0, k - 1) * PRICES.hit)
    aligned += 1
  }
  return { savedEquiv, aligned, skipped }
}

export function costOf(steps) {
  let cost = 0
  for (const step of steps) {
    cost += step.hit * PRICES.hit + step.miss * PRICES.miss + step.out * PRICES.out
  }
  return cost
}

/** 主入口：把 manifest 里的改写事件按会话对齐到真实日志，算出反事实账单占比。 */
export function replayAll({ manifest, sessionsRoot, tokPerChar = TOK_PER_CHAR, log = () => {} }) {
  let records = []
  try {
    records = fs
      .readFileSync(manifest, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return { available: false, reason: 'no-manifest', manifest }
  }

  const files = indexSessionFiles(sessionsRoot)
  const bySession = new Map()
  let legacy = 0
  for (const record of records) {
    const session = record.session
    if (!session || session === 'legacy') {
      legacy += 1
      continue
    }
    const list = bySession.get(session) ?? []
    list.push(record)
    bySession.set(session, list)
  }

  const sessions = []
  let savedEquiv = 0
  let costCurrent = 0
  let aligned = 0
  let skipped = 0
  let missing = 0

  for (const [session, rewrites] of bySession) {
    const entry = files.get(session)
    if (!entry) {
      missing += 1
      continue
    }
    let parsed
    try {
      const raw = decompress(fs.readFileSync(entry.file))
      parsed = parseLog(Buffer.from(raw).toString('utf8'))
    } catch {
      missing += 1
      continue
    }
    const result = replaySession({ steps: parsed.steps, compactions: parsed.compactions, rewrites, tokPerChar })
    const cost = costOf(parsed.steps)
    savedEquiv += result.savedEquiv
    costCurrent += cost
    aligned += result.aligned
    skipped += result.skipped
    sessions.push({
      sessionId: session,
      steps: parsed.steps.length,
      compactions: parsed.compactions.length,
      rewrites: rewrites.length,
      aligned: result.aligned,
      skipped: result.skipped,
      savedEquiv: result.savedEquiv,
      costCurrent: cost,
      savedPct: cost + result.savedEquiv > 0 ? (result.savedEquiv / (cost + result.savedEquiv)) * 100 : 0,
    })
    log(session)
  }

  sessions.sort((a, b) => b.savedEquiv - a.savedEquiv)
  const baseline = costCurrent + savedEquiv
  return {
    available: aligned > 0,
    manifest,
    sessionsRoot,
    totals: {
      sessions: sessions.length,
      events: records.length,
      aligned,
      skipped,
      missingSessions: missing,
      legacy,
      costCurrent,
      savedEquiv,
      baselineCost: baseline,
      savedPct: baseline > 0 ? (savedEquiv / baseline) * 100 : 0,
    },
    sessions: sessions.slice(0, 20),
  }
}
