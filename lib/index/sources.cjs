// sources.cjs — 索引的两个数据来源：
//   1) 路径：read/write/edit/grep/glob 的 file_path / path 参数（只记路径，不记内容）
//   2) artifact：token-guard 的 manifest.jsonl 尾部 N 行（id/tool/mode/visibleChars）
//
// 安全不变式：
//   - 任何命中脱敏表的路径整条丢弃（大小写不敏感，见 DENY_PATTERNS）；
//   - 绝对路径做展示折叠：工作区外且属于某个用户目录时，只保留尾部两段（`…\Documents\x.md`），
//     自家 home 折叠为 `~`，避免把用户名送进 system prompt（也省 token）；
//   - 不读取文件内容，只读路径字符串与 manifest 的元数据；
//   - 任何异常返回空结果，不向上抛（失败开放）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 脱敏表：命中任一子串的路径整条丢弃。大小写不敏感。
// 'credentials' 覆盖 .credentials / .git-credentials / .aws\credentials / credentials.json。
const DENY_PATTERNS = [
  '.credentials',
  'credentials',
  '.env',
  'local-proxy',
  'secrets',
  'token',
  '.ssh',
  'appdata',
  '.kube',
  'kubeconfig',
  '.npmrc',
  'id_rsa',
  'cookies',
]

// 只跟踪这几种"触碰文件"的工具；其它工具（pwsh/web 等）不贡献路径。
const TRACKED_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'glob'])

// 参数里可能承载路径的键，按优先级排列。
const PATH_KEYS = ['file_path', 'filePath', 'path', 'paths', 'files', 'file']

const MAX_PATH_CHARS = 320

// 某个用户目录（非工作区）绝对路径：只保留尾部两段
const USER_DIR_RE = /[\\/]Users[\\/][^\\/]+[\\/]/i

/** 路径是否命中脱敏规则（大小写不敏感）。 */
function isDeniedPath(raw) {
  if (typeof raw !== 'string') return false
  const lower = raw.toLowerCase()
  return DENY_PATTERNS.some((needle) => lower.includes(needle))
}

/** abs 是否在 root 之内（root 为文件路径或目录）。 */
function isInside(root, abs) {
  try {
    if (!root) return false
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch {
    return false
  }
}

/**
 * 展示用路径：工作区内原样；自家 home 折叠成 `~`；
 * 其它用户目录降级为尾部两段（避免泄露用户名）。
 */
function displayPath(abs, options = {}) {
  const { workspaceRoot = null, homeDir = null } = options
  if (workspaceRoot && isInside(workspaceRoot, abs)) return abs
  if (homeDir && isInside(homeDir, abs)) {
    const rel = path.relative(homeDir, abs)
    return rel ? `~${path.sep}${rel}` : '~'
  }
  if (USER_DIR_RE.test(abs)) {
    const parts = abs.split(/[\\/]+/).filter(Boolean)
    const tail = parts.slice(-2).join('\\')
    return tail ? `…\\${tail}` : ''
  }
  return abs
}

/** 从工具名 + 参数里提取候选路径（未归一化、未脱敏）。 */
function extractPaths(toolName, args) {
  if (!TRACKED_TOOLS.has(String(toolName ?? ''))) return []
  if (!args || typeof args !== 'object') return []
  const out = []
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string') {
      out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') out.push(item)
        else if (item && typeof item === 'object' && typeof item.path === 'string') out.push(item.path)
      }
    }
  }
  return out
}

/**
 * 归一化 + 脱敏 + 展示折叠。返回可展示的路径字符串，或 null（表示丢弃）。
 * cwd 用于把相对路径补全；workspaceRoot 用于判断"工作区内"；homeDir 用于折叠用户名。
 */
function normalizePath(raw, options = {}) {
  const { cwd = process.cwd(), workspaceRoot = null, homeDir = os.homedir(), maxChars = MAX_PATH_CHARS } = options
  try {
    if (typeof raw !== 'string') return null
    let p = raw.trim()
    if (!p) return null
    if (p.length > maxChars) return null
    if (/[\r\n\t]/.test(p)) return null
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null // URL 不是文件路径（也挡住 URL 里的 token）
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1)
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p)
    const inWorkspace = workspaceRoot ? isInside(workspaceRoot, abs) : false
    // 工作区自身的路径前缀（例如工作区恰好位于 AppData\Local\Temp）不算泄露；
    // 但工作区内的相对部分命中敏感词仍整条丢弃。
    if (isDeniedPath(p) || isDeniedPath(abs)) {
      const rel = inWorkspace ? path.relative(path.resolve(workspaceRoot), abs) : null
      if (!inWorkspace || (rel !== null && isDeniedPath(rel))) return null
    }
    const shown = displayPath(abs, { workspaceRoot, homeDir })
    if (!shown) return null
    if (!inWorkspace && isDeniedPath(shown)) return null
    return shown
  } catch {
    return null
  }
}

/**
 * 读 JSONL 文件尾部最多 maxLines 行（不回扫整个大文件）。
 * 返回 { records: [], total, size, mtimeMs }，records 为"最近在前"。
 * 文件不存在 / 读失败 → 空结果，绝不抛。
 */
function readManifestTail(file, maxLines = 500, maxBytes = 256 * 1024) {
  const empty = { records: [], total: 0, size: 0, mtimeMs: 0 }
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size === 0) return { ...empty, size: st.size, mtimeMs: st.mtimeMs }
    const limitLines = Math.max(1, Math.min(2000, Number(maxLines) || 500))
    const bytes = Math.min(st.size, Math.max(4096, maxBytes))
    const start = st.size - bytes
    const fd = fs.openSync(file, 'r')
    let text
    try {
      const buf = Buffer.allocUnsafe(bytes)
      fs.readSync(fd, buf, 0, bytes, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    let lines = text.split(/\r?\n/)
    // 从中间截断时，首行可能是半行：丢掉
    if (start > 0) lines = lines.slice(1)
    lines = lines.filter((line) => line.trim())
    const records = []
    for (let i = lines.length - 1; i >= 0 && records.length < limitLines; i -= 1) {
      try {
        records.push(JSON.parse(lines[i]))
      } catch {
        // 单行坏了不影响其它行
      }
    }
    return { records, total: lines.length, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return empty
  }
}

/** 人类可读体积：4.1K / 11.9K / 812。 */
function formatSize(chars) {
  const n = Number(chars)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return String(Math.round(n))
  return `${(n / 1024).toFixed(1)}K`
}

// token-guard 落盘的溢出文件形如 ...\token-guard\artifacts\<sha16>.txt。
// 它是"原文副本"而不是工具的目标路径，当作目标展示会误导模型。
const SPILL_ARTIFACT_RE = /[\\/]artifacts[\\/][0-9a-f]{6,64}\.txt$/i

/** 从 manifest 记录里推断工具的目标路径；拿不到就返回空串。 */
function inferTarget(record) {
  if (!record || typeof record !== 'object') return ''
  const candidates = [record.target, record.path, record.file_path, record.filePath]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  // artifact 字段：只有它不是 token-guard 自己的溢出副本时才作为目标
  if (typeof record.artifact === 'string' && record.artifact.trim() && !SPILL_ARTIFACT_RE.test(record.artifact)) {
    return record.artifact.trim()
  }
  return ''
}

// 状态语义（D1，2026-11-14 评审）：
//   mode:"unchanged" 表示这次只给了 99 字符的 `[未变 · 与 #N 相同]` 标记，
//   visibleChars 才是模型当时真正看到的大小（实测 12,882 → 99）。
//   绝不能把它渲染成 "12.6K ok"——那会让模型以为原文已在上下文里。
function deriveStatus(record, { visibleChars, originalChars, mode }) {
  if (record?.isError === true || record?.error) return 'err'
  const marker = visibleChars > 0 && originalChars > 0 && visibleChars < originalChars * 0.5
  // 截断/摘要：上下文里看到的是删节版 → trunc
  if (mode === 'capped' || mode === 'summary') return 'trunc'
  // 未变/差异：只有 visible 远小于原文时才说明"模型没见过原文" → need
  if (mode === 'unchanged' || mode === 'delta') {
    if (marker) return 'need'
    return mode === 'delta' ? 'Δ' : 'same'
  }
  // 其它 mode（或没有 mode）：保守处理
  if (marker) return 'need'
  return 'ok'
}

/** manifest 记录 → 索引里的 artifact 行；不是合法记录返回 null。 */
function summarizeArtifact(record) {
  try {
    if (!record || typeof record !== 'object') return null
    const rawId = String(record.id ?? record.artifactId ?? '').trim()
    if (!/^[0-9a-f]{6,64}$/i.test(rawId)) return null
    const tool = typeof record.tool === 'string' && record.tool ? record.tool : '?'
    const originalChars = Number(record.originalChars ?? record.chars ?? 0)
    const hasVisible = record.visibleChars !== undefined && record.visibleChars !== null
    const visibleParsed = hasVisible ? Number(record.visibleChars) : originalChars
    const visibleChars = Number.isFinite(visibleParsed) && visibleParsed >= 0 ? visibleParsed : originalChars
    const target = inferTarget(record)
    if (target && isDeniedPath(target)) return null
    const mode = typeof record.mode === 'string' ? record.mode : ''
    const status = deriveStatus(record, { visibleChars, originalChars, mode })
    const marker = visibleChars > 0 && originalChars > 0 && visibleChars < originalChars * 0.5
    const size = marker
      ? `${formatSize(visibleChars)} / full ${formatSize(originalChars)}`
      : formatSize(visibleChars > 0 ? visibleChars : originalChars)
    return {
      id: rawId.slice(0, 6),
      fullId: rawId.toLowerCase(),
      tool,
      target,
      size,
      status,
      mode,
      dup: 1,
      originalChars: Number.isFinite(originalChars) ? originalChars : 0,
      visibleChars: Number.isFinite(visibleChars) ? visibleChars : 0,
    }
  } catch {
    return null
  }
}

/** 批量转换，并按 id 去重（保留最近一条，重复次数进 dup 列，渲染成 `×N`）。 */
function summarizeArtifacts(records, limit = Infinity) {
  const out = []
  const seen = new Map()
  if (!Array.isArray(records)) return out
  for (const record of records) {
    const item = summarizeArtifact(record)
    if (!item) continue
    const existing = seen.get(item.fullId)
    if (existing) {
      existing.dup += 1
      continue
    }
    if (out.length >= limit) continue
    seen.set(item.fullId, item)
    out.push(item)
  }
  return out
}

module.exports = {
  DENY_PATTERNS,
  TRACKED_TOOLS,
  extractPaths,
  isDeniedPath,
  isInside,
  displayPath,
  normalizePath,
  readManifestTail,
  formatSize,
  inferTarget,
  deriveStatus,
  summarizeArtifact,
  summarizeArtifacts,
}
