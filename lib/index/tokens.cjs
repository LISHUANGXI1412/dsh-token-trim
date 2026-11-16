// tokens.cjs — 字符数近似 token 估算（确定性、零依赖，不引入 tokenizer）
//
// 口径（与设计草案 §3 一致）：
//   中文/全角字符：1 字 ≈ 1 token
//   ASCII/其它：  4 字符 ≈ 1 token
// 这是保守上界：CJK 在主流 BPE 里通常 1~2 token/字，取 1 会低估个别模型，
// 但索引页以 ASCII 路径/十六进制 id 为主，整体误差远小于"硬上限"的余量。
//
// 为什么不装 tiktoken：插件在 agent 每一步被调用，任何 native 依赖
// 都会成为启动期风险；且这里只需要"裁剪到 ≤1,000 token"的量级判断。

// 宽字符（CJK / 全角 / emoji）判定，用于 1 字≈1 token 的计数
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals + Kangxi + CJK Symbols
  [0x3041, 0x33ff], // Hiragana / Katakana / CJK Compatibility
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x1f300, 0x1faff], // Emoji
  [0x20000, 0x3fffd], // CJK Ext B+
]

function isWideChar(codePoint) {
  for (const [lo, hi] of WIDE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true
  }
  return false
}

function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let wide = 0
  let ascii = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (isWideChar(cp)) wide += 1
    else ascii += 1
  }
  return wide + Math.ceil(ascii / 4)
}

module.exports = { estimateTokens, isWideChar, WIDE_RANGES }
