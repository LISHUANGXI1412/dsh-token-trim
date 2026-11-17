// read 重读的严格统计：按"结果内容哈希"判断是否真的重读，并区分
//   ① 真冗余：内容完全相同，且两次之间没有发生压缩（旧内容还在上下文里）；
//   ② 压缩后重读：内容相同，但中间压缩过（旧内容已被淘汰，属于合理重读）；
//   ③ 内容变了：同参数但文件已变（编辑后再读，属于合理操作）；
//   ④ 换页读：参数不同（offset/limit 变化），内容可能重叠但不是重读。
// 运行：node tools/read-rework.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const sessions = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

let totalReads = 0
let totalChars = 0
let trueRedundant = 0
let trueRedundantChars = 0
let afterCompaction = 0
let afterCompactionChars = 0
let contentChanged = 0
let contentChangedChars = 0
const redundantBySession = new Map()
const redundantFiles = new Map()
const samples = []

for (const [sessionId, entry] of sessions) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8') } catch { continue }

  const calls = new Map() // callId -> {file, raw}
  const compactions = [] // step index
  let step = 0
  let compactionCount = 0
  const seen = new Map() // hash -> { step, compactionAt, chars }
  const seenKey = new Map() // `${file}|${raw}` -> { hash, step, compactionAt }

  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (e.type === 'assistant/message') { step += 1; continue }
    if (e.type === 'compaction/summary') { compactions.push(step); compactionCount += 1; continue }
    if (e.type === 'tool/call') {
      const d = e.data || {}
      if (d.name !== 'read') continue
      const raw = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
      let file = '?'
      try { file = JSON.parse(raw)?.file_path ?? '?' } catch {}
      calls.set(d.callId, { file, raw })
      continue
    }
    if (e.type !== 'tool/result') continue
    const message = e.data?.message || {}
    const call = calls.get(message.toolCallId)
    if (!call) continue
    const blocks = Array.isArray(message.content) ? message.content.filter((b) => b?.type === 'text') : []
    if (!blocks.length) continue
    const body = blocks.map((b) => b.text).join('\n')
    const chars = body.length
    const contentHash = hash(body)
    totalReads += 1
    totalChars += chars

    const prevByHash = seen.get(contentHash)
    const prevByArgs = seenKey.get(call.file + '|' + call.raw)

    if (prevByHash) {
      const compactionBetween = compactions.some((c) => c > prevByHash.step && c <= step)
      if (compactionBetween) {
        afterCompaction += 1
        afterCompactionChars += chars
      } else {
        trueRedundant += 1
        trueRedundantChars += chars
        redundantBySession.set(sessionId, (redundantBySession.get(sessionId) ?? 0) + 1)
        const f = redundantFiles.get(call.file) ?? { count: 0, chars: 0 }
        f.count += 1
        f.chars += chars
        redundantFiles.set(call.file, f)
        if (samples.length < 6) samples.push({ file: call.file, chars, step })
      }
    } else if (prevByArgs && prevByArgs.hash !== contentHash) {
      contentChanged += 1
      contentChangedChars += chars
    }

    seen.set(contentHash, { step, chars })
    seenKey.set(call.file + '|' + call.raw, { hash: contentHash, step })
  }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—')
const fmt = (n) => (n / 1e6).toFixed(2) + 'M'

console.log(`sessions=${sessions.length} reads=${totalReads} chars=${fmt(totalChars)}`)
console.log(`① true redundant (identical content, no compaction between): ${trueRedundant} (${pct(trueRedundant, totalReads)}) / ${fmt(trueRedundantChars)} (${pct(trueRedundantChars, totalChars)} of read chars)`)
console.log(`② re-read after a compaction (legitimate):                 ${afterCompaction} (${pct(afterCompaction, totalReads)}) / ${fmt(afterCompactionChars)}`)
console.log(`③ same args but content changed (edit then re-read):       ${contentChanged} (${pct(contentChanged, totalReads)}) / ${fmt(contentChangedChars)}`)
console.log('')
console.log('top files by true-redundant reads')
for (const [file, f] of [...redundantFiles.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 8)) {
  console.log('  ' + String(f.count).padStart(2) + 'x ' + fmt(f.chars).padStart(8) + '  ' + String(file).slice(0, 78))
}
console.log('\nsamples')
for (const s of samples) console.log('  step ' + String(s.step).padStart(4) + '  ' + String(s.chars).padStart(6) + ' chars  ' + s.file.slice(0, 70))
