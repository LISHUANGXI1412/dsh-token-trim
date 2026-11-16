// 反事实回放的单元测试：纯函数，不碰真实会话日志。
// 运行：node test/replay.mjs
import assert from 'node:assert'
import { parseLog, replaySession, estimateCompactionSavings, costOf, TOK_PER_CHAR } from '../lib/replay.mjs'

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

function line(event) {
  return JSON.stringify(event)
}

function logText(steps) {
  return steps.map((step) => line({ type: 'assistant/message', time: step.time, data: { usage: {
    cacheReadTokens: step.hit, inputTokens: step.miss, outputTokens: step.out,
  } } })).join('\n')
}

test('parseLog keeps step times and counts compactions', () => {
  const text = [
    line({ type: 'assistant/message', time: 1000, data: { usage: { cacheReadTokens: 100, inputTokens: 20, outputTokens: 5 } } }),
    line({ type: 'compaction/summary', data: { summary: [{ text: 'abcd' }] } }),
    line({ type: 'assistant/message', time: 2000, data: { usage: { cacheReadTokens: 40, inputTokens: 10, outputTokens: 7 } } }),
  ].join('\n')
  const parsed = parseLog(text)
  assert.equal(parsed.steps.length, 2)
  assert.equal(parsed.steps[0].prompt, 120)
  assert.equal(parsed.steps[1].prompt, 50)
  assert.deepEqual(parsed.compactions, [1])
})

test('a rewrite is charged once as miss, then once per later request', () => {
  const parsed = parseLog(logText([
    { time: 1000, hit: 100, miss: 0, out: 0 },
    { time: 2000, hit: 100, miss: 0, out: 0 },
    { time: 3000, hit: 100, miss: 0, out: 0 },
  ]))
  const result = replaySession({
    steps: parsed.steps,
    compactions: parsed.compactions,
    rewrites: [{ ts: 1500, originalChars: 1000, visibleChars: 0 }],
  })
  const savedTokens = 1000 * TOK_PER_CHAR
  // 进入上下文的第一个请求（index 1）按未命中 ×10，之后 1 个请求按命中 ×1
  assert.equal(result.aligned, 1)
  assert.equal(result.savedEquiv, savedTokens * 11)
})

test('a compaction ends the charged lifetime', () => {
  const parsed = parseLog([
    line({ type: 'assistant/message', time: 1000, data: { usage: { cacheReadTokens: 100, inputTokens: 0, outputTokens: 0 } } }),
    line({ type: 'assistant/message', time: 2000, data: { usage: { cacheReadTokens: 100, inputTokens: 0, outputTokens: 0 } } }),
    line({ type: 'compaction/summary', data: { summary: [{ text: 'x' }] } }),
    line({ type: 'assistant/message', time: 3000, data: { usage: { cacheReadTokens: 100, inputTokens: 0, outputTokens: 0 } } }),
  ].join('\n'))
  const result = replaySession({
    steps: parsed.steps,
    compactions: parsed.compactions,
    rewrites: [{ ts: 1500, originalChars: 1000, visibleChars: 0 }],
  })
  // compaction 发生在第 2 个 assistant 请求之后：只计 1 个请求，且是未命中价
  assert.equal(result.savedEquiv, 1000 * TOK_PER_CHAR * 10)
})

test('rewrites without a timestamp are skipped, not guessed', () => {
  const parsed = parseLog(logText([{ time: 1000, hit: 1, miss: 0, out: 0 }]))
  const result = replaySession({ steps: parsed.steps, compactions: [], rewrites: [{ originalChars: 100, visibleChars: 0 }] })
  assert.equal(result.aligned, 0)
  assert.equal(result.skipped, 1)
})

test('compaction savings are policy-driven and non-negative', () => {
  const deltas = []
  for (let i = 0; i < 60; i += 1) deltas.push(20000)
  const relaxed = estimateCompactionSavings(deltas, { thresholdRatio: 0.8, retainRatio: 0.16 })
  const tight = estimateCompactionSavings(deltas, { thresholdRatio: 0.4, retainRatio: 0.12 })
  assert.ok(tight.currentEvents > relaxed.currentEvents, 'tighter threshold compacts more often')
  assert.ok(tight.delta >= 0)
  assert.ok(tight.savedPct >= 0 && tight.savedPct <= 100)
  assert.equal(estimateCompactionSavings([]), null)
})

test('costOf uses hit x1 / miss x10 / output x15', () => {
  const cost = costOf([{ hit: 10, miss: 2, out: 1 }])
  assert.equal(cost, 10 + 20 + 15)
})

console.log('\n通过 ' + passed + ' 项')
