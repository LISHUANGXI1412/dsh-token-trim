// 冒烟：确认 manifest 新记录带参数指纹（argsHash / argShape）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'))
let handler = null
apply({ on(_e, fn) { handler = fn }, tools: { register() {} } }, {
  artifactDir: path.join(tmp, 'a'),
  manifest: path.join(tmp, 'm.jsonl'),
})

const body = Array.from({ length: 300 }, (_, i) => 'line ' + i + ' ' + 'q'.repeat(40)).join('\n')
const calls = [
  ['c1', JSON.stringify({ file_path: 'a.txt' })],
  ['c2', JSON.stringify({ file_path: 'a.txt', offset: 400, limit: 200 })],
]
for (const [callId, args] of calls) {
  const result = { content: [{ type: 'text', text: body }] }
  await handler({ name: 'some_mcp_tool', callId, arguments: args }, result, async () => result)
}
await new Promise((resolve) => setTimeout(resolve, 300))

const lines = fs.readFileSync(path.join(tmp, 'm.jsonl'), 'utf8').trim().split('\n')
for (const line of lines) {
  const o = JSON.parse(line)
  console.log(JSON.stringify({ tool: o.tool, mode: o.mode, argsHash: o.argsHash, argShape: o.argShape, orig: o.originalChars, vis: o.visibleChars }))
}
fs.rmSync(tmp, { recursive: true, force: true })
