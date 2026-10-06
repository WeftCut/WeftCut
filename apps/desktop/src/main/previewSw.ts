// Main-process manager for native SOFTWARE-decode preview sessions (the
// WebCodecs-blind-format path: ProRes/DNxHD/MPEG-2/VC-1 — no shared-texture
// GPU pool, no proxy). MUCH simpler than previewGpu.ts: each decoded NV12
// frame ships as a plain napi Buffer through the addon's per-stream
// ThreadsafeFunction callback, which we relay straight to the renderer over a
// dedicated `previewSw:frame` channel. Renderer acceptance returns a receipt
// to the native producer; in-flight bytes remain charged through napi and IPC.
// Sessions close when their renderer disappears or navigates away.
import type { BrowserWindow } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import { reserveDecoderResources } from './resources'

const sessions = new Map<string, { win: BrowserWindow; cleanup: () => void; release: () => void }>()

/// Open a native SW-decode session. Synchronous on the addon side: returns
/// frame dimensions immediately, and registers the frame callback BEFORE the
/// decode thread spawns, so no early frame is dropped. Frames only start
/// flowing after `requestFrameAtPreviewSw`.
///
/// `lane`/`device` optionally select a HARDWARE copy-back lane (Linux
/// NVDEC/VAAPI, `device` = the DRM node for VAAPI) that rides this SAME
/// transport as software — hw accel, then copy-back to the identical NV12
/// frames. A null `lane` = software decode; the frame contract the callback
/// relays is identical either way.
///
/// `scaleDiv` is the playback-resolution divisor (1 | 2 | 4; null = 1 = full):
/// native swscales each frame DOWN before packing, so a 4K frame crosses this
/// IPC at a fraction of its 12.44 MB. The returned dimensions and every relayed
/// frame report the SHIPPED size — native owns that math.
///
/// `cadenceDiv` selects producer output cadence (null = 1 = every frame).
/// Native skips unselected frames before copy-back/swscale/packing and IPC.
///
/// `outFormat` selects the session's CPU transport format (null = 'NV12'):
/// 'I420P10' opens 10-bit output — the renderer asks for it on the
/// videotoolbox lane for a 10-bit source (issue #10) — and every
/// relayed frame carries the matching `format` tag.
export function openPreviewSw(
  backend: NativeDecode,
  win: BrowserWindow,
  streamId: string,
  path: string,
  lane: string | null,
  device: string | null,
  scaleDiv: number | null,
  cadenceDiv: number | null,
  outFormat: string | null,
): { width: number; height: number } {
  if (sessions.has(streamId)) throw new Error('Decoder session already exists')
  const release = reserveDecoderResources(path)
  try {
  const info = backend.previewSwOpen(streamId, path, (err: Error | null, frame) => {
    if (err || win.isDestroyed() || win.webContents.isDestroyed()) {
      closePreviewSw(backend, streamId)
      return
    }
    try { win.webContents.send('previewSw:frame', frame) }
    catch { closePreviewSw(backend, streamId) }
  }, lane, device, scaleDiv, cadenceDiv, outFormat)
  try { backend.previewSwEnableFlow(streamId) }
  catch (error) { backend.previewSwClose(streamId); throw error }
  const stop = () => closePreviewSw(backend, streamId)
  win.webContents.once('destroyed', stop)
  win.webContents.once('render-process-gone', stop)
  // Reload releases the old renderer's receipts and decoder session too.
  win.webContents.on('did-start-navigation', navigation)
  function navigation(details: { isMainFrame: boolean; isSameDocument: boolean }) {
    if (details.isMainFrame && !details.isSameDocument) stop()
  }
  sessions.set(streamId, { win, release, cleanup: () => {
    win.webContents.removeListener('destroyed', stop)
    win.webContents.removeListener('render-process-gone', stop)
    win.webContents.removeListener('did-start-navigation', navigation)
  } })
  return { width: info.width, height: info.height }
  } catch (error) { release(); throw error }
}

export function consumePreviewSw(backend: NativeDecode, senderId: number, streamId: string, receipt: number): void {
  if (sessions.get(streamId)?.win.webContents.id === senderId) backend.previewSwConsume(streamId, receipt)
}

/// Move the session's decode anchor. targetUs is source microseconds; the
/// addon takes it as f64 (napi has no ergonomic i64 param) and casts down
/// internally. Fire-and-forget: frames arrive via the registered callback.
export function requestFrameAtPreviewSw(backend: NativeDecode, streamId: string, targetUs: number, requestId?: number): void {
  backend.previewSwRequestFrameAt(streamId, targetUs, requestId)
}

/// Tear down a session. Delegates straight to the addon, which closes+joins
/// the decode thread before dropping the per-stream ThreadsafeFunction.
export function closePreviewSw(backend: NativeDecode, streamId: string): void {
  const session = sessions.get(streamId)
  if (!session) return
  sessions.delete(streamId)
  session.cleanup()
  try { backend.previewSwClose(streamId) } finally { session.release() }
}
