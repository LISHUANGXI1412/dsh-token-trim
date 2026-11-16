// events.cjs — 索引重建的触发条件（事件驱动，不做步数节流）
//
// 依据（sp-index-api，2026-11-14）：deepseek-flash 的 systemPromptUpdate 是 "in-history"，
// 即 system prompt 每变一次就 append 一条新的 system 消息，之后每个请求都要重发。
// 所以索引**只能在事件点重建**：会话开始、每次 compaction/summary 之后、手动调用。
//
// 真实会话日志（~/.dsh/sessions/**/session.v4.jsonl.zstd）里的压缩事件类型：
//   compaction/start  → { compactionId, turn }
//   compaction/summary→ { compactionId, summary: [{type:'text', text:'## Primary Request …'}] }
//   compaction/end    → { compactionId, turn }
//   compaction/prune  → 历史裁剪（不是压缩总结，不触发重建）

const COMPACTION_TYPES = new Set(['compaction/start', 'compaction/summary', 'compaction/end'])

// 压缩总结模板的标题（来自真实 compaction/summary 内容）
const SUMMARY_MARKERS = [/##\s*Primary Request and Intent/i, /##\s*Key Technical Concepts/i, /##\s*Pending Tasks/i, /##\s*Optional Next Step/i]

function eventType(event) {
  try {
    const t = event?.type ?? event?.name ?? event?.kind
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

/** 是否是压缩相关事件（不改变任何状态，纯判定）。 */
function isCompactionEvent(event) {
  const type = eventType(event)
  if (!type) return false
  // 只认 start/summary/end。compaction/prune 是历史裁剪（一次会话几十次），
  // 拿它触发重建会退化成"频繁重建"，必须排除。
  if (COMPACTION_TYPES.has(type)) return true
  // 兼容别的命名（例如 compaction/complete），但排除 prune/error 这类非触发事件
  if (/compaction\//i.test(type) && !/prune|error/i.test(type)) return true
  return false
}

/** 同一次压缩的稳定 key，用来去重（start/summary/end 属于同一次）。 */
function compactionKey(event) {
  try {
    const id = event?.data?.compactionId ?? event?.compactionId
    if (typeof id === 'string' && id) return id
    const seq = event?.seq ?? event?.time
    if (seq !== undefined && seq !== null) return `seq:${seq}`
    return ''
  } catch {
    return ''
  }
}

/** 32 位字符串哈希（用于给"压缩总结文本"去重）。 */
function hashText(text) {
  let hash = 2166136261
  const s = String(text ?? '')
  for (let i = 0; i < s.length && i < 4096; i += 1) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/**
 * 退化路径：拿不到 session 事件时，从 agent/pre-step 进入本步的消息里识别
 * "压缩总结"（DSH 的总结模板标题）。识别成功返回稳定 key，否则 null。
 */
function detectSummaryText(messages) {
  try {
    if (!Array.isArray(messages)) return null
    for (const message of messages) {
      const blocks = message?.content
      const text = typeof blocks === 'string' ? blocks : Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
      if (!text || text.length < 200) continue
      if (SUMMARY_MARKERS.some((re) => re.test(text))) return hashText(text)
    }
    return null
  } catch {
    return null
  }
}

module.exports = {
  COMPACTION_TYPES,
  SUMMARY_MARKERS,
  eventType,
  isCompactionEvent,
  compactionKey,
  hashText,
  detectSummaryText,
}
