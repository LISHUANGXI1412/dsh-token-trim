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
import { homedir } from 'node:os'
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

// ---- 压缩阈值节省（与 dsh-context-kit 同一算法）---------------------------------
// 用实测的每步增量回放两套策略（当前阈值 vs 出厂 0.8/0.16），比较总成本。
export const DEFAULT_WINDOW = 1048576
export const BASE_POLICY = { thresholdRatio: 0.8, retainRatio: 0.16 }
export const FALLBACK_POLICY = { thresholdRatio: 0.4, retainRatio: 0.12 }

const triggerFor = (window, ratio) => Math.min(Math.floor(window * ratio), window - 256000 - 65536)

export function estimateCompactionSavings(deltas, options = {}) {
  const window = options.contextWindow ?? DEFAULT_WINDOW
  const current = {
    thresholdRatio: options.thresholdRatio ?? FALLBACK_POLICY.thresholdRatio,
    retainRatio: options.retainRatio ?? FALLBACK_POLICY.retainRatio,
  }
  const base = {
    thresholdRatio: options.baseThresholdRatio ?? BASE_POLICY.thresholdRatio,
    retainRatio: options.baseRetainRatio ?? BASE_POLICY.retainRatio,
  }
  const summaryRatio = options.summaryRatio ?? 0.005
  const steps = deltas.filter((value) => Number.isFinite(value) && value > 0)
  if (steps.length === 0) return null

  const replay = (policy) => {
    const trigger = triggerFor(window, policy.thresholdRatio)
    const retain = Math.floor(window * policy.retainRatio)
    let prompt = 0
    let cost = 0
    let events = 0
    for (const step of steps) {
      const previous = prompt
      prompt += step
      if (prompt > trigger && prompt - retain > 20000) {
        const shadowed = prompt - retain
        const summary = Math.max(60, Math.round(shadowed * summaryRatio))
        if (summary < shadowed) {
          cost += shadowed * PRICES.miss + summary * PRICES.out
          events += 1
          prompt = retain + summary
          cost += prompt * PRICES.miss
          continue
        }
      }
      cost += previous * PRICES.hit + step * PRICES.miss
    }
    return { cost, events }
  }

  const currentRun = replay(current)
  const baseRun = replay(base)
  const delta = Math.max(0, baseRun.cost - currentRun.cost)
  return {
    baseCost: baseRun.cost,
    currentCost: currentRun.cost,
    baseEvents: baseRun.events,
    currentEvents: currentRun.events,
    delta,
    savedPct: baseRun.cost > 0 ? ((baseRun.cost - currentRun.cost) / baseRun.cost) * 100 : 0,
    steps: steps.length,
    policy: current,
    basePolicy: base,
  }
}

/** 读当前压缩策略：扫 profile 里的 dsh-context-kit/settings.json，取最新一份。
 *  注意：settings.json 的真实结构是
 *    { presets: { <preset>: { plugins: { 'compaction-basic': { config: { thresholdRatio, retainRatio } } } } } }
 *  0.2.3 及以前只读顶层字段，于是永远回落到 0.4/0.12 —— 用户改了阈值，面板却仍显示旧值。
 *  现在递归找第一个同时/单独带 thresholdRatio 的 config 对象，并兼容旧的扁平格式。 */
function findThresholdConfig(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null
  const t = Number(node.thresholdRatio)
  if (Number.isFinite(t) && t > 0) return node
  for (const value of Object.values(node)) {
    const found = findThresholdConfig(value, depth + 1)
    if (found) return found
  }
  return null
}

export function readCompactionPolicy({ profilesRoot } = {}) {
  const base = profilesRoot ?? path.join(homedir(), '.dsh', 'profiles')
  let best = null
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(base, entry.name, 'dsh-context-kit', 'settings.json')
      try {
        const stat = fs.statSync(file)
        if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs }
      } catch {}
    }
  } catch {
    return { ...FALLBACK_POLICY, source: 'fallback' }
  }
  if (!best) return { ...FALLBACK_POLICY, source: 'fallback' }
  try {
    const parsed = JSON.parse(fs.readFileSync(best.file, 'utf8'))
    const config = findThresholdConfig(parsed)
    if (!config) return { ...FALLBACK_POLICY, source: best.file }
    const thresholdRatio = Number(config.thresholdRatio)
    const retainRatio = Number(config.retainRatio)
    return {
      thresholdRatio: Number.isFinite(thresholdRatio) && thresholdRatio > 0 ? thresholdRatio : FALLBACK_POLICY.thresholdRatio,
      retainRatio: Number.isFinite(retainRatio) && retainRatio > 0 ? retainRatio : FALLBACK_POLICY.retainRatio,
      source: best.file,
    }
  } catch {
    return { ...FALLBACK_POLICY, source: 'fallback' }
  }
}

// 解析结果缓存：同一日志文件（mtime+size 未变）不重复解压。
const parseCache = new Map()

function parseSessionCached(entry) {
  const key = entry.file
  const cached = parseCache.get(key)
  if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) return cached.parsed
  const raw = decompress(fs.readFileSync(entry.file))
  const parsed = parseLog(Buffer.from(raw).toString('utf8'))
  parseCache.set(key, { mtimeMs: entry.mtimeMs, size: entry.size, parsed })
  if (parseCache.size > 24) parseCache.delete(parseCache.keys().next().value)
  return parsed
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
  const policy = readCompactionPolicy()
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
  let compactionDelta = 0
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
      parsed = parseSessionCached(entry)
    } catch {
      missing += 1
      continue
    }
    const result = replaySession({ steps: parsed.steps, compactions: parsed.compactions, rewrites, tokPerChar })
    const cost = costOf(parsed.steps)
    const deltas = []
    let previous = 0
    for (const step of parsed.steps) {
      const delta = step.prompt - previous
      if (delta > 0) deltas.push(delta)
      previous = step.prompt
    }
    const compaction = estimateCompactionSavings(deltas, {
      thresholdRatio: policy.thresholdRatio,
      retainRatio: policy.retainRatio,
    })
    savedEquiv += result.savedEquiv
    compactionDelta += compaction ? compaction.delta : 0
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
      compactionDelta: compaction ? compaction.delta : 0,
      costCurrent: cost,
    })
    log(session)
  }

  sessions.sort((a, b) => b.savedEquiv + b.compactionDelta - (a.savedEquiv + a.compactionDelta))
  const baselineCost = costCurrent + savedEquiv + compactionDelta
  const totalDelta = savedEquiv + compactionDelta
  const share = (value) => (baselineCost > 0 ? (value / baselineCost) * 100 : 0)
  return {
    available: aligned > 0,
    manifest,
    sessionsRoot,
    policy,
    totals: {
      sessions: sessions.length,
      events: records.length,
      aligned,
      skipped,
      missingSessions: missing,
      legacy,
      costCurrent,
      baselineCost,
      ruleSavedEquiv: savedEquiv,
      compactionSavedEquiv: compactionDelta,
      totalSavedEquiv: totalDelta,
      rulePct: share(savedEquiv),
      compactionPct: share(compactionDelta),
      totalPct: share(totalDelta),
    },
    sessions: sessions.slice(0, 20),
  }
}
