// manifest-report.cjs — 汇总 token-guard 的 manifest，给出"如果真启用会省多少"
// 用法：node token-guard/tools/manifest-report.cjs [--days=1]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
const MANIFEST = args.file ? path.resolve(String(args.file)) : path.join(os.homedir(), '.dsh', 'token-guard', 'manifest.jsonl')
const TOK_PER_CHAR = 0.306 // 本机实测（replay 基线 751,715 token / 2,457,799 字符）
const BILL_TOOL_SHARE = 0.407

const days = Number(args.days ?? 0) // 0 = 全部

if (!fs.existsSync(MANIFEST)) {
  console.log(`还没有 manifest：${MANIFEST}`)
  console.log('（插件未安装，或还没产生过被处理的结果）')
  process.exit(0)
}

const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0
const rows = fs.readFileSync(MANIFEST, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l) } catch { return null }
}).filter(Boolean).filter((r) => (r.ts ?? 0) >= cutoff)

if (!rows.length) { console.log(`最近 ${days || '全部'} 天没有记录`); process.exit(0) }

const byTool = new Map()
const byMode = new Map()
let orig = 0, vis = 0
let dry = 0
for (const r of rows) {
  const t = byTool.get(r.tool) ?? { n: 0, orig: 0, vis: 0 }
  t.n += 1; t.orig += r.originalChars ?? 0; t.vis += r.visibleChars ?? 0
  byTool.set(r.tool, t)
  byMode.set(r.mode, (byMode.get(r.mode) ?? 0) + 1)
  orig += r.originalChars ?? 0
  vis += r.visibleChars ?? 0
  if (r.dryRun) dry += 1
}

const savedChars = orig - vis
const savedTokens = savedChars * TOK_PER_CHAR
const fmt = (n) => n.toLocaleString()

console.log(`记录 ${rows.length} 条（其中 dryRun ${dry} 条${dry ? '，未真正改动内容' : ''}）`)
console.log(`原字符 ${fmt(orig)} → 可见 ${fmt(vis)}，省 ${fmt(savedChars)} 字符 ≈ ${fmt(Math.round(savedTokens))} token`)
if (orig) console.log(`工具结果这一项可折算账单 ${(savedChars / orig * BILL_TOOL_SHARE * 100).toFixed(1)}%（按本次样本）`)

console.log('\n按工具：')
console.log('工具 | 次数 | 原字符 | 可见字符 | 削减')
for (const [tool, t] of [...byTool.entries()].sort((a, b) => b[1].orig - a[1].orig)) {
  const cut = t.orig ? ((1 - t.vis / t.orig) * 100).toFixed(1) : '0.0'
  console.log(`${tool} | ${t.n} | ${fmt(t.orig)} | ${fmt(t.vis)} | ${cut}%`)
}

console.log('\n按模式：', [...byMode.entries()].map(([m, n]) => `${m}=${n}`).join('  '))

const top = [...rows].sort((a, b) => (b.originalChars - b.visibleChars) - (a.originalChars - a.visibleChars)).slice(0, 5)
console.log('\n改动最大的 5 条：')
for (const r of top) console.log(`  ${r.tool} ${r.mode}: ${fmt(r.originalChars)} → ${fmt(r.visibleChars)}${r.artifact ? ' · ' + r.artifact : ''}`)

const suspicious = rows.filter((r) => r.visibleChars > r.originalChars)
if (suspicious.length) console.log(`\n⚠️ 有 ${suspicious.length} 条"越改越大"，应检查摘要逻辑`)
