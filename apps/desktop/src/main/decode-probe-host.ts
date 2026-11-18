import { createRequire } from 'node:module'
import { loadNativeDecode } from './native-decode'
import type { DecodeProbeRequest } from './decodeProbeProcess'

// A one-shot macOS host. Loading the addon is inside the parent's deadline,
// too. Do not import Electron main bootstrap or create a window here.
const port = process.parentPort
function finish(message: object, code: number) {
  port.once('message', event => {
    if (event.data?.type === 'ack') process.exit(code)
  })
  port.postMessage(message)
}
port.once('message', event => {
  const request = event.data as DecodeProbeRequest
  if (request?.lane !== 'videotoolbox' || typeof request.path !== 'string') {
    finish({ type: 'failed' }, 1)
    return
  }
  try {
    const native = loadNativeDecode()
    if (!native.backend || !native.lanes.includes('videotoolbox')) {
      finish({ type: 'failed' }, 1)
      return
    }
    const addon = createRequire(import.meta.url)('@weftcut/native-decode') as { configureDecodeThreads(threads: number): void }
    addon.configureDecodeThreads(1)
    // The native timeout is advisory. The parent enforces the real deadline
    // and can terminate us even when VideoToolbox never returns.
    const verdict = native.backend.previewHwProbe(request.path, request.lane, null, 4_000)
    finish({ type: 'result', verdict: { ok: verdict.ok, reason: verdict.reason ?? null } }, 0)
  } catch { finish({ type: 'failed' }, 1) }
})
port.postMessage({ type: 'ready' })
