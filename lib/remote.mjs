/**
 * 会话视图 <-> Host 的 RPC 服务。
 * 客户端调用：ctx.connection.rpc.call('/api', 'tokenTrim/<method>', { args: {} })
 *
 * 方法一律**不带参数**：窗口与按会话的筛选全部在客户端完成，
 * 避免 typert 网关按参数名做 strict 校验时出现字段不匹配。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildReport, buildBill } = require('./report.cjs')

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
}

for (const method of ['status', 'report', 'bill']) markRemoteMethod(TokenTrimRemoteService, method)
