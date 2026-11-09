import type { NativeImage, OffscreenSharedTexture, WebContents } from 'electron'
import { decodeFrameMarker, FRAME_MARKER_READ_PIXELS, frameMarkerRows, frameWitnessed } from '../../shared/motifs/frameMarker.js'
import type { MotifMarkerReader } from './native.js'

/** A leased capture and the picture size it holds above the marker rows. A
 * texture host's shared texture is released by its holder; a bitmap host's
 * paint is premultiplied BGRA (`NativeImage.toBitmap`). */
export type MotifOsrFrame =
  | { kind: 'texture'; texture: OffscreenSharedTexture; width: number; height: number }
  | { kind: 'bitmap'; image: NativeImage; width: number; height: number }

/** A paint carrying a later frame's id arrived first, or this frame's paint
 * lacks the page's canvases: the compositor never showed this frame whole and
 * never will. Rendering it again shows it. */
export class MotifFrameSkippedError extends Error {
  constructor(id: number) { super(`Motif frame ${id} was skipped by the compositor`) }
}

/** One expected frame. `frame` settles with the first paint carrying `id`;
 * after `cancel` it never settles. */
export interface FrameLease { id: number; frame: Promise<MotifOsrFrame>; cancel(): void }

interface Pending {
  id: number
  width: number
  height: number
  timer: ReturnType<typeof setTimeout>
  resolve: (frame: MotifOsrFrame) => void
  reject: (error: Error) => void
}

/** Owns the capture host's paints. Painting stays on; a paint is leased only
 * when its marker rows carry an expected frame id and that id's canvas
 * witness (shared/motifs/frameMarker.ts, ADR 0078). That one check covers a new
 * document, a new size and a GPU process restart alike: their stale or blank
 * first paints carry no id or an old one, and a commit missing the page's
 * canvases carries no witness. Several frames may be expected at once (ADR
 * 0159). Paints arrive in frame order, so a paint carrying a later id retires
 * every earlier expected frame as skipped, and one carrying an id without its
 * witness retires that frame too: the commit never fills in. Every other paint
 * is released at once. */
export class OffscreenFrames {
  private nextId = 1
  /** Expected frames, in id order. */
  private readonly pending = new Map<number, Pending>()
  private nudge: ReturnType<typeof setInterval> | null = null
  private lastProgress = 0

  /** `nudgeMs`: how long expected frames may go without a paint before the
   * capturer is restarted to capture the surface again. A new window once drew
   * the id and sent no paint for seconds; the restarted capture is checked like
   * any other paint. */
  constructor(
    private readonly contents: WebContents, private readonly markers: Pick<MotifMarkerReader, 'read'> | null,
    private readonly timeoutMs: number, private readonly nudgeMs: number,
  ) {
    contents.on('paint', (event, _dirty, image) => {
      if (event.texture) this.paintTexture(event.texture)
      else this.paintBitmap(image)
    })
  }

  /** Reserves the next frame id. Taken before the page renders the frame: its
   * paint can arrive before the render call returns. */
  expect(width: number, height: number): FrameLease {
    const id = this.nextId
    this.nextId = this.nextId === 0xffff_ffff ? 1 : this.nextId + 1
    let pending!: Pending
    const frame = new Promise<MotifOsrFrame>((resolve, reject) => {
      pending = {
        id, width, height, resolve, reject,
        timer: setTimeout(() => this.settle(pending, new Error('Motif OSR paint timed out')), this.timeoutMs),
      }
    })
    // Its render may still be running when the frame times out or the host
    // closes; the render's own failure is what its caller sees then.
    frame.catch(() => {})
    if (this.pending.size === 0) this.lastProgress = performance.now()
    this.pending.set(id, pending)
    this.nudge ??= setInterval(() => this.restartIfStalled(), this.nudgeMs / 2)
    return { id, frame, cancel: () => this.settle(pending, null) }
  }

  dispose(): void {
    for (const request of [...this.pending.values()]) this.settle(request, new Error('Motif capture host closed'))
  }

  private restartIfStalled(): void {
    if (performance.now() - this.lastProgress < this.nudgeMs) return
    this.lastProgress = performance.now()
    this.contents.stopPainting()
    this.contents.startPainting()
  }

  /** The size every expected frame shares: the capture queue drains its
   * frames before a resize. */
  private expectedSize(): { width: number; height: number } | null {
    const first = this.pending.values().next()
    return first.done ? null : first.value
  }

  private paintTexture(texture: OffscreenSharedTexture): void {
    const size = this.expectedSize()
    const { codedSize, handle } = texture.textureInfo
    const rows = size ? frameMarkerRows(size.width) : 0
    if (!size || !this.markers || !handle.ntHandle || codedSize.width !== size.width || codedSize.height !== size.height + rows) {
      texture.release()
      return
    }
    this.markers.read(handle.ntHandle, rows).then(marker => {
      const request = this.arrived(marker)
      if (!request) { texture.release(); return }
      request.resolve({ kind: 'texture', texture, width: request.width, height: request.height })
    }, (error: unknown) => {
      texture.release()
      const failure = error instanceof Error ? error : new Error(String(error))
      for (const request of [...this.pending.values()]) this.settle(request, failure)
    })
  }

  private paintBitmap(image: NativeImage): void {
    const size = this.expectedSize()
    if (!size || !image || image.isEmpty()) return
    const { width, height } = image.getSize()
    const rows = frameMarkerRows(width)
    if (width !== size.width || height !== size.height + rows) return
    // One row holds the whole marker, or the marker fills every row but the last.
    const marker = image.crop({ x: 0, y: size.height, width: Math.min(width, FRAME_MARKER_READ_PIXELS), height: rows }).toBitmap()
    const request = this.arrived(marker)
    request?.resolve({ kind: 'bitmap', image, width: request.width, height: request.height })
  }

  /** Retires the expected frame a paint with marker rows `marker` shows, and
   * every earlier one as skipped; without its canvas witness, that frame is
   * skipped too. Returns the shown frame's request, if expected and whole. */
  private arrived(marker: Uint8Array): Pending | null {
    const id = decodeFrameMarker(marker)
    if (id === null) return null
    for (const earlier of [...this.pending.values()]) {
      if (earlier.id >= id) break
      this.settle(earlier, new MotifFrameSkippedError(earlier.id))
    }
    const request = this.pending.get(id) ?? null
    if (!request) return null
    this.lastProgress = performance.now()
    if (!frameWitnessed(marker, id)) {
      this.settle(request, new MotifFrameSkippedError(id))
      return null
    }
    this.settle(request, null)
    return request
  }

  /** Retires `request` if it is still expected, rejecting its frame when
   * `error` is given. */
  private settle(request: Pending, error: Error | null): void {
    if (this.pending.get(request.id) !== request) return
    this.pending.delete(request.id)
    clearTimeout(request.timer)
    if (this.pending.size === 0 && this.nudge) { clearInterval(this.nudge); this.nudge = null }
    if (error) request.reject(error)
  }
}
