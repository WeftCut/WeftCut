import type { NativeImage, OffscreenSharedTexture, WebContents } from 'electron'
import { decodeFrameMarker, FRAME_MARKER_PIXELS, FRAME_MARKER_ROWS } from '../../shared/motifs/frameMarker.js'

/** Reads the first `pixels` of a shared texture's last row as RGBA. */
export type FrameMarkerReader = (handle: Buffer, pixels: number) => Promise<Uint8Array>

/** A leased capture and the picture size it holds above the marker rows. A
 * texture host's shared texture is released by its holder; a bitmap host's
 * paint is premultiplied BGRA (`NativeImage.toBitmap`). */
export type MotifOsrFrame =
  | { kind: 'texture'; texture: OffscreenSharedTexture; width: number; height: number }
  | { kind: 'bitmap'; image: NativeImage; width: number; height: number }

/** A paint carrying a later frame's id arrived first: the compositor never
 * showed this frame and never will. Rendering it again shows it. */
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

/// How long expected frames may go without a paint before the capturer is
/// restarted to capture the surface again. A new window once drew the id and
/// sent no paint for seconds; the restarted capture is checked like any other
/// paint.
const NUDGE_MS = 200

/** Owns the capture host's paints. Painting stays on; a paint is leased only
 * when its marker row carries an expected frame id
 * (shared/motifs/frameMarker.ts, ADR 0078). That one check covers a new
 * document, a new size and a GPU process restart alike: their stale or blank
 * first paints carry no id or an old one. Several frames may be expected at
 * once (ADR 0159). Paints arrive in frame order, so a paint carrying a later
 * id retires every earlier expected frame as skipped. Every other paint is
 * released at once. */
export class OffscreenFrames {
  private nextId = 1
  /** Expected frames, in id order. */
  private readonly pending = new Map<number, Pending>()
  private nudge: ReturnType<typeof setInterval> | null = null
  private lastProgress = 0

  constructor(private readonly contents: WebContents, private readonly readMarker: FrameMarkerReader | null, private readonly timeoutMs: number) {
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
    this.nudge ??= setInterval(() => this.restartIfStalled(), NUDGE_MS / 2)
    return { id, frame, cancel: () => this.settle(pending, null) }
  }

  dispose(): void {
    for (const request of [...this.pending.values()]) this.settle(request, new Error('Motif capture host closed'))
  }

  private restartIfStalled(): void {
    if (performance.now() - this.lastProgress < NUDGE_MS) return
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
    if (!size || !this.readMarker || !handle.ntHandle || codedSize.width !== size.width || codedSize.height !== size.height + FRAME_MARKER_ROWS) {
      texture.release()
      return
    }
    this.readMarker(handle.ntHandle, FRAME_MARKER_PIXELS).then(row => {
      const request = this.arrived(decodeFrameMarker(row))
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
    if (width !== size.width || height !== size.height + FRAME_MARKER_ROWS) return
    const row = image.crop({ x: 0, y: size.height, width: FRAME_MARKER_PIXELS, height: 1 }).toBitmap()
    const request = this.arrived(decodeFrameMarker(row))
    request?.resolve({ kind: 'bitmap', image, width: request.width, height: request.height })
  }

  /** Retires the expected frame a paint carrying `id` shows, and every
   * earlier one as skipped. Returns the shown frame's request, if expected. */
  private arrived(id: number | null): Pending | null {
    if (id === null) return null
    for (const earlier of [...this.pending.values()]) {
      if (earlier.id >= id) break
      this.settle(earlier, new MotifFrameSkippedError(earlier.id))
    }
    const request = this.pending.get(id) ?? null
    if (request) {
      this.settle(request, null)
      this.lastProgress = performance.now()
    }
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
