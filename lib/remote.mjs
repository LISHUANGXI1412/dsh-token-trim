/**
 * 会话视图 <-> Host 的 RPC 服务。
 * 客户端调用：ctx.connection.rpc.call('/api', 'tokenTrim/<method>', { args: {} })
 *
 * 方法一律**不带参数**：窗口与按会话的筛选全部在客户端完成，
 * 避免 typert 网关按参数名做 strict 校验时出现字段不匹配。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const { buildReport, buildBill } = require('./report.cjs')

// 回放常驻 worker：解压 10MB 日志要 4–5 秒，放在主线程会卡住整个 UI 的 RPC。
let replayWorker = null
let replaySeq = 0
const replayWaiters = new Map()

function getReplayWorker() {
  if (replayWorker) return replayWorker
  replayWorker = new Worker(new URL('./replay-worker.mjs', import.meta.url))
  replayWorker.on('message', (message) => {
    const waiter = replayWaiters.get(message && message.id)
    if (!waiter) return
    replayWaiters.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error))
    else waiter.resolve(message.result)
  })
  replayWorker.on('error', (error) => {
    for (const waiter of replayWaiters.values()) waiter.reject(error)
    replayWaiters.clear()
    replayWorker = null
  })
  // 不要让 worker 拖住进程退出
  if (typeof replayWorker.unref === 'function') replayWorker.unref()
  return replayWorker
}

function replayInWorker(manifest, sessionsRoot) {
  const id = ++replaySeq
  return new Promise((resolve, reject) => {
    replayWaiters.set(id, { resolve, reject })
    try {
      getReplayWorker().postMessage({ id, manifest, sessionsRoot })
    } catch (error) {
      replayWaiters.delete(id)
      replayWorker = null
      reject(error)
    }
  })
}

export function markRemoteMethod(serviceClass, method, exportName = method) {
  const instance = Object.create(serviceClass.prototype)
  const decorate = Remote(exportName)
  decorate(undefined, {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(fn) {
      fn.call(instance)
    },
  })
}

export class TokenTrimRemoteService extends TypertRemoteService {
  static inject = []

  constructor(ctx, config = {}) {
    super(ctx, 'tokenTrim')
    this.manifest = config.manifest
    this.artifactDir = config.artifactDir
    this.dryRun = config.dryRun === true
    this.caps = config.caps ?? {}
  }

  status() {
    const report = buildReport({
      manifest: this.manifest,
      artifactDir: this.artifactDir,
      dryRun: this.dryRun,
    })
    return {
      available: report.available,
      manifest: this.manifest,
      artifactDir: this.artifactDir,
      dryRun: this.dryRun,
      records: report.records ?? 0,
      totals: report.totals ?? null,
      caps: this.caps,
    }
  }

  report() {
    return buildReport({
      manifest: this.manifest,
      artifactDir: this.artifactDir,
      dryRun: this.dryRun,
    })
  }

  /** 账单口径：配置级估算 + 实测用量 + 疑似返工扣减。 */
  bill() {
    return buildBill({ cache: this.usageCache, manifest: this.manifest })
  }

  /**
   * 反事实回放（按需触发）：读真实会话日志，逐 step 计算"没有本次改写时"的账单。
   * 只对齐有 session id 的改写；legacy 行只计数。在 worker 里跑，不阻塞 UI。
   */
  async replay() {
    return replayInWorker(this.manifest, path.join(homedir(), '.dsh', 'sessions'))
  }
}

for (const method of ['status', 'report', 'bill', 'replay']) markRemoteMethod(TokenTrimRemoteService, method)
