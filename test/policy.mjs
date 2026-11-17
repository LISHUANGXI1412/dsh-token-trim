// 压缩策略读取的单元测试：真实 settings.json 是嵌套结构，0.2.3 及以前读顶层导致永远回落。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readCompactionPolicy } from '../lib/replay.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'))
function writeProfile(name, payload) {
  const dir = path.join(root, name, 'dsh-context-kit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(payload), 'utf8')
}

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

test('reads the nested preset config (the real on-disk shape)', () => {
  writeProfile('desktop', {
    presets: { cordis: { plugins: { 'compaction-basic': { group: 'compaction', config: { auto: true, thresholdRatio: 0.35, retainRatio: 0.1 } } } } },
  })
  const p = readCompactionPolicy({ profilesRoot: root })
  assert.equal(p.thresholdRatio, 0.35)
  assert.equal(p.retainRatio, 0.1)
})

test('still accepts the legacy flat shape', () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-flat-'))
  const dir = path.join(root2, 'desktop', 'dsh-context-kit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ thresholdRatio: 0.3, retainRatio: 0.1 }), 'utf8')
  const p = readCompactionPolicy({ profilesRoot: root2 })
  assert.equal(p.thresholdRatio, 0.3)
  assert.equal(p.retainRatio, 0.1)
})

test('missing settings falls back to 0.4 / 0.12', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-empty-'))
  const p = readCompactionPolicy({ profilesRoot: empty })
  assert.equal(p.thresholdRatio, 0.4)
  assert.equal(p.retainRatio, 0.12)
  assert.equal(p.source, 'fallback')
})

test('picks the most recently modified profile', () => {
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-multi-'))
  for (const [name, threshold] of [['a', 0.4], ['b', 0.25]]) {
    const dir = path.join(root3, name, 'dsh-context-kit')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ presets: { cordis: { plugins: { 'compaction-basic': { config: { thresholdRatio: threshold, retainRatio: 0.1 } } } } } }), 'utf8')
    const t = threshold === 0.25 ? Date.now() : Date.now() - 60000
    fs.utimesSync(file, new Date(t), new Date(t))
  }
  const p = readCompactionPolicy({ profilesRoot: root3 })
  assert.equal(p.thresholdRatio, 0.25)
})

fs.rmSync(root, { recursive: true, force: true })
console.log('\n通过 ' + passed + ' 项')
