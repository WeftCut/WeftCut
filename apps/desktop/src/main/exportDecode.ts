// Native software export-decode sessions (blind-spot originals: ProRes, DNxHD,
// MPEG-2, VC-1; routing in ADR 0033). Each session is served on its own port,
// held by the export Worker (frameCarrier/decodeSessionHost.ts); this module owns admission:
// one session per id, and the decoder memory it reserves until it closes.

import type { WebContents } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import type { ExportDecodeOpenInfo } from '../shared/frameCarrier/wire'
import { documentOwner } from './frameCarrier/documentOwner'
import { hostDecodeSession, type CarrierPort } from './frameCarrier/decodeSessionHost'
import { reserveDecoderResources } from './resources'

export interface ExportDecodeRequest {
  sessionId: string
  path: string
  outFormat: 'NV12' | 'I420P10'
  /** Frames the session may have in flight before it waits for a release. */
  window: number
  /** The export's finalization, so its reservation borrows from the export's. */
  finalizationId?: number | undefined
}

const sessions = new Set<string>()

/** Opens a session served on `port` until its consumer closes it or `owner`'s
 * document goes away. Messages flow only after the first `range` command. A
 * refused session closes `port`. */
export function openExportDecode(
  backend: NativeDecode,
  owner: WebContents,
  port: CarrierPort,
  request: ExportDecodeRequest,
): ExportDecodeOpenInfo {
  const { sessionId, path, outFormat, window, finalizationId } = request
  let forget = () => {}
  try {
    if (sessions.has(sessionId)) throw new Error('Export decoder session already exists')
    const release = reserveDecoderResources(path, finalizationId)
    sessions.add(sessionId)
    forget = () => { sessions.delete(sessionId); release() }
    return hostDecodeSession({
      port,
      owner: documentOwner(owner),
      open: onMsg => backend.exportDecodeOpen(sessionId, path, outFormat, window, (err, msg) => {
        // A message the addon could not hand over is lost, so the range it
        // belonged to can no longer complete exactly once: fail it loudly.
        onMsg(err ? { kind: 'error', message: err.message, terminal: false } : msg)
      }),
      command: cmd => {
        if (cmd.type === 'range') backend.exportDecodeRange(sessionId, cmd.aUs, cmd.bUs)
        else backend.exportDecodeRelease(sessionId, cmd.lease)
      },
      close: () => {
        try { backend.exportDecodeClose(sessionId) }
        finally { forget() }
      },
    })
  } catch (error) {
    forget()
    port.close()
    throw error
  }
}
