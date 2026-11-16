// 回放 worker：把「解压会话日志 + 逐 step 计费」移出宿主主线程。
// 主线程每 2–5 秒会处理 UI/RPC，同步解压 10MB 日志会把它卡住，所以这里单独一个 worker，
// 并保持常驻，让解析缓存（parseCache）在多次回放之间复用。
import { parentPort } from 'node:worker_threads'
import { replayAll } from './replay.mjs'

parentPort.on('message', (message) => {
  const { id, manifest, sessionsRoot } = message || {}
  try {
    const result = replayAll({ manifest, sessionsRoot })
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message ? error.message : error) })
  }
})
