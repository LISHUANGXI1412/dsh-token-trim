// read 的行级重叠分析：同一会话同一文件被读多次时，后一次里有多少行是"已经读过的行"。
// 这是"范围感知去重"能真正省下的部分（内容完全相同的行才算）。
// 运行：node tools/read-overlap.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

let reads = 0
let chars = 0
let firstReadChars = 0
let laterReadChars = 0
let repeatedLineChars = 0
let repeatedLines = 0
let newLineChars = 0
let repeatedSameArgs = 0
let repeatedSameArgsCount = 0
let repeatedPaged = 0
let repeatedPagedCount = 0
const perFile = new Map()

for (const [sessionId, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }
  const calls = new Map()
  const seenLines = new Map() // file -> Set(lineText)
  const seenArgs = new Map() // `${file}|${raw}` -> true

  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (e.type === 'tool/call') {
      const d = e.data || {}
      if (d.name !== 'read') continue
      let file = '?'
      let rawArgs = ''
      try {
        rawArgs = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
        file = JSON.parse(rawArgs)?.file_path ?? '?'
      } catch {}
      calls.set(d.callId, { file, rawArgs })
      continue
    }
    if (e.type !== 'tool/result') continue
    const message = e.data?.message || {}
    const call = calls.get(message.toolCallId)
    if (!call) continue
    const { file } = call
    const blocks = Array.isArray(message.content) ? message.content.filter((b) => b?.type === 'text') : []
    if (!blocks.length) continue
    const body = blocks.map((b) => b.text).join('\n')
    reads += 1
    chars += body.length

    const known = seenLines.get(file) ?? new Set()
    const isFirst = known.size === 0
    if (isFirst) firstReadChars += body.length
    else laterReadChars += body.length

    let repeated = 0
    let fresh = 0
    for (const raw of body.split('\n')) {
      // 去掉行号前缀（"  12: "）后比较内容，避免同内容不同行号被算成不同
      const content = raw.replace(/^\s*\d+:\s?/, '')
      if (!content.trim()) continue
      if (known.has(content)) repeated += raw.length
      else { fresh += raw.length; known.add(content) }
    }
    seenLines.set(file, known)
    const sameArgs = seenArgs.has(file + '|' + call.rawArgs)
    seenArgs.set(file + '|' + call.rawArgs, true)
    if (sameArgs) { repeatedSameArgs += repeated; repeatedSameArgsCount += 1 }
    else { repeatedPaged += repeated; repeatedPagedCount += 1 }
    repeatedLineChars += repeated
    newLineChars += fresh
    repeatedLines += repeated > 0 ? 1 : 0
    const f = perFile.get(file) ?? { chars: 0, repeated: 0, reads: 0 }
    f.chars += body.length
    f.repeated += repeated
    f.reads += 1
    perFile.set(file, f)
  }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—')
const fmt = (n) => (n / 1e6).toFixed(2) + 'M'

console.log(`reads=${reads} chars=${fmt(chars)}`)
console.log(`first reads of a file:  ${fmt(firstReadChars)}`)
console.log(`later reads of a file:  ${fmt(laterReadChars)}`)
console.log(`  of which already-read lines: ${fmt(repeatedLineChars)} (${pct(repeatedLineChars, chars)} of all read chars, ${pct(repeatedLineChars, laterReadChars)} of later reads)`)
console.log(`  new lines across all reads:  ${fmt(newLineChars)}`)
console.log(`  later reads containing any repeated line: ${repeatedLines}`)
console.log(`    same args as before (edit then re-read): ${repeatedSameArgsCount} reads, ${fmt(repeatedSameArgs)} repeated`)
console.log(`    different args (pagination overlap):      ${repeatedPagedCount} reads, ${fmt(repeatedPaged)} repeated`)
console.log('\nfiles with the most repeated line chars')
for (const [file, f] of [...perFile.entries()].sort((a, b) => b[1].repeated - a[1].repeated).slice(0, 8)) {
  console.log('  ' + String(f.reads).padStart(2) + 'x ' + fmt(f.repeated).padStart(8) + ' repeated / ' + fmt(f.chars).padStart(8) + '  ' + String(file).slice(0, 70))
}
