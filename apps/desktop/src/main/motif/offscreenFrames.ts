import type { OffscreenSharedTexture, WebContents } from 'electron'
import { decodeFrameMarker, FRAME_MARKER_PIXELS, FRAME_MARKER_ROWS } from '../../shared/motifs/frameMarker.js'

/** Reads the first `pixels` of a shared texture's last row as RGBA. */
export type FrameMarkerReader = (handle: Buffer, pixels: number) => Promise<Uint8Array>

/** A leased capture: Electron's texture and the picture size it holds above
 * the marker rows. The holder releases the texture. */
export interface MotifOsrFrame { texture: OffscreenSharedTexture; width: number; height: number }

/** One expected frame. `frame` settles with the first paint carrying `id`;
 * after `cancel` it never settles. */
export interface FrameLease { id: number; frame: Promise<MotifOsrFrame>; cancel(): void }

interface Pending {
  id: number
  width: number
  height: number
  timer: ReturnType<typeof setTimeout>
  nudge: ReturnType<typeof setInterval>
  resolve: (frame: MotifOsrFrame) => void
  reject: (error: Error) => void
}

/// How long a frame may go without its paint before the capturer is restarted
/// to capture the surface again. A new window once drew the id and sent no
/// paint for seconds; the restarted capture is checked like any other paint.
const NUDGE_MS = 200

/** Owns Electron's scarce capture surfaces. Painting stays on; a paint is
 * leased only when its marker row carries the expected frame id
 * (shared/motifs/frameMarker.ts, ADR 0078). That one check covers a new
 * document, a new size and a GPU process restart alike: their stale or blank
 * first paints carry no id or an old one. Every other paint is released at
 * once. */
export class OffscreenFrames {
  private nextId = 1
  private pending: Pending | null = null

  constructor(private readonly contents: WebContents, private readonly readMarker: FrameMarkerReader, private readonly timeoutMs: number) {
    contents.on('paint', event => { if (event.texture) this.paint(event.texture) })
  }

  /** Reserves the next frame id. Taken before the page renders the frame: its
   * paint can arrive before the render call returns. */
  expect(width: number, height: number): FrameLease {
    if (this.pending) throw new Error('Overlapping Motif OSR capture')
    const id = this.nextId
    this.nextId = this.nextId === 0xffff_ffff ? 1 : this.nextId + 1
    let pending!: Pending
    const frame = new Promise<MotifOsrFrame>((resolve, reject) => {
      pending = {
        id, width, height, resolve, reject,
        timer: setTimeout(() => this.settle(pending, new Error('Motif OSR paint timed out')), this.timeoutMs),
        nudge: setInterval(() => { this.contents.stopPainting(); this.contents.startPainting() }, NUDGE_MS),
      }
    })
    this.pending = pending
    return { id, frame, cancel: () => this.settle(pending, null) }
  }

  dispose(): void {
    if (this.pending) this.settle(this.pending, new Error('Motif capture host closed'))
  }

  private paint(texture: OffscreenSharedTexture): void {
    const request = this.pending
    const { codedSize, handle } = texture.textureInfo
    if (!request || !handle.ntHandle || codedSize.width !== request.width || codedSize.height !== request.height + FRAME_MARKER_ROWS) {
      texture.release()
      return
    }
    this.readMarker(handle.ntHandle, FRAME_MARKER_PIXELS).then(row => {
      if (this.pending !== request || decodeFrameMarker(row) !== request.id) { texture.release(); return }
      this.settle(request, null)
      request.resolve({ texture, width: request.width, height: request.height })
    }, (error: unknown) => {
      texture.release()
      this.settle(request, error instanceof Error ? error : new Error(String(error)))
    })
  }

  /** Retires `request` if it is still the pending one, rejecting its frame
   * when `error` is given. */
  private settle(request: Pending, error: Error | null): void {
    if (this.pending !== request) return
    this.pending = null
    clearTimeout(request.timer)
    clearInterval(request.nudge)
    if (error) request.reject(error)
  }
}
