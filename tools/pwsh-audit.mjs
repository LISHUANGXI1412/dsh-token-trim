// pwsh 输出还有多少可压？重点看"同一结果内的重复行"——日志类输出的典型冗余。
// 运行：node tools/pwsh-audit.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

let results = 0
let chars = 0
let dupLineChars = 0
let dupOnlyResults = 0
let bigResults = 0
let bigChars = 0
let bigDupChars = 0
const examples = []

for (const [, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }
  const isPwsh = new Set()
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (e.type === 'tool/call') {
      if (e.data?.name === 'pwsh') isPwsh.add(e.data.callId)
      continue
    }
    if (e.type !== 'tool/result') continue
    const message = e.data?.message || {}
    if (!isPwsh.has(message.toolCallId)) continue
    const blocks = Array.isArray(message.content) ? message.content.filter((b) => b?.type === 'text') : []
    if (!blocks.length) continue
    const body = blocks.map((b) => b.text).join('\n')
    results += 1
    chars += body.length

    // 同一结果内完全相同的行：只保留一次能省多少
    const counts = new Map()
    for (const raw of body.split('\n')) {
      const t = raw.trim()
      if (!t) continue
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    let dup = 0
    let top = null
    for (const [t, n] of counts) {
      if (n < 2) continue
      dup += (n - 1) * t.length
      if (!top || n > top.n) top = { t, n }
    }
    if (dup > 0) dupOnlyResults += 1
    dupLineChars += dup
    if (body.length >= 4000) {
      bigResults += 1
      bigChars += body.length
      bigDupChars += dup
      if (top && top.n >= 5 && examples.length < 6) examples.push({ lines: top.n, len: top.t.length, sample: top.t.slice(0, 70) })
    }
  }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—')
const fmt = (n) => (n / 1e6).toFixed(2) + 'M'

console.log(`pwsh results=${results} chars=${fmt(chars)}`)
console.log(`results containing repeated lines: ${dupOnlyResults} (${pct(dupOnlyResults, results)})`)
console.log(`repeated-line chars (可去重上限): ${fmt(dupLineChars)} (${pct(dupLineChars, chars)} of pwsh chars)`)
console.log(`\nbig results (>=4000 chars): ${bigResults} / ${fmt(bigChars)}; repeated-line chars ${fmt(bigDupChars)} (${pct(bigDupChars, bigChars)})`)
console.log('\nmost repeated single line (big results)')
for (const x of examples) console.log('  ' + String(x.lines).padStart(4) + 'x  len ' + String(x.len).padStart(4) + '  ' + x.sample)
