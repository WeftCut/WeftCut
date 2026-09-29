import { ipcRenderer, type SharedTextureImported } from 'electron'
import type { StoredMotifFrame, MotifCaptureControl } from '../shared/motifs/frameTransport'

// ImageBitmap cannot cross contextBridge. A same-renderer MessagePort transfers
// ownership to the main world without serializing pixels or changing isolation.
export function installMotifFrames(
  imported: (key: string) => SharedTextureImported | undefined,
  finishRead: (bitmap: ImageBitmap) => Promise<ImageBitmap>,
): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'weftcut:motif-frame-port') return
    const port = event.ports[0]
    if (!port) return
    port.onmessage = async ({ data }: MessageEvent<{ id: number; hash: string; frame: number; capture?: Record<string, unknown>; control?: MotifCaptureControl }>) => {
      if (data.control) { ipcRenderer.send('motif:capture-control', data.control); return }
      let frame: StoredMotifFrame | null = null
      let bitmap: ImageBitmap | null = null
      let failed = true
      try {
        frame = await ipcRenderer.invoke(data.capture ? 'motif:capture' : 'motif:read', data.capture ?? { hash: data.hash, frame: data.frame }) as StoredMotifFrame | null
        if (frame?.kind === 'texture') {
          const texture = imported(frame.key)
          if (!texture) throw new Error('Motif texture import missing')
          const vf = texture.getVideoFrame()
          try { bitmap = await createImageBitmap(vf) } finally { vf.close() }
          bitmap = await finishRead(bitmap)
        } else if (frame?.kind === 'rgba') {
          const pixels = new Uint8ClampedArray(frame.rgba.buffer as ArrayBuffer, frame.rgba.byteOffset, frame.rgba.byteLength)
          bitmap = await createImageBitmap(new ImageData(pixels, frame.width, frame.height))
        } else if (frame?.kind === 'png') {
          bitmap = await createImageBitmap(new Blob([frame.bytes as BlobPart], { type: 'image/png' }))
        }
        port.postMessage({ id: data.id, bitmap, persisted: frame?.persisted === true }, bitmap ? [bitmap] : [])
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
