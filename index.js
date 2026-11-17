// token-trim — 工具结果进入上下文前的确定性治理：截断 + 结构化摘要 + 重跑差异 + 原文落盘
//
// 设计原则（全部来自实测，见 reports/evidence_block/replay-report-v1.md）：
//   1. 失败开放：任何异常、任何非文本内容，一律 next()，绝不阻断工具。
//   2. 只处理白名单工具；edit/write/todo/子 agent 等一律不动。
//   3. 原文必须落盘，模型可用 read 取回。
//   4. 日志类只截断不摘要（摘要召回归 77.2%，实测否决）。
//   5. 差异只在「差异 < 全量 60%」时使用。
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { mkdirSync, appendFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const T = require('./lib/transforms.cjs')
const { queryArtifact, fullArtifact, resolveId } = require('./lib/query.cjs')

// 数据目录：0.1.0 从早期的 token-guard 目录迁移一次（保留已累积的 manifest 与 artifact）。
const DATA_DIR = path.join(homedir(), '.dsh', 'token-trim')
const LEGACY_DIR = path.join(homedir(), '.dsh', 'token-guard')
function resolveDataDir() {
  try {
    if (!existsSync(DATA_DIR) && existsSync(LEGACY_DIR)) renameSync(LEGACY_DIR, DATA_DIR)
  } catch {}
  if (existsSync(DATA_DIR)) return DATA_DIR
  return existsSync(LEGACY_DIR) ? LEGACY_DIR : DATA_DIR
}
const BASE = resolveDataDir()

const DEFAULTS = {
  enabled: true,
  dryRun: false,
  minChars: 1200,
  // 未显式列出的工具（MCP、adb、flowscope…）用这个默认上限兜底。之前是"未知工具一律不截"，
  // 2026-11-17 实测：7 天 8,551 条工具结果里，未覆盖的 MCP 工具占了 0.6M 字符且一条没截。
  capsDefault: 6000,
  caps: {
    pwsh: 2500,
    cordis_inspect_query: 8000,
    cordis_inspect_list: 8000,
    plugin_manager: 6000,
    job_output: 4000,
    grep: 6000,
    skill: 8000,
    'mcp__local-proxy__proxy_run': 4000,
    cua_driver_native__get_window_state: 8000,
    cua_driver_native__list_windows: 8000,
    // 内容类工具：显式不截（2026-10-29 实测回退）。
    // 试过 8K：两轮真实会话里 2 条被截的 read 全部触发重读（agent 用 offset/limit 补尾部），
    //   省 2.3K token 却多花 2 步（约 5 万 token）→ 净亏。
    // 原因：read 的"内容"就是 agent 要的产物；截断等于让它返工。逻辑上更接近"去冗余"的工具才值得截。
    read: 0,
    web_fetch: 0,
    // 改写/落盘类：结果就是 agent 的校验依据，别截。
    edit: 0,
    write: 0,
    // 取原文的工具：它本身就是"要完整内容"的出口，截断会让 guard_query 失去意义。
    guard_query: 0,
  },
  summaryTools: [
    'cordis_inspect_query',
    'cordis_inspect_list',
    'plugin_manager',
    'list_agents',
    'grep',
    'skill',
    'cua_driver_native__get_window_state',
    'cua_driver_native__list_windows',
  ],
  deltaTools: [
    'cordis_inspect_query',
    'cordis_inspect_list',
    'plugin_manager',
    'job_output',
    'grep',
    'skill',
    'pwsh',
    'read',
    'list_agents',
    'cua_driver_native__get_window_state',
    'cua_driver_native__list_windows',
  ],
  deltaWindow: 200,
  // 每个 artifact 允许的"分次取回"次数；超过就直接给全文。
  // 依据：一次取回 = 一步 = 约 44 万 token 的上下文重发，取回 3 次以上净值转负。
  maxFetches: 2,
  fullReturnChars: 12000,
  artifactDir: path.join(BASE, 'artifacts'),
  manifest: path.join(BASE, 'manifest.jsonl'),
}

function contentText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

// 只接受"整条结果就是一个文本块"，其它形态（图片/多块/结构化值）一律不动
function isSingleText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : null
  if (!blocks) return typeof result?.value === 'string'
  return blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string'
}

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

// manifest 里记一个"这是什么"，供上下文索引（dsh-context-index）展示。
// 没有它，索引里只有一串 artifact id，模型看不出那是哪个文件/哪条命令。
function targetOf(exec) {
  try {
    const args = typeof exec?.arguments === 'string' ? JSON.parse(exec.arguments) : exec?.arguments
    if (!args || typeof args !== 'object') return undefined
    const fileish = args.file_path ?? args.filePath ?? args.path
    if (typeof fileish === 'string' && fileish.trim()) return fileish.trim().slice(0, 160)
    const cmdish = args.command ?? args.cmd
    if (typeof cmdish === 'string' && cmdish.trim()) return cmdish.trim().replace(/\s+/g, ' ').slice(0, 80)
    const pattern = args.pattern
    if (typeof pattern === 'string' && pattern.trim()) return pattern.trim().slice(0, 80)
    return undefined
  } catch {
    return undefined
  }
}

export const name = 'dsh-token-trim'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    caps: { ...DEFAULTS.caps, ...(config.caps ?? {}) },
    summaryTools: new Set(config.summaryTools ?? DEFAULTS.summaryTools),
    deltaTools: new Set(config.deltaTools ?? DEFAULTS.deltaTools),
  }
  const state = new Map()
  const order = []
  const fetchCounts = new Map()
  let writes = Promise.resolve()

  // 运行时目录：dryRun 也要建，否则 appendFile 会 ENOENT 被静默吞掉（曾经踩过）
  let dirsReady = null
  const ensureDirs = async () => {
    if (!dirsReady) {
      dirsReady = (async () => {
        await mkdir(path.dirname(cfg.manifest), { recursive: true })
        await mkdir(cfg.artifactDir, { recursive: true })
      })().catch((e) => { dirsReady = null; throw e })
    }
    return dirsReady
  }

  const record = async (entry) => {
    writes = writes
      .then(async () => {
        await ensureDirs()
        await appendFile(cfg.manifest, JSON.stringify(entry) + '\n', 'utf8')
      })
      .catch(() => {})
    await writes
  }

  const remember = (key, value) => {
    if (state.has(key)) state.delete(key)
    state.set(key, value)
    order.push(key)
    while (order.length > cfg.deltaWindow) {
      const old = order.shift()
      if (old !== key) state.delete(old)
    }
  }

  // 查询式取回：让"摘要/截断"里的指针真的可用
  ctx.tools.register({
    name: 'guard_query',
    description:
      'Read inside a token-trim artifact (the full original tool output that was summarized or truncated). ' +
      'Artifact ids appear in tool results as "artifact <id>". Two modes: ' +
      '(a) pattern search — matching lines with line numbers and context; ' +
      '(b) line range — pass fromLine/toLine (1-based, inclusive) to read an exact slice without a keyword. ' +
      'Use the range mode to continue a truncated read instead of re-reading the whole file.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id (hex) shown in the tool result, or "last" for the most recent.' },
        pattern: { type: 'string', description: 'Substring to search for, or /regex/ between slashes. Required unless fromLine/toLine is given.' },
        fromLine: { type: 'number', description: 'First line to return (1-based, inclusive). Enables range mode.' },
        toLine: { type: 'number', description: 'Last line to return (1-based, inclusive; defaults to fromLine).' },
        context: { type: 'number', description: 'Lines of context around each match (default 2, max 10).' },
        max: { type: 'number', description: 'Max matched lines to return (default 30).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const resolved = resolveId(cfg.artifactDir, args?.id)
      if (!resolved) {
        return queryArtifact({ dir: cfg.artifactDir, id: args?.id, pattern: args?.pattern })
      }
      const attempt = (fetchCounts.get(resolved) ?? 0) + 1
      fetchCounts.set(resolved, attempt)
      if (attempt > cfg.maxFetches) {
        return fullArtifact({
          dir: cfg.artifactDir,
          id: resolved,
          maxChars: cfg.fullReturnChars,
          reason: `已取回 ${cfg.maxFetches} 次`,
        })
      }
      return queryArtifact({
        dir: cfg.artifactDir,
        id: resolved,
        pattern: args?.pattern,
        fromLine: args?.fromLine,
        toLine: args?.toLine,
        context: args?.context,
        max: args?.max,
        attempt,
        limit: cfg.maxFetches,
      })
    },
  })

  // Settings「工具节省」视图的数据面。只在宿主提供 plugin 装载时注册；
  // 动态 import 让 RPC 依赖缺失时不影响压缩主路径（失败开放）。
  // 成功/失败都写一行 init.log：宿主日志里看不到被 catch 掉的注册错误。
  const logInit = (message) => {
    try {
      const dir = path.dirname(cfg.manifest)
      mkdirSync(dir, { recursive: true })
      appendFileSync(path.join(dir, 'init.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {}
  }
  if (typeof ctx.plugin === 'function') {
    import('./lib/remote.mjs')
      .then((module) => {
        const RemoteService = module.TokenTrimRemoteService ?? module.TokenGuardRemoteService
        ctx.plugin(RemoteService, {
          manifest: cfg.manifest,
          artifactDir: cfg.artifactDir,
          dryRun: cfg.dryRun,
          caps: cfg.caps,
        })
        logInit('remote service registered (tokenTrim)')
      })
      .catch((error) => logInit('remote service FAILED: ' + (error && (error.stack || error.message || String(error)))))
  } else {
    logInit('ctx.plugin unavailable; Settings view disabled')
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (!cfg.enabled) return next()
      const toolName = exec?.name ?? exec?.tool?.name
      if (!toolName) return next()
      const capLimit = cfg.caps[toolName] ?? cfg.capsDefault
      const handlesCap = capLimit != null && capLimit > 0 // 0 = 显式不截
      const handlesSummary = cfg.summaryTools.has(toolName)
      const handlesDelta = cfg.deltaTools.has(toolName)
      if (!handlesCap && !handlesSummary && !handlesDelta) return next()
      if (!isSingleText(result)) return next()

      const original = contentText(result)
      if (!original || original.length < cfg.minChars) return next()

      const argsKey = String(typeof exec?.arguments === 'string' ? exec.arguments : JSON.stringify(exec?.arguments ?? ''))
      // 返工统计需要区分「同一参数重跑」和「改了参数继续读」：把参数指纹与形状写进 manifest。
      // 旧记录没有这两个字段，report.cjs 会退回旧口径并标记 legacy。
      const argsHash = sha16(argsKey)
      const argShape = (() => {
        try {
          const parsed = typeof exec?.arguments === 'string' ? JSON.parse(exec.arguments) : exec?.arguments
          if (!parsed || typeof parsed !== 'object') return 'none'
          const ranged = ['offset', 'limit', 'fromLine', 'toLine', 'startLine', 'endLine'].filter((k) => parsed[k] != null)
          return ranged.length ? ranged.join('+') : 'plain'
        } catch {
          return 'unparsed'
        }
      })()
      // 关键：delta/未变状态必须按 agent 隔离。
      // 2026-11-14 实测 bug：这个 Map 曾经是全局的，于是子 agent 会对一个它从没读过的文件
      // 收到「[未变 · 与 #N 相同]」，而 #N 的原文只存在于父 agent 的上下文里 → 静默丢信息。
      const agentKey = String(exec?.agent?.id ?? exec?.agentId ?? exec?.sessionId ?? 'shared')
      const key = `${agentKey}\u0000${toolName}\u0000${argsKey}`
      const prev = state.get(key)
      const id = sha16(original)

      // 1) 基础形态：结构化摘要优先，其次截断
      let base = original
      let kind = 'base'
      if (handlesSummary) {
        const shape = T.detectShape(original)
        if (shape.shape === 'json' && shape.parsed) {
          const s = T.summarizeJson(shape.parsed, { truncated: shape.truncated })
          const text = `[结构摘要 · 原文 ${original.length} 字符 / ${original.split('\n').length} 行 · 全文 artifact ${id} · 用 guard_query(id, pattern) 取回细节（最多 ${cfg.maxFetches} 次，超过给全文）${shape.truncated ? ' · 原文已被上游截断' : ''}]\n${JSON.stringify(s, null, 1)}`
          if (text.length < base.length) { base = text; kind = 'summary' }
        }
      }
      if (kind === 'base' && handlesCap) {
        const cap = T.capHeadTail(original, capLimit, id)
        if (cap.capped) { base = cap.text; kind = 'capped' }
      }

      // 2) 差异 / 未变
      let visible = base
      let mode = kind
      if (prev) {
        if (prev.text === base) {
          visible = `[未变 · 与 ${prev.ref} 相同 · sha=${id} · 全文 artifact ${id}]`
          mode = 'unchanged'
        } else if (handlesDelta) {
          const { added, removed } = T.lineDiff(prev.text, base)
          const delta = T.formatDelta(added, removed, prev.ref)
          if (delta.length < base.length * 0.6) { visible = delta; mode = 'delta' }
        }
      }

      if (visible === original) {
        remember(key, { text: base, ref: `#${exec?.callId ?? id}` })
        return next()
      }

      if (cfg.dryRun) {
        await record({ ts: Date.now(), session: agentKey, tool: toolName, id, mode, originalChars: original.length, visibleChars: visible.length, dryRun: true, target: targetOf(exec), argsHash, argShape })
        remember(key, { text: base, ref: `#${exec?.callId ?? id}` })
        return next()
      }

      // 3) 原文先落盘，再替换
      const file = path.join(cfg.artifactDir, `${id}.txt`)
      await mkdir(cfg.artifactDir, { recursive: true })
      await writeFile(file, original, 'utf8')

      remember(key, { text: base, ref: `#${exec?.callId ?? id}` })
      await record({ ts: Date.now(), session: agentKey, tool: toolName, id, mode, originalChars: original.length, visibleChars: visible.length, artifact: file, target: targetOf(exec), argsHash, argShape })

      return { kind: 'accept', content: [{ type: 'text', text: visible }] }
    } catch {
      return next()
    }
  })
}
