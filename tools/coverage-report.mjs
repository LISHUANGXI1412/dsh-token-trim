// 分析：会话日志里工具结果的真实分布 vs 本插件实际改写了多少 —— 找出还剩下的空间。
// 运行：node tools/coverage-report.mjs [天数=7]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles, parseLog } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const days = Number(process.argv[2] || 7)
const since = Date.now() - days * 86400000
const home = os.homedir()

const files = indexSessionFiles(path.join(home, '.dsh/sessions'))
const recent = [...files.entries()].filter(([, e]) => e.mtimeMs >= since)

const typeCounts = new Map()
const toolResults = [] // { session, tool, chars, time }
let sampleShown = 0

for (const [sessionId, entry] of recent) {
  let text
  try {
    text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!event || typeof event !== 'object') continue
    typeCounts.set(event.type, (typeCounts.get(event.type) || 0) + 1)
  }
  if (sampleShown < 1) {
    // 打印一条 tool 相关事件的结构，便于确认结果正文存在哪里
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event && typeof event.type === 'string' && /tool/.test(event.type)) {
        const clone = JSON.parse(JSON.stringify(event))
        const data = clone.data || {}
        for (const key of Object.keys(data)) {
          if (typeof data[key] === 'string' && data[key].length > 200) data[key] = '<string ' + data[key].length + ' chars>'
          if (Array.isArray(data[key])) data[key] = '<array ' + data[key].length + '>'
        }
        console.log('SAMPLE', JSON.stringify(clone).slice(0, 600))
        sampleShown += 1
        break
      }
    }
  }
}

console.log('\nEVENT TYPES (top 20)')
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(String(count).padStart(7), type)
}
