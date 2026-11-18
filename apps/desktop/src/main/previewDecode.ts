// Native preview decode sessions: the software lane and the copy-back hardware
// lanes (NVDEC, VAAPI, VideoToolbox), all shipping frame bytes (ADR 0029).
// Each session is served on its own port, held by the renderer's preload and
// read by the page's `SwTransport` (frameCarrier/decodeSessionHost.ts). This
// module maps a session onto the addon's preview calls and names the decoder
// memory it reserves; admission is frameCarrier/decodeSessionAdmission.ts.

import type { WebContents } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import type { PlaneColor, PreviewDecodeCommand, PreviewDecodeOpenInfo, PreviewDecodeOptions } from '../shared/frameCarrier/wire'
import { admitDecodeSession } from './frameCarrier/decodeSessionAdmission'
import { parseRelease, type CarrierPort } from './frameCarrier/decodeSessionHost'
import { reserveDecoderResources } from './resources'

export interface PreviewDecodeRequest {
  sessionId: string
  path: string
  color: PlaneColor
  options: PreviewDecodeOptions
}

/** Opens a session served on `port` until its consumer closes it or `owner`'s
 * document goes away. Frames flow only after the first `request` command. */
export function openPreviewDecode(
  backend: NativeDecode,
  owner: WebContents,
  port: CarrierPort,
  request: PreviewDecodeRequest,
): PreviewDecodeOpenInfo {
  const { sessionId, path, color, options } = request
  return admitDecodeSession({
    sessionId,
    port,
    owner,
    reserve: () => reserveDecoderResources(path),
    open: onMsg => backend.previewDecodeOpen(sessionId, path, options, color, (err, msg) => {
      // A frame the addon could not hand over keeps its lease in flight for
      // good, so the session is no longer whole: end it.
      onMsg(err ? { kind: 'error', message: err.message, terminal: true } : msg)
    }),
    parse: previewCommand,
    command: cmd => {
      if (cmd.type === 'request') backend.previewDecodeFillFrom(sessionId, cmd.targetUs, cmd.requestId)
      else backend.previewDecodeRelease(sessionId, cmd.lease)
    },
    close: () => backend.previewDecodeClose(sessionId),
  }).info
}

function previewCommand(data: Record<string, unknown>): PreviewDecodeCommand | null {
  const { requestId } = data
  if (data.type === 'request' && Number.isFinite(data.targetUs)
    && Number.isInteger(requestId) && (requestId as number) >= 0 && (requestId as number) <= 0xffff_ffff)
    return { type: 'request', targetUs: data.targetUs as number, requestId: requestId as number }
  return parseRelease(data)
}
