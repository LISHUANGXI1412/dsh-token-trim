// 回归测试：delta / 未变状态必须按 agent 隔离。
//
// 曾经的 bug（2026-11-14 实测）：状态 Map 是全局的，子 agent 会对一个它从没读过的文件
// 收到「[未变 · 与 #N 相同]」，而 #N 的原文只存在于父 agent 的上下文里 → 静默丢信息。
//
// 这个文件独立于 test/run.mjs（后者是历史编码损坏的文件，不去动它）。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-agent-'))
let handler = null

const ctx = {
  on(event, fn) {
    assert.equal(event, 'tools/post-execute')
    handler = fn
  },
  tools: { register() {} },
}

apply(ctx, {
  artifactDir: path.join(tmp, 'artifacts'),
  manifest: path.join(tmp, 'manifest.jsonl'),
  caps: { read: 4000 },
  summaryTools: [],
  deltaTools: ['read'],
  minChars: 100,
})

const text = 'x'.repeat(9000)
const result = { content: [{ type: 'text', text }] }
const args = JSON.stringify({ file_path: 'E:\\ws\\a.mjs' })

const exec = (agentId, callId) => ({ name: 'read', arguments: args, callId, agent: { id: agentId } })
const next = async () => ({ kind: 'accept', content: result.content })

// 1) 父 agent 第一次：正常截断
const first = await handler(exec('parent', 'call_1'), result, next)
assert.equal(first?.kind, 'accept')

// 2) 同一个 agent 再读一次同样的内容：应当命中「未变」
const second = await handler(exec('parent', 'call_2'), result, next)
const secondText = second?.content?.[0]?.text ?? ''
assert.ok(secondText.includes('未变'), `同一 agent 应命中未变，实际：${secondText.slice(0, 80)}`)

// 3) 换一个 agent（子 agent）读同样内容：**不得**命中「未变」
const third = await handler(exec('child', 'call_3'), result, next)
const thirdText = third?.content?.[0]?.text ?? ''
assert.ok(!thirdText.includes('未变'), `跨 agent 不得命中未变，实际：${thirdText.slice(0, 120)}`)
assert.ok(thirdText.length > 0, '子 agent 应拿到自己的截断结果')

console.log('✅ cross-agent 隔离：3/3 通过')

// 4) manifest 必须记下"这是什么"（供上下文索引展示；没有它索引里只有 id）
const manifest = path.join(tmp, 'manifest.jsonl')
const lines = fs.readFileSync(manifest, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const withTarget = lines.filter((e) => typeof e.target === 'string' && e.target.includes('a.mjs'))
assert.ok(withTarget.length >= 1, `manifest 应记录 target，实际：${JSON.stringify(lines[0])}`)
console.log(`✅ manifest target：${withTarget.length}/${lines.length} 条带目标路径`)
