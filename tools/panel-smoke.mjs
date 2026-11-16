// 客户端面板渲染冒烟测试：在 Node 里用"迷你 React"真的跑一遍挂载 → 拉数据 → 重渲染，
// 这样「黑屏」能复现成一条异常或一棵空树，而不是只能靠肉眼。
// 运行：node tools/panel-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client/panel.js'), 'utf8')

let captured = null
const styleEl = { dataset: {}, style: {}, remove() {} }
const sandbox = {
  console,
  window: { __ModuleLoader__: { load(options) { captured = options } } },
  document: {
    createElement: () => styleEl,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  },
  setInterval: () => 0,
  clearInterval: () => {},
  Date,
  Math,
  JSON,
}
sandbox.globalThis = sandbox

// ---- 迷你 React：useState 真的会触发重渲染，useEffect 会在渲染后执行 ----
let states = []
let effectSlots = {}
let memos = {}
let refs = {}
let cursor = 0
let dirty = false

function shallowEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props || {}, { children: children.length <= 1 ? children[0] : children }) }
  },
  useState(initial) {
    const index = cursor++
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
    return [states[index], (next) => {
      const value = typeof next === 'function' ? next(states[index]) : next
      if (value !== states[index]) { states[index] = value; dirty = true }
    }]
  },
  useEffect(fn, deps) {
    const index = cursor++
    const previous = effectSlots[index]
    if (!previous || !deps || !shallowEqual(previous.deps, deps)) {
      effectSlots[index] = { deps, fn, run: true }
    }
  },
  useCallback(fn, deps) {
    const index = cursor++
    const previous = memos[index]
    if (!previous || !deps || !shallowEqual(previous.deps, deps)) {
      memos[index] = { deps, fn }
      return fn
    }
    return previous.fn
  },
  useRef(value) {
    const index = cursor++
    if (!(index in refs)) refs[index] = { current: value }
    return refs[index]
  },
}

const require = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client/panel.js' })
if (!captured) throw new Error('module did not register')

const moduleExports = captured.factory(require)
const dict = {
  label: '节省', title: '账单节省', subtitle: 'sub', liveTitle: '净节省', compaction: '压缩',
  rules: '治理', rework: '返工', sample: '样本', aligned: '对齐', legacy: 'legacy', policy: '策略',
  modelTitle: '模型', modelNote: 'note', charsTitle: '明细', charsScope: '本窗口', events: '条', chars: '字符',
  savedChars: '省下', tokens: 'tok', denom: 'note', usageTitle: '用量', usageNote: 'note', usageHit: 'hit',
  usageMiss: 'miss', usageOut: 'out', usageCost: 'cost', sessionsTitle: '会话', recentTitle: '最近',
  refresh: '刷新', busy: '读取中', auto: '实时', paused: '暂停', updated: '更新于', replayBtn: '回放',
  replayBusy: '回放中', runAll: '全部', runThis: '本会话', empty: '空', none: '无', dry: 'dry',
  error: '错误', tool: '工具', count: '次数', last: '最近', focus: '聚焦', clear: '取消',
  allTime: '全部', days7: '7天', days30: '30天', stale: '待更新', eq: '即',
}
const t = (key) => dict[key] || key

const reportModule = await import('../lib/report.cjs').then((m) => m.default ?? m)
const manifest = path.join(os.homedir(), '.dsh/token-trim/manifest.jsonl')
const reportData = reportModule.buildReport({ manifest, artifactDir: path.join(os.homedir(), '.dsh/token-trim/artifacts') })
const billData = reportModule.buildBill({ manifest })
const replayData = await import('../lib/replay.mjs').then((m) => m.replayAll({
  manifest,
  sessionsRoot: path.join(os.homedir(), '.dsh/sessions'),
}))

const ctx = {
  effect(fn) { fn() },
  locale: { register() {}, bind() { return (key) => t(key) }, getLocale() { return { id: 'zh' } } },
  connection: {
    rpc: {
      call(_url, method) {
        const name = String(method).split('/').pop()
        const value = name === 'report' ? reportData : name === 'bill' ? billData
          : name === 'replay' ? replayData : { available: true, manifest, artifactDir: 'x', dryRun: false }
        return Promise.resolve({ ok: true, value })
      },
    },
  },
  slots: {
    inject(_name, fn) { fn() },
    register(def, Component) { captured.component = Component; captured.def = def; return () => {} },
  },
}

moduleExports.apply(ctx)
if (!captured.component) throw new Error('panel was not registered')

const props = Object.assign({ sessionId: 'session-test' }, captured.def.inject())
const Panel = captured.component

function runEffects() {
  for (const entry of Object.values(effectSlots)) {
    if (!entry || !entry.run) continue
    entry.run = false
    entry.fn()
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

let tree = null
try {
  for (let round = 0; round < 40; round += 1) {
    cursor = 0
    tree = Panel(props)
    runEffects()
    await tick()
    await tick()
    if (!dirty) break
    dirty = false
  }
} catch (error) {
  console.error('render threw:', error && error.stack ? error.stack : error)
  process.exit(1)
}

const text = []
const collect = (node) => {
  if (node == null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (typeof node === 'object') collect(node.props && node.props.children)
}
collect(tree)

console.log('render ok · text nodes', text.length)
console.log(text.join(' | ').slice(0, 700))
if (text.length < 5) {
  console.error('\nFAIL: too little output — the panel rendered an empty tree')
  process.exit(1)
}
