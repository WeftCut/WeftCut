import { ipcRenderer, type SharedTextureImported } from 'electron'
import type { StoredMotifFrame, MotifCaptureControl, MotifReadUnavailable, MotifTextureReadRequest } from '../shared/motifs/frameTransport'
import { MOTIF_READER_CONNECT, MOTIF_READER_PORT, MOTIF_READER_RESET, type MotifReaderDiv } from '../shared/motifs/readerProtocol'

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
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.type === 'weftcut:motif-reader-connect') { ipcRenderer.send(MOTIF_READER_CONNECT); return }
    if (event.data?.type !== 'weftcut:motif-frame-port') return
    const port = event.ports[0]
    if (!port) return
    port.onmessage = async ({ data }: MessageEvent<{ id: number; hash: string; frame: number; div: MotifReaderDiv; finalizationToken?: string; capture?: Record<string, unknown>; control?: MotifCaptureControl }>) => {
      if (data.control) { ipcRenderer.send('motif:capture-control', data.control); return }
      let frame: StoredMotifFrame | MotifReadUnavailable | null = null
      let bitmap: ImageBitmap | null = null
      let failed = true
      try {
        const read: MotifTextureReadRequest = { hash: data.hash, frame: data.frame, div: data.div, finalizationToken: data.finalizationToken }
        frame = await ipcRenderer.invoke(data.capture ? 'motif:capture' : 'motif:read', data.capture ?? read) as StoredMotifFrame | MotifReadUnavailable | null
        // Not a miss and not a failure: the reader reads it on the utility lane.
        if (frame?.kind === 'unavailable') {
          port.postMessage({ id: data.id, unavailable: true })
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
        } else if (frame?.kind === 'rgba') {
          const pixels = new Uint8ClampedArray(frame.rgba.buffer as ArrayBuffer, frame.rgba.byteOffset, frame.rgba.byteLength)
          bitmap = await createImageBitmap(new ImageData(pixels, frame.width, frame.height))
        } else if (frame?.kind === 'png') {
          bitmap = await createImageBitmap(new Blob([frame.bytes as BlobPart], { type: 'image/png' }))
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
        port.postMessage({ id: data.id, error: String(error) })
      } finally {
        bitmap?.close()
        if (frame?.kind === 'texture') ipcRenderer.send('motif:ack', { token: frame.token, failed })
      }
    }
    port.start()
  })
}
