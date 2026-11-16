// replay-parity.mjs — 用插件真实处理器跑全部 1,518 条结果，产物给分词器复核
// 目的：证明「插件实现」与「回放器估算」是同一个数
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'

const ROOT = 'E:/dsh的工作区'
const RESULTS = path.join(ROOT, 'data/evidence_block/replay/results.jsonl')
const OUT = path.join(ROOT, 'data/evidence_block/replay/plugin-visible.jsonl')

const rows = fs.readFileSync(RESULTS, 'utf8').trim().split('\n').map(JSON.parse)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-parity-'))

let handler = null
apply({
  on: (_e, fn) => { handler = fn },
  tools: { register: () => {} },
}, {
  artifactDir: path.join(tmp, 'artifacts'),
  manifest: path.join(tmp, 'manifest.jsonl'),
})

const out = []
for (const r of rows) {
  const result = { content: [{ type: 'text', text: r.text }] }
  const next = async () => result
  const decided = await handler({ name: r.tool, callId: r.callId ?? r.sha, arguments: r.args }, result, next)
  const visible = decided?.content?.[0]?.text ?? r.text
  out.push({ seq: r.seq, tool: r.tool, original: r.text.length, visible: visible.length, changed: visible !== r.text, text: visible })
}

fs.writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
const changed = out.filter((o) => o.changed).length
console.log(`插件处理完成：${out.length} 条，其中 ${changed} 条被改写`)
console.log(`原文合计 ${out.reduce((a, o) => a + o.original, 0)} 字符，可见合计 ${out.reduce((a, o) => a + o.visible, 0)} 字符`)
fs.rmSync(tmp, { recursive: true, force: true })
