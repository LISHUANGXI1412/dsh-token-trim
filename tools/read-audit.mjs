// read 工具的实测画像：调用次数、结果大小、分页读比例、同文件重复读。
// 运行：node tools/read-audit.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

const buckets = { '<2K': 0, '2-6K': 0, '6-20K': 0, '20-50K': 0, '>50K': 0 }
const charsByBucket = { '<2K': 0, '2-6K': 0, '6-20K': 0, '20-50K': 0, '>50K': 0 }
let calls = 0
let totalChars = 0
let partialCalls = 0
let partialChars = 0
let fullCalls = 0
let fullChars = 0
let withResult = 0
const fileChars = new Map() // `${session}|${file}` -> { chars, count }

for (const [sessionId, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }
  const callsById = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (e.type === 'tool/call') {
      const d = e.data || {}
      if (d.name !== 'read') continue
      let args = d.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
      callsById.set(d.callId, { file: args?.file_path ?? '?', paginated: args?.offset != null || args?.limit != null })
      continue
    }
    if (e.type !== 'tool/result') continue
    const message = e.data?.message || {}
    const call = callsById.get(message.toolCallId)
    if (!call) continue
    const blocks = Array.isArray(message.content) ? message.content.filter((b) => b?.type === 'text') : []
    if (!blocks.length) continue
    const chars = blocks.reduce((a, b) => a + b.text.length, 0)
    withResult += 1
    calls += 1
    totalChars += chars
    if (call.paginated) { partialCalls += 1; partialChars += chars } else { fullCalls += 1; fullChars += chars }
    const key = chars < 2000 ? '<2K' : chars < 6000 ? '2-6K' : chars < 20000 ? '6-20K' : chars < 50000 ? '20-50K' : '>50K'
    buckets[key] += 1
    charsByBucket[key] += chars
    const fileKey = sessionId + '|' + call.file
    const prev = fileChars.get(fileKey) ?? { chars: 0, count: 0, file: call.file }
    prev.chars += chars
    prev.count += 1
    fileChars.set(fileKey, prev)
  }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—')
const fmt = (n) => (n / 1e6).toFixed(2) + 'M'

console.log(`sessions=${sessions.length} read_calls_with_result=${withResult}`)
console.log(`total chars ${fmt(totalChars)}`)
console.log(`paginated (offset/limit given): ${partialCalls} calls / ${fmt(partialChars)} (${pct(partialCalls, calls)})`)
console.log(`whole-file reads: ${fullCalls} calls / ${fmt(fullChars)} (${pct(fullCalls, calls)})`)
console.log('\nsize distribution')
for (const key of Object.keys(buckets)) {
  console.log('  ' + key.padEnd(7) + String(buckets[key]).padStart(5) + ' calls' + fmt(charsByBucket[key]).padStart(9) + '  ' + pct(charsByBucket[key], totalChars).padStart(6))
}

const byFile = [...fileChars.values()]
const once = byFile.filter((f) => f.count === 1)
const twice = byFile.filter((f) => f.count === 2)
const thrice = byFile.filter((f) => f.count >= 3)
const sum = (arr) => arr.reduce((a, f) => a + f.chars, 0)
console.log('\nsame-file repeats within a session')
console.log('  read once   : ' + String(once.length).padStart(4) + ' files, ' + fmt(sum(once)) + ' chars')
console.log('  read twice  : ' + String(twice.length).padStart(4) + ' files, ' + fmt(sum(twice)) + ' chars')
console.log('  read 3+     : ' + String(thrice.length).padStart(4) + ' files, ' + fmt(sum(thrice)) + ' chars')
const repeatChars = sum(byFile.map((f) => ({ chars: f.chars - (f.count ? Math.round(f.chars / f.count) : 0) })))
console.log('  chars spent on repeat reads (approx): ' + fmt(repeatChars))

const top = [...fileChars.values()].sort((a, b) => b.chars - a.chars).slice(0, 8)
console.log('\ntop files')
for (const f of top) console.log('  ' + String(f.count).padStart(2) + 'x ' + fmt(f.chars).padStart(8) + '  ' + String(f.file).slice(0, 80))
