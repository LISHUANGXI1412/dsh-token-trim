// 单元/集成测试：不安装插件，用一个假 ctx 直接驱动 post-execute 处理器
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-test-'))
const seen = { next: 0, accept: [] }
let lastTool = null

function makeCtx(config) {
  let handler = null
  let tool = null
  const ctx = {
    on(event, fn) {
      assert.equal(event, 'tools/post-execute')
      handler = fn
    },
    tools: {
      register(def) { tool = def },
    },
  }
  apply(ctx, {
    artifactDir: path.join(tmp, 'artifacts'),
    manifest: path.join(tmp, 'manifest.jsonl'),
    ...config,
  })
  assert.ok(handler, 'handler 未注册')
  assert.ok(tool, 'guard_query 未注册')
  return { handler, tool }
}

async function run(handler, exec, result) {
  let decided = null
  const next = async () => {
    seen.next += 1
    return { kind: 'accept', content: result.content ?? [{ type: 'text', text: String(result.value ?? '') }] }
  }
  decided = await handler(exec, result, next)
  return decided
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

// ---- 用例 ----
const cases = []
function test(name, fn) { cases.push({ name, fn }) }

test('小结果不动', async (h) => {
  const r = await run(h, { name: 'pwsh', callId: 'c1', arguments: '{"command":"x"}' }, text('short output'))
  assert.equal(r.kind, 'accept')
  assert.equal(r.content[0].text, 'short output')
})

test('非白名单工具不动（write/edit）', async (h) => {
  const big = 'x'.repeat(20000)
  const r = await run(h, { name: 'write', callId: 'c2', arguments: '{}' }, text(big))
  assert.equal(r.content[0].text, big)
})

test('非纯文本结果不动', async (h) => {
  const big = 'x'.repeat(20000)
  const r = await run(h, { name: 'pwsh', callId: 'c3', arguments: '{}' }, { content: [{ type: 'image', data: 'x' }, { type: 'text', text: big }] })
  assert.equal(r.content.length, 2)
})

test('pwsh 长输出被截断，且原文落盘', async (h) => {
  const lines = []
  for (let i = 1; i <= 1200; i += 1) lines.push(`line ${i} ` + 'y'.repeat(20))
  const original = lines.join('\n')
  const r = await run(h, { name: 'pwsh', callId: 'c4', arguments: '{"command":"a"}' }, text(original))
  const out = r.content[0].text
  assert.ok(out.length < original.length, '应被截断')
  assert.ok(out.includes('省略'), '应有省略提示')
  assert.ok(out.includes('line 1 '), '应保留开头')
  assert.ok(out.includes('line 1200'), '应保留结尾')
  const files = fs.readdirSync(path.join(tmp, 'artifacts'))
  assert.ok(files.length >= 1, '应写出 artifact')
  const artifactText = fs.readFileSync(path.join(tmp, 'artifacts', files[0]), 'utf8')
  assert.equal(artifactText, original, 'artifact 必须与原文逐字相同')
})

test('同调用重跑且内容未变 → 未变指针', async (h) => {
  const original = Array.from({ length: 800 }, (_, i) => `row ${i} ` + 'z'.repeat(20)).join('\n')
  const exec = { name: 'pwsh', callId: 'c5', arguments: '{"command":"same"}' }
  await run(h, exec, text(original))
  const r2 = await run(h, exec, text(original))
  assert.ok(r2.content[0].text.includes('未变'), `应返回未变，实际: ${r2.content[0].text.slice(0, 80)}`)
})

test('同调用内容变了 → 差异', async (h) => {
  const base = Array.from({ length: 800 }, (_, i) => `row ${i} ` + 'z'.repeat(20)).join('\n')
  const exec = { name: 'job_output', callId: 'c6', arguments: '{"job":"j1"}' }
  await run(h, exec, text(base))
  const changed = base + '\nERROR: something new happened'
  const r2 = await run(h, exec, text(changed))
  const out = r2.content[0].text
  assert.ok(out.includes('同比') || out.includes('未变'), `应返回差异或未变，实际: ${out.slice(0, 80)}`)
})

test('cordis 准 JSON（字符串含裸换行）能摘要', async (h) => {
  const obj = {
    platform: 'host',
    provider: 'Tool',
    method: 'listTools',
    data: { tools: Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}`, description: `desc\nline2 ${'q'.repeat(200)}`, parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } })) },
  }
  // 故意把换行写成裸字符，模拟真实输出
  const raw = JSON.stringify(obj, null, 1).replace(/\\n/g, '\n')
  const r = await run(h, { name: 'cordis_inspect_query', callId: 'c7', arguments: '{"method":"listTools"}' }, text(raw))
  const out = r.content[0].text
  assert.ok(out.includes('结构摘要'), `应为结构摘要，实际: ${out.slice(0, 60)}`)
  assert.ok(out.includes('tool_0'), '摘要应含工具名')
  assert.ok(out.length < raw.length, '摘要应更短')
})

test('处理过程抛错时失败开放', async (h) => {
  const weird = { content: [{ type: 'text', get text() { throw new Error('boom') } }] }
  let threw = false
  try {
    await run(h, { name: 'pwsh', callId: 'c8', arguments: '{}' }, weird)
  } catch { threw = true }
  assert.equal(threw, false, '不应向外抛错')
})

test('dryRun 不改内容但记账', async (h2) => {
  const original = Array.from({ length: 1200 }, (_, i) => `l${i} ` + 'w'.repeat(20)).join('\n')
  const r = await run(h2, { name: 'pwsh', callId: 'c9', arguments: '{}' }, text(original))
  assert.equal(r.content[0].text, original)
  const manifest = fs.readFileSync(path.join(tmp, 'manifest-dry.jsonl'), 'utf8').trim().split('\n')
  assert.ok(manifest.length >= 1)
  assert.ok(JSON.parse(manifest[0]).dryRun)
})

test('guard_query 能按 pattern 取回命中行', async (h) => {
  const lines = []
  for (let i = 1; i <= 400; i += 1) lines.push(i === 250 ? 'ERROR: needle_here' : `line ${i} ` + 'k'.repeat(30))
  const original = lines.join('\n')
  const r = await run(h, { name: 'pwsh', callId: 'q1', arguments: '{"command":"q"}' }, text(original))
  const m = r.content[0].text.match(/artifact ([0-9a-f]+)/)
  assert.ok(m, '截断结果里应含 artifact id')
  const tool = lastTool
  const out = await tool.execute({ id: m[1], pattern: 'needle_here' })
  assert.ok(out.includes('needle_here'), '应返回命中行')
  assert.ok(out.includes('250:'), '应带行号')
  assert.ok(out.length < original.length, '查询结果应远小于原文')
})

test('guard_query 拒绝非法 id（防路径穿越）', async (h) => {
  const out = await lastTool.execute({ id: '../../etc/passwd', pattern: 'root' })
  assert.ok(out.includes('无效的 artifact id'), `应拒绝，实际: ${out.slice(0, 80)}`)
})

test('guard_query 超过 2 次取回后直接给全文', async (h) => {
  const lines = []
  for (let i = 1; i <= 500; i += 1) lines.push(i === 10 ? 'ERROR: first_needle' : `line ${i} ` + 'p'.repeat(30))
  const original = lines.join('\n')
  const r = await run(h, { name: 'pwsh', callId: 'q3', arguments: '{"command":"q3"}' }, text(original))
  const m = r.content[0].text.match(/artifact ([0-9a-f]+)/)
  const id = m[1]
  const first = await lastTool.execute({ id, pattern: 'first_needle' })
  assert.ok(first.includes('第 1/2 次取回'), `首次应标注次数，实际: ${first.slice(0, 100)}`)
  const second = await lastTool.execute({ id, pattern: 'first_needle' })
  assert.ok(second.includes('第 2/2 次取回'), `第二次应标注次数，实际: ${second.slice(0, 100)}`)
  const third = await lastTool.execute({ id, pattern: 'first_needle' })
  assert.ok(third.includes('已达取回上限'), `第三次应给全文，实际: ${third.slice(0, 100)}`)
  assert.ok(third.includes('line 500'), '全文应包含尾部内容')
})

test('回归：dryRun 在目录不存在时也能记账', async (h) => {
  const original = Array.from({ length: 400 }, (_, i) => `line ${i} ` + 'R'.repeat(20)).join('\n')
  const r = await run(h, { name: 'pwsh', callId: 'reg1', arguments: '{}' }, text(original))
  assert.equal(r.content[0].text, original, 'dryRun 不应改动内容')
  const mf = path.join(tmp, 'deep', 'nested', 'manifest.jsonl')
  assert.ok(fs.existsSync(mf), '应自动创建目录并写入 manifest')
  const line = fs.readFileSync(mf, 'utf8').trim().split('\n').pop()
  assert.ok(JSON.parse(line).dryRun, '记录应标记 dryRun')
})

test('guard_query 未命中时给出明确说明', async (h) => {
  const original = Array.from({ length: 400 }, (_, i) => `line ${i} ` + 'm'.repeat(30)).join('\n')
  const r = await run(h, { name: 'pwsh', callId: 'q2', arguments: '{"command":"q2"}' }, text(original))
  const m = r.content[0].text.match(/artifact ([0-9a-f]+)/)
  const out = await lastTool.execute({ id: m[1], pattern: 'nonexistent_zzz' })
  assert.ok(out.includes('未命中'), out.slice(0, 80))
})

test('未列出的工具走 capsDefault 兜底', async (h) => {
  const original = Array.from({ length: 400 }, (_, i) => `row ${i} ` + 'x'.repeat(40)).join('\n')
  assert.ok(original.length > 6000)
  const r = await run(h, { name: 'some_mcp__tool', callId: 'u1', arguments: '{"q":1}' }, text(original))
  const out = r.content[0].text
  assert.ok(out.length < original.length, 'uncapped: ' + out.length)
  assert.ok(out.length < 6000 + 800, 'cap exceeded: ' + out.length)
})

test('显式 caps 0 的工具不截（read / guard_query）', async (h) => {
  const original = Array.from({ length: 400 }, (_, i) => `line ${i} ` + 'y'.repeat(40)).join('\n')
  for (const tool of ['read', 'guard_query']) {
    const r = await run(h, { name: tool, callId: 'zero-' + tool, arguments: '{"file_path":"a"}' }, text(original))
    assert.equal(r.content[0].text, original, tool + ' was modified')
  }
})

let passed = 0
const failures = []
for (const c of cases) {
  const isRegression = c.name.startsWith('回归：')
  const ctxObj = makeCtx(isRegression
    ? {
        dryRun: true,
        manifest: path.join(tmp, 'deep', 'nested', 'manifest.jsonl'),
        artifactDir: path.join(tmp, 'deep', 'nested', 'artifacts'),
      }
    : c.name === 'dryRun 不改内容但记账'
      ? { dryRun: true, manifest: path.join(tmp, 'manifest-dry.jsonl') }
      : {})
  lastTool = ctxObj.tool
  try {
    await c.fn(ctxObj.handler)
    passed += 1
    console.log(`  ✅ ${c.name}`)
  } catch (e) {
    failures.push({ name: c.name, error: e.message })
    console.log(`  ❌ ${c.name}: ${e.message}`)
  }
}
console.log(`\n通过 ${passed}/${cases.length}`)
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1 }
fs.rmSync(tmp, { recursive: true, force: true })
