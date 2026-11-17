// report.cjs — 读 manifest.jsonl，聚合成会话视图用的数据（无参数；窗口/会话筛选由客户端做）。
// 纯 fs，无第三方依赖；失败一律返回空结构（视图宁可空，不能报错）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 口径：本机实测 0.306 token/字符。
const TOK_PER_CHAR = 0.306
const LEGACY = 'legacy'
const MAX_LINES = 50000
const MAX_EVENTS = 150

function readManifest(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n')
    const start = Math.max(0, lines.length - MAX_LINES)
    const out = []
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out
  } catch {
    return []
  }
}

const emptyReport = () => ({
  available: false,
  generatedAt: Date.now(),
  totals: { events: 0, orig: 0, vis: 0, saved: 0, cutPct: 0, tokens: 0, artifacts: 0 },
  sessions: [],
  tools: [],
  modes: [],
  events: [],
  records: 0,
})

function shortTarget(value) {
  if (typeof value !== 'string' || !value) return ''
  return value.length > 90 ? value.slice(0, 89) + '…' : value
}

const rate = (row) => ({
  ...row,
  cutPct: row.orig ? Number(((1 - row.vis / row.orig) * 100).toFixed(1)) : 0,
  tokens: Math.round(row.saved * TOK_PER_CHAR),
})

function aggregate(records) {
  const totals = { events: 0, orig: 0, vis: 0, saved: 0, artifacts: 0 }
  const sessions = new Map()
  const tools = new Map()
  const modes = new Map()
  const events = []

  for (const r of records) {
    const ts = Number(r.ts) || 0
    const session = typeof r.session === 'string' && r.session ? r.session : LEGACY
    const orig = Number(r.originalChars) || 0
    const vis = Number(r.visibleChars) || 0
    const saved = Math.max(0, orig - vis)
    const tool = typeof r.tool === 'string' ? r.tool : '(unknown)'
    const mode = typeof r.mode === 'string' ? r.mode : 'base'

    totals.events += 1
    totals.orig += orig
    totals.vis += vis
    totals.saved += saved
    if (r.artifact) totals.artifacts += 1

    let s = sessions.get(session)
    if (!s) { s = { id: session, events: 0, orig: 0, vis: 0, saved: 0, first: ts, last: ts, tools: new Map() }; sessions.set(session, s) }
    s.events += 1; s.orig += orig; s.vis += vis; s.saved += saved
    s.first = Math.min(s.first, ts)
    s.last = Math.max(s.last, ts)
    const st = s.tools.get(tool) || { name: tool, events: 0, orig: 0, vis: 0, saved: 0 }
    st.events += 1; st.orig += orig; st.vis += vis; st.saved += saved
    s.tools.set(tool, st)

    const t = tools.get(tool) || { name: tool, events: 0, orig: 0, vis: 0, saved: 0 }
    t.events += 1; t.orig += orig; t.vis += vis; t.saved += saved
    tools.set(tool, t)

    modes.set(mode, (modes.get(mode) || 0) + 1)

    events.push({
      ts,
      tool,
      mode,
      orig,
      vis,
      saved,
      session,
      artifact: typeof r.artifact === 'string' ? r.artifact.split(/[\\/]/).pop().replace(/\.txt$/, '') : '',
      target: shortTarget(r.target),
      dryRun: Boolean(r.dryRun),
    })
  }

  const sessionRows = [...sessions.values()].map((s) => rate({
    ...s,
    tools: [...s.tools.values()].map(rate).sort((a, b) => b.saved - a.saved),
  })).sort((a, b) => b.last - a.last)

  return {
    available: records.length > 0,
    totals: rate(totals),
    sessions: sessionRows,
    tools: [...tools.values()].map(rate).sort((a, b) => b.saved - a.saved),
    modes: [...modes.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    events: events.sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS),
    records: records.length,
  }
}

function buildReport(opts = {}) {
  const file = opts.manifest
  if (!file) return emptyReport()
  const records = readManifest(file)
  if (!records.length) {
    const empty = emptyReport()
    empty.manifest = file
    empty.artifactDir = opts.artifactDir
    empty.dryRun = Boolean(opts.dryRun)
    return empty
  }
  const report = aggregate(records)
  report.available = true
  report.generatedAt = Date.now()
  report.manifest = file
  report.artifactDir = opts.artifactDir
  report.dryRun = Boolean(opts.dryRun)
  try { report.updatedAt = fs.statSync(file).mtimeMs } catch { report.updatedAt = 0 }
  return report
}

// 账单口径：命中缓存读 ×1、未命中输入 ×10、输出 ×15（与 reports/compaction-cost-analysis.md 一致）
const PRICE_HIT = 1
const PRICE_MISS = 10
const PRICE_OUT = 15

// 配置级账单估算（离线回放，2026-11-15 分析）：压缩阈值 0.4/0.12 对出厂 0.8/0.16 ≈ −31%；
// 规则层由 1,518 条真实结果回放 ≈ −15%；两者相乘 ≈ −41%。
const COMPACTION_PCT = 31
const RULES_PCT = 15
const TOTAL_PCT = Number((100 * (1 - (1 - COMPACTION_PCT / 100) * (1 - RULES_PCT / 100))).toFixed(1))

function findUsageCache() {
  const base = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    const found = []
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(base, entry.name, 'dsh-context-kit', 'usage-cache.json')
      try { found.push({ file, mtime: fs.statSync(file).mtimeMs }) } catch {}
    }
    found.sort((a, b) => b.mtime - a.mtime)
    return found[0] ? found[0].file : null
  } catch {
    return null
  }
}

// 返工信号（2026-11-17 修订）：旧版只用 tool+target，把「同一文件多次 edit」「read 带
// offset 补读」也算成返工 —— 7 天日志实测 3,431 次同类 target 里只有 48 次参数完全一致。
// 现在拆成两类，只有确认重跑才扣减：
//   ① 确认重跑：同会话 + 同 tool + 同 target + 同参数指纹（argsHash），30 分钟内；
//   ② 疑似补读：同 target 但参数变了，且上一次是被截断/摘要过的结果，5 分钟内 —— 单独展示，
//      不扣减（正常编辑也会落到这一类）。
// 老记录没有 argsHash，只能退回「同 target」判断，并标记 legacy: true。
const REWORK_WINDOW_MS = 30 * 60 * 1000
const CONTINUATION_WINDOW_MS = 5 * 60 * 1000
const TRUNCATED_MODES = new Set(['capped', 'summary', 'delta', 'unchanged'])

function estimateRework(records, avgStepCost) {
  const byKey = new Map()
  let suspected = 0
  let legacy = 0
  let continuation = 0
  const samples = []
  const continuationSamples = []
  for (const r of records) {
    if (!r.target) continue
    const ts = Number(r.ts) || 0
    if (!ts) continue
    const key = [r.session || LEGACY, r.tool, String(r.target).slice(0, 60)].join('|')
    const prev = byKey.get(key)
    if (prev) {
      const gap = ts - prev.ts
      const sameArgs = prev.argsHash && r.argsHash ? prev.argsHash === r.argsHash : null
      if (gap <= REWORK_WINDOW_MS && sameArgs === true) {
        suspected += 1
        if (samples.length < 3) samples.push({ tool: r.tool, target: shortTarget(r.target), ts })
      } else if (gap <= REWORK_WINDOW_MS && sameArgs === null) {
        // 老记录：无法区分参数，保持旧行为并标记
        suspected += 1
        legacy += 1
        if (samples.length < 3) samples.push({ tool: r.tool, target: shortTarget(r.target), ts, legacy: true })
      } else if (gap <= CONTINUATION_WINDOW_MS && sameArgs === false && TRUNCATED_MODES.has(prev.mode)) {
        continuation += 1
        if (continuationSamples.length < 3) continuationSamples.push({ tool: r.tool, target: shortTarget(r.target), ts })
      }
    }
    byKey.set(key, { ts, argsHash: r.argsHash || null, mode: r.mode || null })
  }
  const stepCost = Number(avgStepCost) || 0
  const costEquiv = suspected * stepCost
  return {
    suspected,
    legacy,
    continuation,
    costEquiv,
    samples,
    continuationSamples,
    windowMinutes: REWORK_WINDOW_MS / 60000,
    continuationWindowMinutes: CONTINUATION_WINDOW_MS / 60000,
  }
}

function buildBill(opts = {}) {
  const file = opts.cache || findUsageCache()
  if (!file) return { available: false, reason: 'no-usage-cache', compactionPct: COMPACTION_PCT, rulesPct: RULES_PCT, totalPct: TOTAL_PCT }
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { available: false, reason: 'unreadable', cache: file, compactionPct: COMPACTION_PCT, rulesPct: RULES_PCT, totalPct: TOTAL_PCT } }
  const sessions = []
  for (const [sessionPath, entry] of Object.entries(parsed.files || {})) {
    const c = entry && entry.compact
    if (!c) continue
    const hit = Number(c.hit) || 0
    const miss = Number(c.miss) || 0
    const out = Number(c.out) || 0
    sessions.push({
      sessionId: entry.summary && entry.summary.sessionId ? entry.summary.sessionId : null,
      path: sessionPath,
      steps: Number(c.stepCount) || 0,
      compactions: Number(c.compactions) || 0,
      duplicates: Number(c.duplicates) || 0,
      distinctCalls: Number(c.distinctCalls) || 0,
      hit,
      miss,
      out,
      cost: hit * PRICE_HIT + miss * PRICE_MISS + out * PRICE_OUT,
    })
  }
  if (!sessions.length) return { available: false, reason: 'empty', cache: file, compactionPct: COMPACTION_PCT, rulesPct: RULES_PCT, totalPct: TOTAL_PCT }
  const totals = sessions.reduce((acc, s) => {
    acc.sessions += 1
    acc.steps += s.steps
    acc.compactions += s.compactions
    acc.hit += s.hit
    acc.miss += s.miss
    acc.out += s.out
    acc.cost += s.cost
    acc.duplicates += s.duplicates
    acc.distinctCalls += s.distinctCalls
    return acc
  }, { sessions: 0, steps: 0, compactions: 0, hit: 0, miss: 0, out: 0, cost: 0, duplicates: 0, distinctCalls: 0 })

  const avgStepCost = totals.steps ? totals.cost / totals.steps : 0
  const records = opts.manifest ? readManifest(opts.manifest) : []
  const rework = estimateRework(records, avgStepCost)
  const baselineCost = totals.cost / (1 - TOTAL_PCT / 100)
  const reworkPct = baselineCost ? Number(((rework.costEquiv / baselineCost) * 100).toFixed(2)) : 0
  const continuationCost = rework.continuation * avgStepCost
  const continuationPct = baselineCost ? Number(((continuationCost / baselineCost) * 100).toFixed(2)) : 0
  const netPct = Number((TOTAL_PCT - reworkPct).toFixed(2))

  return {
    available: true,
    cache: file,
    updatedAt: (() => { try { return fs.statSync(file).mtimeMs } catch { return 0 } })(),
    totals,
    sessions,
    rework: { ...rework, avgStepCost, costEquiv: rework.costEquiv, pctOfBaseline: reworkPct, continuationCost, continuationPct },
    netPct,
    compactionPct: COMPACTION_PCT,
    rulesPct: RULES_PCT,
    totalPct: TOTAL_PCT,
  }
}

module.exports = { buildReport, buildBill, aggregate, readManifest, findUsageCache, estimateRework, TOK_PER_CHAR, LEGACY }


