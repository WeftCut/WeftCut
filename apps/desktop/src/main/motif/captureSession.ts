// The session every Motif capture host runs in: its own in-memory partition,
// apart from the editor's, whose network and permission rules the main
// process enforces (docs/security.md#motif-documents). Owns the partition and
// its rules; the `motif:` handler it serves is protocol.ts's, and the hosts
// get the session through their deps (`MotifCapturerDeps.session`).
import { session, type Session } from 'electron'
import type { MotifProtocolHandler } from './protocol.js'

/** In-memory (no `persist:` prefix): a Motif leaves no cookies, storage or
 *  cache on disk, and nothing in it outlives the app. */
const MOTIF_CAPTURE_PARTITION = 'motif-capture'

/** Every URL a Motif could reach outside the app; other schemes have no
 *  handler in this partition. The listener runs only for these, but while it
 *  exists Electron routes every request of the session, `motif:` included,
 *  through its request proxy: a fraction of a millisecond each, which a host
 *  build's few dozen loads absorb. */
const MOTIF_BLOCKED_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] as const

/** Makes the capture partition: serves `motif:` through `handler`, refuses
 *  every outside URL and every permission. Once, after `app` is ready: a
 *  second call throws in `protocol.handle`.
 *  The CSP already refuses the same URLs; this holds when a compromised
 *  renderer ignores its CSP, since the browser process enforces it. */
export function installMotifCaptureSession(handler: MotifProtocolHandler): Session {
  const ses = session.fromPartition(MOTIF_CAPTURE_PARTITION)
  ses.protocol.handle('motif', handler)
  ses.webRequest.onBeforeRequest({ urls: [...MOTIF_BLOCKED_URLS] }, (_details, callback) => callback({ cancel: true }))
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  ses.on('will-download', (event) => event.preventDefault())
  return ses
}
