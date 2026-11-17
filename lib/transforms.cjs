// transforms.cjs — 确定性变换 + 形状摘要（全部纯函数，无模型）
// 设计原则：
//   - 任何变换都必须能通过 artifact 完整取回原文
//   - 输出必须带显式说明（模型据此判断完整性）
//   - 形状摘要只压缩"结构"，不重写"内容"

const NOTE_LIMIT = 130 // 省略提示的目标长度（token 约 40）

// ---------- 基础 ----------
const lines = (t) => t.split('\n')

function note(omittedChars, fromLine, toLine, artifactId, hint) {
  return `\n[…省略 ${omittedChars} 字符（第 ${fromLine}-${toLine} 行）· 全文 artifact ${artifactId}${hint ? ' · ' + hint : ''}]\n`
}

// 头 + 尾截断（日志类：错误常在尾部）
function capHeadTail(text, limit, artifactId) {
  if (text.length <= limit) return { text, capped: false }
  const headLen = Math.floor(limit * 0.72)
  const tailLen = limit - headLen
  const head = text.slice(0, headLen)
  const tail = text.slice(-tailLen)
  const omitted = text.length - headLen - tailLen
  const fromLine = head.split('\n').length
  const toLine = text.split('\n').length - tail.split('\n').length + 1
  return {
    text: head + note(omitted, fromLine, toLine, artifactId, 'guard_query(id, fromLine, toLine) 取该区间，或 pattern 检索') + tail,
    capped: true,
  }
}

// ---------- 形状识别 ----------
function stripSpill(text) {
  return text.replace(/\n+\(Omitted [\d,]+ bytes\.[\s\S]*$/i, '').replace(/\n+\(Omitted [\d,]+ bytes[\s\S]*$/i, '')
}

function detectShape(text) {
  const body = stripSpill(text).trim()
  if (body.startsWith('{') || body.startsWith('[')) {
    const parsed = parseLooseJson(body)
    return parsed ? { shape: 'json', parsed: parsed.value, truncated: parsed.truncated } : { shape: 'json-broken', parsed: null }
  }
  const ls = lines(body)
  const levelHits = ls.filter((l) => /\b(?:error|fatal|exception|failed)\b/i.test(l)).length
  if (levelHits > 0 || /\bexit code\b/i.test(text)) return { shape: 'log', parsed: null }
  return { shape: 'text', parsed: null }
}

// 有些工具输出是"准 JSON"：字符串里有未转义的换行/制表符。先规范化再解析。
function normalizeJsonText(s) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    const code = ch.charCodeAt(0)
    if (inStr) {
      if (esc) { out += ch; esc = false; continue }
      if (ch === '\\') { out += ch; esc = true; continue }
      if (ch === '"') { out += ch; inStr = false; continue }
      if (code < 32) {
        if (ch === '\n') out += '\\n'
        else if (ch === '\r') out += '\\r'
        else if (ch === '\t') out += '\\t'
        else out += `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  return out
}

function tryParse(s) {
  try { return JSON.parse(s) } catch { return undefined }
}

// 容错解析：① 规范化控制字符 ② 仍失败则截到最后一个完整逗号处并补齐闭合
function parseLooseJson(body) {
  const fixed = tryParse(normalizeJsonText(body))
  if (fixed !== undefined) return { value: fixed, truncated: false }

  const normalized = normalizeJsonText(body)
  const stack = []
  let inStr = false
  let esc = false
  const cuts = []
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
    else if (ch === ',' && stack.length) cuts.push({ idx: i, stack: [...stack] })
  }
  for (let k = cuts.length - 1; k >= Math.max(0, cuts.length - 60); k -= 1) {
    const { idx, stack: st } = cuts[k]
    const close = st.slice().reverse().map((c) => (c === '{' ? '}' : ']')).join('')
    const v = tryParse(normalized.slice(0, idx) + close)
    if (v !== undefined) return { value: v, truncated: true }
  }
  return null
}

// ---------- JSON 紧凑摘要 ----------
const STR_KEEP = 60
function compactValue(v, depth) {
  if (v === null) return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (v.length <= STR_KEEP) return v
    return `${v.slice(0, STR_KEEP)}…(+${v.length - STR_KEEP})`
  }
  if (Array.isArray(v)) {
    if (depth >= 3) return `<array:${v.length}>`
    const head = v.slice(0, 2).map((x) => compactValue(x, depth + 1))
    return v.length > 2 ? [...head, `<…(+${v.length - 2} more)>`] : head
  }
  if (typeof v === 'object') {
    if (depth >= 4) return `<obj:${Object.keys(v).length}keys>`
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = compactValue(val, depth + 1)
    return out
  }
  return v
}

function summarizeJson(obj, opts = {}) {
  const docLimit = opts.docLimit ?? 0 // 0 = 不带描述（可查询取回）
  const truncated = Boolean(opts.truncated)
  // 针对 cordis 的工具清单：保留 name / 参数键 / 可选描述前缀
  const tools = obj?.data?.tools
  if (Array.isArray(tools)) {
    return {
      platform: obj.platform,
      provider: obj.provider,
      method: obj.method,
      tools_seen: tools.length,
      upstream_truncated: truncated || undefined,
      note: truncated ? '原文被上游截断，这是完整解析到的部分' : undefined,
      tools: tools.map((t) => {
        const item = { name: t?.name, params: Object.keys(t?.parameters?.properties ?? {}) }
        if (docLimit > 0 && typeof t?.description === 'string') item.doc = t.description.slice(0, docLimit)
        return item
      }),
    }
  }
  return compactValue(obj, 0)
}

// ---------- 日志摘要 ----------
function summarizeLog(text, artifactId) {
  const ls = lines(text)
  const total = ls.length
  const errLines = ls.filter((l) => /\b(?:error|fatal|exception|failed|unhandled)\b/i.test(l))
  const warn = ls.filter((l) => /\bwarn(?:ing)?\b/i.test(l)).length
  const exit = ls.filter((l) => /\[exit code:?\s*-?\d+\]/i.test(l)).slice(-2)
  const head = ls.slice(0, 8)
  const tail = ls.slice(-6)
  const parts = []
  parts.push(`[日志摘要 · 共 ${total} 行 · 错误 ${errLines.length} · 警告 ${warn}]`)
  if (exit.length) parts.push('退出码: ' + exit.join(' | '))
  parts.push('--- 开头 8 行 ---', ...head)
  if (errLines.length) {
    parts.push('--- 错误行（前 12 条） ---', ...errLines.slice(0, 12))
    if (errLines.length > 12) parts.push(`[…另有 ${errLines.length - 12} 条错误行]`)
  }
  parts.push('--- 结尾 6 行 ---', ...tail)
  parts.push(note(text.length - parts.join('\n').length > 0 ? Math.max(0, text.length - parts.join('\n').length) : 0, 1, total, artifactId, '可用 read offset/limit，或 guard_query(id, pattern) 取回命中行').trim())
  return parts.join('\n')
}

// ---------- 行级差异 ----------
function lineDiff(aText, bText) {
  const a = lines(aText)
  const b = lines(bText)
  // 大文本退化到集合差（保持线性）
  if (a.length * b.length > 4e6) {
    const setA = new Set(a)
    const setB = new Set(b)
    return { added: b.filter((l) => !setA.has(l)), removed: a.filter((l) => !setB.has(l)) }
  }
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const added = [], removed = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1 }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed.push(a[i]); i += 1 }
    else { added.push(b[j]); j += 1 }
  }
  while (i < n) { removed.push(a[i]); i += 1 }
  while (j < m) { added.push(b[j]); j += 1 }
  return { added, removed }
}

function formatDelta(added, removed, refId) {
  return [`[同比 ${refId}：+${added.length}/-${removed.length} 行 · 未变化部分已省略 · 需要全文用 artifact]`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`)].join('\n')
}

module.exports = { capHeadTail, detectShape, summarizeJson, summarizeLog, lineDiff, formatDelta, stripSpill, note, STR_KEEP }
