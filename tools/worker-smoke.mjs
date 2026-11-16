import { Worker } from 'node:worker_threads'
import os from 'node:os'
import path from 'node:path'

const file = new URL('../lib/replay-worker.mjs', import.meta.url)
const started = Date.now()
const worker = new Worker(file)
worker.on('message', (message) => {
  if (message.error) console.log('ERR', message.error)
  else {
    const t = message.result.totals
    console.log('worker ms', Date.now() - started, 'total', t.totalPct.toFixed(2), 'legacy', t.legacy)
  }
  worker.terminate()
})
worker.postMessage({
  id: 1,
  manifest: path.join(os.homedir(), '.dsh/token-trim/manifest.jsonl'),
  sessionsRoot: path.join(os.homedir(), '.dsh/sessions'),
})
