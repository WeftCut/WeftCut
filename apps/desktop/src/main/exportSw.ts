// Main-process manager for native SOFTWARE export-decode sessions — the
// EXPORT-side mirror of previewSw.ts (blind-spot originals: ProRes/DNxHD/
// MPEG-2/VC-1). The addon delivers EVERYTHING in-band on the per-session
// ThreadsafeFunction callback as a tagged `ExportSwMsg` — frames AND the
// rangeEnd/ended/error control signals — which we relay verbatim to the
// renderer over the one dedicated `exportSw:msg` channel; the callback
// captures `win`, so routing is automatic. Never split this into a second
// channel — delivery order is the contract (see `ExportSwMsg` in shared/ipc).
// Unlike previewSw this runs under the exactly-once range contract + credit window
// (decodeRange / returnCredit). The module-level `sessions` Set exists for
// orphan reclaim: ONE export spawns several concurrent sessions (one per phase
// group), so a renderer crash/reload mid-export can leave native threads alive
// with no owner — closeAllExportSw reaps them.
import type { BrowserWindow, WebContents } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import type { ExportSwOpenReply } from '../shared/ipc'
import { reserveDecoderResources } from './resources'

const sessions = new Set<string>()
const resources = new Map<string, () => void>()
const sessionOwners = new Map<string, number>()
const owners = new Map<number, { sessions: Set<string>; detach: () => void }>()

function trackOwner(backend: NativeDecode, contents: WebContents, sessionId: string): void {
  let owner = owners.get(contents.id)
  if (!owner) {
    const clear = () => {
      for (const id of [...(owners.get(contents.id)?.sessions ?? [])]) {
        try { closeExportSw(backend, id) }
        catch (error) { console.warn('[main] exportSw owner cleanup failed', id, error) }
      }
    }
    const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) clear()
    }
    owner = { sessions: new Set(), detach: () => {
      contents.removeListener('destroyed', clear)
      contents.removeListener('render-process-gone', clear)
      contents.removeListener('did-start-navigation', navigation)
    } }
    owners.set(contents.id, owner)
    contents.once('destroyed', clear)
    contents.once('render-process-gone', clear)
    contents.on('did-start-navigation', navigation)
  }
  owner.sessions.add(sessionId)
  sessionOwners.set(sessionId, contents.id)
}

/// Open a native export-decode session. Synchronous on the addon side: the
/// message callback is registered BEFORE the decode thread spawns, so no early
/// message is dropped, and dimensions + source color tags + start PTS return
/// immediately. Messages only start flowing after `decodeRangeExportSw`.
export function openExportSw(
  backend: NativeDecode,
  win: BrowserWindow,
  sessionId: string,
  path: string,
  outFormat: 'NV12' | 'I420P10',
  creditWindow: number,
): ExportSwOpenReply {
  if (sessions.has(sessionId)) throw new Error('Export decoder session already exists')
  const release = reserveDecoderResources(path)
  try {
  const info = backend.exportSwOpen(sessionId, path, outFormat, creditWindow, (err, msg) => {
    if (err) return
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('exportSw:msg', msg)
  })
  sessions.add(sessionId)
  resources.set(sessionId, release)
  trackOwner(backend, win.webContents, sessionId)
  return {
    width: info.width,
    height: info.height,
    colorMatrix: info.colorMatrix,
    colorRange: info.colorRange,
    colorPrimaries: info.colorPrimaries,
    colorTransfer: info.colorTransfer,
    startPtsUs: info.startPtsUs,
  }
  } catch (error) { release(); throw error }
}

/// Decode the presentation range [aUs, bUs] (source-normalized µs, b inclusive).
/// aUs/bUs cross as f64 (napi has no ergonomic i64 param) and cast down
/// internally. Fire-and-forget: frames arrive on the registered callback,
/// followed in-band by a `rangeEnd` (or `ended` then `rangeEnd` at stream end).
export function decodeRangeExportSw(backend: NativeDecode, sessionId: string, aUs: number, bUs: number): void {
  backend.exportSwDecodeRange(sessionId, aUs, bUs)
}

/// Return `credits` consumed frames to the session, resuming a producer parked
/// on an exhausted credit window. Safe while a range is in flight.
export function returnCreditExportSw(backend: NativeDecode, sessionId: string, credits: number): void {
  backend.exportSwReturnCredit(sessionId, credits)
}

/// Tear down a session. Delegates to the addon, which closes+joins the decode
/// thread (unblocking any producer parked on the credit window) before dropping
/// the per-session callback. Untrack it either way.
export function closeExportSw(backend: NativeDecode, sessionId: string): void {
  try { backend.exportSwClose(sessionId) } finally {
    sessions.delete(sessionId); resources.get(sessionId)?.(); resources.delete(sessionId)
    const ownerId = sessionOwners.get(sessionId)
    sessionOwners.delete(sessionId)
    if (ownerId !== undefined) {
      const owner = owners.get(ownerId)
      owner?.sessions.delete(sessionId)
      if (owner && !owner.sessions.size) { owner.detach(); owners.delete(ownerId) }
    }
  }
}

/// Defensive orphan reclaim — reap every session the renderer left behind if it
/// crashed/reloaded mid-export (an export's per-phase-group sessions have no
/// other owner). Per-id try/catch so one already-dead session can't abort the
/// sweep; the Set is cleared regardless.
export function closeAllExportSw(backend: NativeDecode, ownerId?: number): void {
  for (const id of sessions) {
    if (ownerId !== undefined && sessionOwners.get(id) !== ownerId) continue
    try { closeExportSw(backend, id) }
    catch (e) { console.warn('[main] exportSw orphan reclaim failed', id, e) }
  }
}
