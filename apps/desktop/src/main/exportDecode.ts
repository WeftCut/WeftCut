// Native software export-decode sessions (blind-spot originals: ProRes, DNxHD,
// MPEG-2, VC-1; routing in ADR 0033). Each session is served on its own port,
// held by the export Worker (frameCarrier/decodeSessionHost.ts). This module
// maps a session onto the addon's export calls and names the decoder memory it
// reserves; admission is frameCarrier/decodeSessionAdmission.ts.

import type { IpcMain, WebContents } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import type { ExportDecodeCommand, ExportDecodeOpenInfo, PlaneColor } from '../shared/frameCarrier/wire'
import { admitDecodeSession, type ConnectCarrier } from './frameCarrier/decodeSessionAdmission'
import { parseRelease } from './frameCarrier/decodeSessionHost'
import { ipcCarrierPort } from './frameCarrier/ipcCarrierPort'
import { reserveDecoderResources } from './resources'

export interface ExportDecodeRequest {
  sessionId: string
  path: string
  outFormat: 'NV12' | 'I420P10'
  /** Frames the session may have in flight before it waits for a release. */
  window: number
  /** The colour the session's planes carry. */
  color: PlaneColor
  /** The export's finalization, so its reservation borrows from the export's. */
  finalizationId?: number | undefined
}

/** What an export Worker's preload sends to open a session. */
export interface ExportDecodeOpenArgs extends Omit<ExportDecodeRequest, 'finalizationId'> {
  finalizationToken?: string
}

/** Registers `exportDecode:open`. `resolveFinalization` maps the export's
 * token to its finalization and throws when the token is stale; the session's
 * port exists only once it is admitted, so that throw leaves none behind. */
export function installExportDecodeIpc(
  ipc: Pick<IpcMain, 'handle'>,
  backend: () => NativeDecode,
  resolveFinalization: (senderId: number, token: unknown) => number | undefined,
): void {
  ipc.handle('exportDecode:open', (event, a: ExportDecodeOpenArgs) =>
    openExportDecode(backend(), event.sender, ipcCarrierPort, {
      sessionId: a.sessionId, path: a.path, outFormat: a.outFormat, window: a.window, color: a.color,
      finalizationId: resolveFinalization(event.sender.id, a.finalizationToken),
    }))
}

/** Opens a session served on the port `connect` creates, until its consumer
 * closes it or `owner`'s document goes away. Messages flow only after the
 * first `range` command. */
export function openExportDecode(
  backend: NativeDecode,
  owner: WebContents,
  connect: ConnectCarrier,
  request: ExportDecodeRequest,
): ExportDecodeOpenInfo {
  const { sessionId, path, outFormat, window, color, finalizationId } = request
  return admitDecodeSession({
    sessionId,
    connect,
    owner,
    reserve: () => reserveDecoderResources(path, finalizationId),
    open: onMsg => backend.exportDecodeOpen(sessionId, path, outFormat, window, color, (err, msg) => {
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
  }).info
}

function exportCommand(data: Record<string, unknown>): ExportDecodeCommand | null {
  if (data.type === 'range' && Number.isFinite(data.aUs) && Number.isFinite(data.bUs))
    return { type: 'range', aUs: data.aUs as number, bUs: data.bUs as number }
  return parseRelease(data)
}
