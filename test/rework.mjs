// 返工判定的单元测试：确认重跑 / 疑似补读 / legacy 回退 / 窗口边界。
// 运行：node test/rework.mjs
import assert from 'node:assert'
import { estimateRework } from '../lib/report.cjs'

const AVG = 1000
const NOW = 1_700_000_000_000
let n = 0

function rec(over) {
  n += 1
  return { ts: NOW + n, session: 's1', tool: 'read', target: 'a.txt', originalChars: 5000, visibleChars: 1000, mode: 'capped', argsHash: 'h1', argShape: 'plain', ...over }
}

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

test('same args within 30 min is confirmed rework', () => {
  const r = estimateRework([rec({ ts: NOW }), rec({ ts: NOW + 60_000 })], AVG)
  assert.equal(r.suspected, 1)
  assert.equal(r.continuation, 0)
  assert.equal(r.costEquiv, AVG)
})

test('different args right after a truncated result is a follow-up, not deducted', () => {
  const r = estimateRework([
    rec({ ts: NOW, argsHash: 'h1', mode: 'capped' }),
    rec({ ts: NOW + 120_000, argsHash: 'h2', argShape: 'offset+limit' }),
  ], AVG)
  assert.equal(r.suspected, 0)
  assert.equal(r.continuation, 1)
  assert.equal(r.costEquiv, 0)
})

test('different args on an untouched result is not labelled at all', () => {
  const r = estimateRework([
    rec({ ts: NOW, argsHash: 'h1', mode: 'base' }),
    rec({ ts: NOW + 120_000, argsHash: 'h2' }),
  ], AVG)
  assert.equal(r.suspected, 0)
  assert.equal(r.continuation, 0)
})

test('legacy records without a fingerprint fall back and are marked', () => {
  const legacy = { ts: NOW, session: 's2', tool: 'pwsh', target: 'dir', originalChars: 9000, visibleChars: 2500, mode: 'cap' }
  const r = estimateRework([legacy, { ...legacy, ts: NOW + 60_000 }], AVG)
  assert.equal(r.suspected, 1)
  assert.equal(r.legacy, 1)
})

test('outside the 30 min window does not count', () => {
  const r = estimateRework([rec({ ts: NOW }), rec({ ts: NOW + 31 * 60_000 })], AVG)
  assert.equal(r.suspected, 0)
  assert.equal(r.continuation, 0)
})

test('different sessions never pair up', () => {
  const r = estimateRework([rec({ ts: NOW, session: 'a' }), rec({ ts: NOW + 1000, session: 'b' })], AVG)
  assert.equal(r.suspected, 0)
})

test('different targets never pair up', () => {
  const r = estimateRework([rec({ ts: NOW, target: 'a.txt' }), rec({ ts: NOW + 1000, target: 'b.txt' })], AVG)
  assert.equal(r.suspected, 0)
})

console.log('\n通过 ' + passed + ' 项')
