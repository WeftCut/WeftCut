// Complete shared-texture reads off the UI thread. Transferring the bitmap to
// this worker preserves ownership; only return it after the GPU readback has
// finished, so main may safely reuse the source slot.
const SOURCE = `
let ctx;
self.onmessage = ({data: {id, bitmap}}) => {
  let error;
  try {
    ctx ??= new OffscreenCanvas(1, 1).getContext('2d', {willReadFrequently: true});
    if (!ctx) throw new Error('Motif read barrier unavailable');
    ctx.drawImage(bitmap, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
  } catch (e) { error = String(e); }
  self.postMessage({id, bitmap, error}, [bitmap]);
};`;

export class MotifReadBarrier {
  private worker: Worker | null = null
  private unavailable = false
  private sequence = 0
  private pending = new Map<number, { resolve(bitmap: ImageBitmap): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly fallback: (bitmap: ImageBitmap) => boolean) {}

  private fail(error: Error): void {
    this.unavailable = true
    this.worker?.terminate()
    this.worker = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  async complete(bitmap: ImageBitmap): Promise<ImageBitmap> {
    if (!this.worker && !this.unavailable) {
      const url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }))
      try {
        this.worker = new Worker(url)
        this.worker.onmessage = ({ data }: MessageEvent<{ id: number; bitmap: ImageBitmap; error?: string }>) => {
          const request = this.pending.get(data.id)
          if (!request) { data.bitmap.close(); return }
          this.pending.delete(data.id)
          clearTimeout(request.timer)
          if (data.error) {
            data.bitmap.close(); request.reject(new Error(data.error))
            this.fail(new Error(data.error))
          }
          else request.resolve(data.bitmap)
        }
        this.worker.onerror = () => this.fail(new Error('Motif read barrier worker failed'))
        this.worker.onmessageerror = () => this.fail(new Error('Motif read barrier message failed'))
      } catch { this.unavailable = true }
      finally { URL.revokeObjectURL(url) }
    }
    if (!this.worker) {
      if (!this.fallback(bitmap)) throw new Error('Motif texture read barrier unavailable')
      return bitmap
    }
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Motif read barrier timed out')), 2000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker!.postMessage({ id, bitmap }, [bitmap]) }
      catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error)
        this.fail(new Error('Motif read barrier transfer failed'))
      }
    })
  }
}
