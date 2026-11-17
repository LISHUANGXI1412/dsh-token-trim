// query.cjs — 在 artifact 内做"查询式取回"，返回命中行 + 上下文
// 这是"摘要/截断"能成立的前提：模型必须能一次命中地取回细节。
const fs = require('node:fs')
const path = require('node:path')

const ID_RE = /^[0-9a-f]{6,64}$/

function listArtifacts(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))
  } catch {
    return []
  }
}

// 区分"没有 artifact"和"id 非法"——两者的提示完全不同
function noArtifactsMessage(dir) {
  const recent = listArtifacts(dir)
  if (recent.length) return null
  return '[guard_query] 目前没有任何 artifact：要么插件在 dryRun 模式（只记账、不落盘），要么还没有任何被摘要/截断的结果。启用后会按需生成。'
}

function resolveId(dir, id) {
  if (id === 'last' || id === 'latest') {
    const files = listArtifacts(dir)
    if (!files.length) return null
    const newest = files
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]
    return newest.f.replace(/\.txt$/, '')
  }
  return ID_RE.test(String(id)) ? String(id) : null
}

function buildMatcher(pattern) {
  const src = String(pattern ?? '')
  if (!src) return null
  if (src.length > 2 && src.startsWith('/') && src.endsWith('/')) {
    try {
      const re = new RegExp(src.slice(1, -1), 'i')
      return { test: (line) => re.test(line), label: src }
    } catch {
      // 非法正则退化为子串
    }
  }
  const needle = src.toLowerCase()
  return { test: (line) => line.toLowerCase().includes(needle), label: src }
}

// 返回可直接给模型看的文本
// 两种模式：pattern 检索（默认）与按行区间取回（fromLine/toLine，1 起、含两端）。
// 区间模式是为"截断 read"准备的安全通道：补读只要 200 行，不必整文件重读。
const RANGE_MAX_LINES = 400
const RANGE_MAX_CHARS = 2400

function clampLine(value, total) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.max(1, Math.min(total, n))
}

function readLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  return lines
}

function rangeArtifact(opts, resolved, lines) {
  const { fromLine, toLine, attempt, limit } = opts
  const total = lines.length
  const from = clampLine(fromLine, total)
  const to = clampLine(toLine ?? fromLine, total)
  if (from == null || to == null) return '[guard_query] fromLine/toLine 需要是数字'
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const wanted = end - start + 1
  const shownEnd = Math.min(end, start + RANGE_MAX_LINES - 1)
  const attemptTag = attempt ? ` · 第 ${attempt}/${limit ?? 2} 次取回` : ''
  const out = [`[guard_query · artifact ${resolved} · 共 ${total} 行 · 第 ${start}-${shownEnd} 行${shownEnd < end ? `（区间已截到 ${RANGE_MAX_LINES} 行）` : ''}${attemptTag}]`]
  let size = out[0].length
  for (let i = start - 1; i < shownEnd; i += 1) {
    const line = `${i + 1}: ${lines[i]}`
    if (size + line.length > RANGE_MAX_CHARS) {
      out.push(`[…字符上限 ${RANGE_MAX_CHARS}，请缩小行区间或用 pattern 检索]`)
      break
    }
    out.push(line)
    size += line.length + 1
  }
  if (shownEnd >= end) out.push(`[区间结束 · 共 ${wanted} 行]`)
  return out.join('\n')
}

function queryArtifact(opts) {
  const { dir, id, pattern, context = 2, max = 30, maxChars = 2400 } = opts
  // 先判 id 语法，再判"有没有 artifact"——否则非法 id 会被误报成"没有 artifact"
  const isLast = id === 'last' || id === 'latest'
  if (!isLast && !ID_RE.test(String(id))) {
    return `[guard_query] 无效的 artifact id：${String(id).slice(0, 40)}（应为十六进制 id，或 "last"）`
  }
  const resolved = resolveId(dir, id)
  if (!resolved) {
    return noArtifactsMessage(dir) ?? `[guard_query] 找不到任何 artifact ${String(id).slice(0, 40)}`
  }
  const file = path.join(dir, `${resolved}.txt`)
  if (!fs.existsSync(file)) {
    const recent = listArtifacts(dir).slice(0, 5).map((f) => f.replace(/\.txt$/, ''))
    return `[guard_query] 找不到 artifact ${resolved}。最近的 id: ${recent.join(', ') || '(无)'}`
  }
  const lines = readLines(file)
  const wantsRange = opts.fromLine != null || opts.toLine != null
  if (wantsRange) return rangeArtifact(opts, resolved, lines)

  const matcher = buildMatcher(pattern)
  if (!matcher) return '[guard_query] pattern 不能为空（或改用 fromLine/toLine 按行区间取回）'

  const hits = []
  for (let i = 0; i < lines.length && hits.length < max; i += 1) {
    if (matcher.test(lines[i])) hits.push(i)
  }
  if (!hits.length) return `[guard_query] artifact ${resolved}（共 ${lines.length} 行）中未命中：${matcher.label}`

  const ctx = Math.max(0, Math.min(10, Number(context) || 0))
  const shown = new Set()
  for (const i of hits) {
    for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k += 1) shown.add(k)
  }
  const ordered = [...shown].sort((a, b) => a - b)

  const attemptTag = opts.attempt ? ` · 第 ${opts.attempt}/${opts.limit ?? 2} 次取回` : ''
  const out = [`[guard_query · artifact ${resolved} · 共 ${lines.length} 行 · 命中 ${hits.length} 处${hits.length === max ? '（已达上限）' : ''}${attemptTag}]`]
  let prev = -2
  let size = out[0].length
  for (const i of ordered) {
    if (i > prev + 1) out.push('…')
    const line = `${i + 1}: ${lines[i]}`
    if (size + line.length > maxChars) { out.push('[…结果已截断，请收窄 pattern]'); break }
    out.push(line)
    size += line.length + 1
    prev = i
  }
  return out.join('\n')
}

// 超过取回上限后：直接给全文（受 maxChars 保护），让模型不必再猜
function fullArtifact(opts) {
  const { dir, id, maxChars = 12000, reason } = opts
  const resolved = resolveId(dir, id)
  if (!resolved) {
    const noArt = noArtifactsMessage(dir)
    if (noArt) return noArt
    return `[guard_query] 无效的 artifact id：${String(id).slice(0, 40)}`
  }
  const file = path.join(dir, `${resolved}.txt`)
  if (!fs.existsSync(file)) return `[guard_query] 找不到 artifact ${resolved}`
  const text = fs.readFileSync(file, 'utf8')
  const head = `[guard_query · 已达取回上限（${reason ?? '上限 2 次'}）· 返回全文 · artifact ${resolved} · ${text.length} 字符 · 共 ${text.split('\n').length} 行]`
  if (text.length <= maxChars) return `${head}\n${text}`
  const tail = text.slice(-Math.floor(maxChars * 0.25))
  const body = text.slice(0, maxChars - tail.length)
  return `${head}\n${body}\n[…中间已省略 · 仍可用 read offset/limit 取]\n${tail}`
}

module.exports = { queryArtifact, fullArtifact, resolveId, listArtifacts }
