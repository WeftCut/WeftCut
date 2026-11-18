// Native software export-decode sessions (blind-spot originals: ProRes, DNxHD,
// MPEG-2, VC-1; routing in ADR 0033). Each session is served on its own port,
// held by the export Worker (frameCarrier/decodeSessionHost.ts). This module
// maps a session onto the addon's export calls and names the decoder memory it
// reserves; admission is frameCarrier/decodeSessionAdmission.ts.

import type { WebContents } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import type { ExportDecodeCommand, ExportDecodeOpenInfo } from '../shared/frameCarrier/wire'
import { admitDecodeSession } from './frameCarrier/decodeSessionAdmission'
import { parseRelease, type CarrierPort } from './frameCarrier/decodeSessionHost'
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

/** Opens a session served on `port` until its consumer closes it or `owner`'s
 * document goes away. Messages flow only after the first `range` command. */
export function openExportDecode(
  backend: NativeDecode,
  owner: WebContents,
  port: CarrierPort,
  request: ExportDecodeRequest,
): ExportDecodeOpenInfo {
  const { sessionId, path, outFormat, window, finalizationId } = request
  return admitDecodeSession({
    sessionId,
    port,
    owner,
    reserve: () => reserveDecoderResources(path, finalizationId),
    open: onMsg => backend.exportDecodeOpen(sessionId, path, outFormat, window, (err, msg) => {
      // A message the addon could not hand over is lost, so the range it
      // belonged to can no longer complete exactly once: fail it loudly.
      onMsg(err ? { kind: 'error', message: err.message, terminal: false } : msg)
    }),
    parse: exportCommand,
    command: cmd => {
      if (cmd.type === 'range') backend.exportDecodeRange(sessionId, cmd.aUs, cmd.bUs)
      else backend.exportDecodeRelease(sessionId, cmd.lease)
    },
    close: () => backend.exportDecodeClose(sessionId),
  })
}

function exportCommand(data: Record<string, unknown>): ExportDecodeCommand | null {
  if (data.type === 'range' && Number.isFinite(data.aUs) && Number.isFinite(data.bUs))
    return { type: 'range', aUs: data.aUs as number, bUs: data.bUs as number }
  return parseRelease(data)
}
