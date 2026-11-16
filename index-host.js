// context-index — 压缩安全的上下文索引（Host 插件，零依赖）
//
// 目标：压缩（compaction）把历史换成摘要后，模型仍能"看见"指针——
//   最近的 artifact（token-guard 落盘的全文）和最近触碰过的路径。
//
// 更新节奏（2026-11-14 修正，依据 sp-index-api）：
//   deepseek-flash 的 systemPromptUpdate 是 "in-history"：system prompt 每变一次就
//   append 一条新的 system 消息进历史，之后每个请求都要重发。因此**不做步数节流，
//   也不每步重建**，只在事件点重建：
//     - 会话开始（session/created、agent/created）→ reason 'start'
//     - 每次压缩总结之后（session/event 里的 compaction/summary）→ reason 'compaction'
//     - 显式入口 ctx.contextIndex.rebuild('manual')
//   text() 返回"当前状态字符串"；重建后字符串没变就丢掉（同值 → 投影零事件）。
//   渲染头不带 step（A2）——step 每步都变，会让"同值"保护失效；step 只进审计。
//
// 其余原则：
//   1. 失败开放：任何异常都返回上一次的索引或空串，绝不阻断 agent / 工具。
//   2. 硬上限：≤1,000 token（字符口径估算，见 lib/tokens.cjs），超了先裁最不常用的路径。
//   3. 只记路径不记内容；命中脱敏规则的路径整条丢弃；非工作区的用户目录只留尾部两段。
//   4. 审计：每次真正改变内容的重建写一行 ~/.dsh/token-trim/index-manifest.jsonl。
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const S = require('./lib/index/sources.cjs')
const R = require('./lib/index/render.cjs')
const E = require('./lib/index/events.cjs')

const DEFAULTS = {
  enabled: true,
  // 'section' = 注册一个 system prompt section；'none' = 只记账不注入，用来观察成本。
  injectMode: 'section',
  sectionName: 'index:index-page',
  // 必须 > DEPLOYMENT_PERSONA_SUFFIX(10200)，才是最后一个 section（A1：上界不能夹掉它）
  sectionOrder: 10500,
  maxTokens: 1000,
  pathLimit: 40,
  artifactLimit: 20,
  targetChars: 48,
  manifestLines: 500,
  maxTrackedPaths: 300,
  trimManifest: path.join(homedir(), '.dsh', 'token-trim', 'manifest.jsonl'),
  auditManifest: path.join(homedir(), '.dsh', 'token-trim', 'index-manifest.jsonl'),
}

function pickInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function normalizeConfig(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const cwd = typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : process.cwd()
  return {
    enabled: cfg.enabled !== false,
    injectMode: cfg.injectMode === 'none' ? 'none' : 'section',
    sectionName: typeof cfg.sectionName === 'string' && cfg.sectionName ? cfg.sectionName : DEFAULTS.sectionName,
    sectionOrder: pickInt(cfg.sectionOrder, DEFAULTS.sectionOrder, -10000, 20000),
    maxTokens: pickInt(cfg.maxTokens, DEFAULTS.maxTokens, 120, 100000),
    pathLimit: pickInt(cfg.pathLimit, DEFAULTS.pathLimit, 1, 200),
    artifactLimit: pickInt(cfg.artifactLimit, DEFAULTS.artifactLimit, 1, 100),
    targetChars: pickInt(cfg.targetChars, DEFAULTS.targetChars, 12, 120),
    manifestLines: pickInt(cfg.manifestLines, DEFAULTS.manifestLines, 1, 2000),
    maxTrackedPaths: pickInt(cfg.maxTrackedPaths, DEFAULTS.maxTrackedPaths, 40, 2000),
    trimManifest: path.resolve(String(cfg.trimManifest ?? cfg.tokenGuardManifest ?? DEFAULTS.trimManifest)),
    auditManifest: path.resolve(String(cfg.auditManifest ?? DEFAULTS.auditManifest)),
    cwd,
    // 工作区根：工作区内的路径原样显示；工作区外 + 用户目录降级（B2）
    workspaceRoot: typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot ? cfg.workspaceRoot : cwd,
  }
}

// 可选依赖：拿不到 systemPrompt 服务时退化为"只记账"
function resolveSystemPrompt(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get('systemPrompt')
      if (viaGet) return viaGet
    }
  } catch {}
  try {
    return ctx?.systemPrompt ?? null
  } catch {
    return null
  }
}

export const name = 'dsh-token-trim-index'
// systemPrompt 是可选依赖：主路径用全局 section；服务不在本层时退化到 agent.ctx（见 installInjection）
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) return

  // 路径：最近使用在前（索引即输出顺序）
  const paths = []
  const pathKeys = new Map()
  const sections = new Map()

  const state = {
    text: '', // 当前对外文本；只在重建后改变，且"同值不更新"
    step: 0,
    compactions: 0,
    reason: '',
    rebuiltAt: 0,
    // 实际走了哪条注入路径：'global' | 'agent' | 'none'（写进审计，便于诊断）
    injection: 'none',
  }
  const stats = { rebuilds: 0, unchanged: 0, audits: 0, recordedPaths: 0 }
  const seenCompactions = new Set()
  const startedCompactions = new Set()
  const seenSummaries = new Set()
  let sawSessionEvent = false
  let artifactCache = { key: null, value: [] }
  let auditChain = Promise.resolve()

  const on = (event, handler) => {
    try {
      if (typeof ctx?.on === 'function') ctx.on(event, handler)
    } catch {}
  }

  // ---- 数据来源 1：路径（只更新内存，不重建文本） -------------------------

  const touchPath = (raw) => {
    try {
      const abs = S.normalizePath(raw, { cwd: cfg.cwd, workspaceRoot: cfg.workspaceRoot })
      if (!abs) return
      const key = abs.toLowerCase()
      const existing = pathKeys.get(key)
      if (existing === 0) return // 已在最前
      if (existing !== undefined) paths.splice(existing, 1)
      paths.unshift(abs)
      if (paths.length > cfg.maxTrackedPaths) paths.length = cfg.maxTrackedPaths
      pathKeys.clear()
      for (let i = 0; i < paths.length; i += 1) pathKeys.set(paths[i].toLowerCase(), i)
      stats.recordedPaths += 1
    } catch {}
  }

  const recordPaths = (values) => {
    try {
      if (!Array.isArray(values)) return
      for (const value of values) touchPath(value)
    } catch {}
  }

  // ---- 数据来源 2：token-guard artifact -----------------------------------

  const readArtifacts = () => {
    try {
      const read = S.readManifestTail(cfg.trimManifest, cfg.manifestLines)
      const key = `${read.size}:${read.mtimeMs}`
      if (key === artifactCache.key) return artifactCache.value
      // 不在这里截断：让 render 知道总条数，才能写出 "(+N more)"
      const value = S.summarizeArtifacts(read.records)
      artifactCache = { key, value }
      return value
    } catch {
      return []
    }
  }

  // ---- 审计 ---------------------------------------------------------------

  const scheduleAudit = (entry) => {
    stats.audits += 1
    auditChain = auditChain
      .then(async () => {
        await mkdir(path.dirname(cfg.auditManifest), { recursive: true })
        await appendFile(cfg.auditManifest, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, 'utf8')
      })
      .catch(() => {})
  }

  // ---- 重建（唯一入口；事件点调用） ---------------------------------------

  const rebuild = (reason = 'manual') => {
    try {
      const artifacts = readArtifacts()
      const built = R.buildIndex({ paths: paths.slice(), artifacts, step: state.step, compactions: state.compactions, limits: cfg })
      const text = built.text || ''
      stats.rebuilds += 1
      // 关键：字符串没变就丢掉（同值 → 不产生新的 system 消息）
      if (text === state.text) {
        stats.unchanged += 1
        return state.text
      }
      state.text = text
      state.reason = reason
      state.rebuiltAt = Date.now()
      scheduleAudit({
        reason,
        step: state.step,
        chars: built.chars,
        estTokens: built.estTokens,
        paths: built.pathLines,
        artifacts: built.artifactLines,
        injection: state.injection,
      })
      return state.text
    } catch {
      return state.text // 失败开放：保持上一次
    }
  }

  // ---- 注入（封装在一处，便于替换注入方式） -------------------------------

  const installInjection = () => {
    if (cfg.injectMode === 'none') {
      state.injection = 'none'
      return
    }
    const section = {
      name: cfg.sectionName,
      order: cfg.sectionOrder,
      interpolate: false,
      text: () => state.text,
    }
    const systemPrompt = resolveSystemPrompt(ctx)
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        sections.set('global', systemPrompt.section(section))
        state.injection = 'global'
        return
      } catch {
        // 注册失败（例如重名）→ 落到 per-agent 路径，并在审计里可见
      }
    }
    state.injection = 'agent'
    // 退化：服务不在本层时，挂到每个 agent 的 scope 上（dsh-memory-local 的写法）
    on('agent/created', (payload) => {
      try {
        const agent = payload?.agent
        if (!agent?.id) return
        const scoped = agent.ctx?.systemPrompt ?? agent.ctx?.get?.('systemPrompt')
        if (!scoped || typeof scoped.section !== 'function') {
          state.injection = 'none'
          return
        }
        sections.set(agent.id, scoped.section(section))
      } catch {
        state.injection = 'none'
      }
    })
    on('agent/disposed', (payload) => {
      try {
        sections.get(payload?.agent?.id)?.()
        sections.delete(payload?.agent?.id)
      } catch {}
    })
  }

  // ---- 压缩事件 → 计数 + 重建 --------------------------------------------

  const noteCompaction = (event) => {
    try {
      const type = E.eventType(event)
      const key = E.compactionKey(event) || `type:${type}`
      if (type === 'compaction/start') {
        startedCompactions.add(key)
        return
      }
      if (type === 'compaction/end') {
        // 正常路径在 summary 就计过数；只有"有 start 没有 summary"时才补记
        if (seenCompactions.has(key) || !startedCompactions.has(key)) return
      }
      if (seenCompactions.has(key)) return
      seenCompactions.add(key)
      state.compactions += 1
      rebuild('compaction')
      // 去重集合不无限增长
      if (seenCompactions.size > 500) seenCompactions.delete(seenCompactions.values().next().value)
      if (startedCompactions.size > 500) startedCompactions.delete(startedCompactions.values().next().value)
    } catch {}
  }

  // ---- 事件接线 -----------------------------------------------------------

  // 会话开始：首次装配时就有索引（内容为空时 rebuild 是 no-op，不写审计）
  on('session/created', () => {
    try {
      rebuild('start')
    } catch {}
  })
  // 子 agent 也会触发 agent/created：只在“还没有任何索引”时做首次构建，
  // 避免子 agent 每次创建都白跑一次重建（字符串不变虽不产生事件，但没必要）。
  on('agent/created', () => {
    try {
      if (!state.text) rebuild('start')
    } catch {}
  })

  // 路径记录 + 步数跟踪：只更新内存，绝不重建文本
  on('tools/post-execute', async (exec, result, next) => {
    try {
      const toolName = exec?.name ?? exec?.tool?.name
      const found = S.extractPaths(toolName, exec?.arguments)
      if (found.length) recordPaths(found)
    } catch {}
    return next()
  })

  on('agent/pre-step', (payload, next) => {
    try {
      const step = Number(payload?.step)
      if (Number.isFinite(step)) state.step = Math.max(state.step, step)
      // 退化路径：拿不到 session/event 时，从进入本步的消息里识别压缩总结
      if (!sawSessionEvent) {
        const key = E.detectSummaryText(payload?.messages)
        if (key && !seenSummaries.has(key)) {
          seenSummaries.add(key)
          state.compactions += 1
          rebuild('compaction')
        }
      }
    } catch {}
    return next()
  })

  // 主路径：session/event 的压缩事件（真实日志里是 compaction/start|summary|end）
  // 兼容一参/两参签名（C3）：真实签名可能是 (event) 或 (session, event)。
  on('session/event', (a, b) => {
    try {
      const event = b ?? a
      sawSessionEvent = true
      if (E.isCompactionEvent(event)) noteCompaction(event)
    } catch {}
  })
  // 若某个版本直接以命名事件广播压缩总结，也接住
  on('compaction/summary', (payload) => {
    try {
      noteCompaction(payload?.event ?? payload)
    } catch {}
  })

  installInjection()

  // 插件卸载/作用域销毁时释放所有 section（全局注册与 agent 作用域注册都覆盖）
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        for (const dispose of sections.values()) {
          try {
            dispose?.()
          } catch {}
        }
        sections.clear()
      })
    }
  } catch {}

  // ---- 显式入口（手动重建 / 诊断） ---------------------------------------

  const api = {
    rebuild: (reason = 'manual') => rebuild(reason),
    get text() {
      return state.text
    },
    get stats() {
      return {
        ...stats,
        paths: paths.length,
        compactions: state.compactions,
        reason: state.reason,
        builtAt: state.rebuiltAt,
        injection: state.injection,
      }
    },
  }
  try {
    ctx.contextIndex = api
  } catch {
    try {
      Object.defineProperty(ctx, 'contextIndex', { configurable: true, value: api })
    } catch {}
  }
}

// 供测试直接引用（测试用假的 ctx 驱动 apply）
export const __test = { normalizeConfig, DEFAULTS }
