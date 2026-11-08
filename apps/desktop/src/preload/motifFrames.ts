import { ipcRenderer, type SharedTextureImported } from 'electron'
import type { MotifCaptureControl, MotifCaptureReply, MotifCaptureRequest, MotifReadUnavailable, MotifTextureReadRequest } from '../shared/motifs/frameTransport'
import { MOTIF_READER_CONNECT, MOTIF_READER_PORT, MOTIF_READER_RESET, MOTIF_TEXTURE_LANE_RESET, type MotifReaderDiv } from '../shared/motifs/readerProtocol'
import { decodeMotifError, MotifError } from '../shared/motifs/errors'

// ImageBitmap cannot cross contextBridge. A same-renderer MessagePort transfers
// ownership to the main world without serializing pixels or changing isolation.
export function installMotifFrames(
  imported: (key: string) => SharedTextureImported | undefined,
  finishRead: (bitmap: ImageBitmap) => Promise<ImageBitmap>,
): void {
  // The Motif reader utility's port goes to the page, which hands it to its
  // reader worker (ADR 0154); pixels never pass through here.
  ipcRenderer.on(MOTIF_READER_PORT, event => window.postMessage({ type: 'weftcut:motif-reader-port' }, '*', event.ports))
  ipcRenderer.on(MOTIF_READER_RESET, () => window.postMessage({ type: 'weftcut:motif-reader-reset' }, '*'))
  ipcRenderer.on(MOTIF_TEXTURE_LANE_RESET, (_event, generation: unknown) => {
    if (typeof generation === 'number') window.postMessage({ type: 'weftcut:motif-texture-lane-reset', generation }, '*')
  })
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.type === 'weftcut:motif-reader-connect') { ipcRenderer.send(MOTIF_READER_CONNECT); return }
    if (event.data?.type !== 'weftcut:motif-frame-port') return
    const port = event.ports[0]
    if (!port) return
    port.onmessage = async ({ data }: MessageEvent<{ id: number; hash: string; frame: number; div: MotifReaderDiv; finalizationToken?: string; capture?: MotifCaptureRequest; control?: MotifCaptureControl }>) => {
      // Same IPC sender as the request it follows, so main receives it after.
      if (data.control) { ipcRenderer.send('motif:capture-control', data.control); return }
      let frame: MotifCaptureReply | MotifReadUnavailable | null = null
      let bitmap: ImageBitmap | null = null
      let failed = true
      try {
        const read: MotifTextureReadRequest = { hash: data.hash, frame: data.frame, div: data.div, finalizationToken: data.finalizationToken }
        frame = await ipcRenderer.invoke(data.capture ? 'motif:capture' : 'motif:read', data.capture ?? read) as MotifCaptureReply | MotifReadUnavailable | null
        // Withdrawn in main: not a failure (`MotifCaptureReply`).
        if (frame?.kind === 'superseded') {
          port.postMessage({ id: data.id, superseded: true })
          failed = false
          return
        }
        // Not a miss and not a failure: the reader reads it on the utility lane.
        if (frame?.kind === 'unavailable') {
          port.postMessage({ id: data.id, unavailable: frame.reason, generation: frame.generation })
          failed = false
          return
        }
        let importMs: number | undefined
        if (frame?.kind === 'texture') {
          const start = performance.now()
          const texture = imported(frame.key)
          if (!texture) throw new Error('Motif texture import missing')
          const vf = texture.getVideoFrame()
          try { bitmap = await createImageBitmap(vf) } finally { vf.close() }
          bitmap = await finishRead(bitmap)
          importMs = performance.now() - start
        } else if (frame?.kind === 'pixels') {
          const rgba = new Uint8ClampedArray(frame.bytes.buffer as ArrayBuffer, frame.bytes.byteOffset, frame.bytes.byteLength)
          bitmap = await createImageBitmap(new ImageData(rgba, frame.width, frame.height))
        }
        // `stored`: no pixels; the renderer reads the frame through its reader.
        port.postMessage({
          id: data.id, bitmap, persisted: frame?.persisted === true,
          ...(frame?.kind === 'stored' ? { stored: true } : {}),
          ...(frame?.kind === 'texture' ? { timing: frame.timing, importMs } : {}),
        }, bitmap ? [bitmap] : [])
        bitmap = null
        failed = false
      } catch (error) {
        // The page cannot see the class; the code crosses beside the detail.
        const failure = decodeMotifError(error)
        port.postMessage(failure instanceof MotifError
          ? { id: data.id, error: failure.detail, code: failure.code }
          : { id: data.id, error: String(error) })
      } finally {
        bitmap?.close()
        if (frame?.kind === 'texture') ipcRenderer.send('motif:ack', { token: frame.token, failed })
      }
    }
    port.start()
  })
}
