// 从真实会话日志的 request/header 里取出 read 工具的原始定义（模型看到的那份）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexSessionFiles } from '../lib/replay.mjs'
import { decompress } from '../vendor/fzstd/index.mjs'

const files = indexSessionFiles(path.join(os.homedir(), '.dsh/sessions'))
const entry = [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
const text = Buffer.from(decompress(fs.readFileSync(entry.file))).toString('utf8')

for (const line of text.split('\n')) {
  if (!line) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (e.type !== 'request/header') continue
  const tools = e.data?.tools ?? e.data?.body?.tools ?? []
  const read = tools.find((t) => (t.function?.name ?? t.name) === 'read')
  if (!read) continue
  console.log(JSON.stringify(read, null, 1).slice(0, 3000))
  break
}
