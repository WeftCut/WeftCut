import type { MotifReaderDiv, MotifReadTiming } from './readerProtocol'

/** Native stage times of one texture-lane read, in milliseconds. */
export interface MotifUploadTiming { read: MotifReadTiming; mapMs: number; acquireMs: number; gpuMs: number }

/** `timing` is present when the texture was read from the frame cache. */
export type MotifTextureFrame = { kind: 'texture'; key: string; token: string; timing?: MotifUploadTiming }
/** `stored` (capture only, always `persisted: true`): the frame is on disk and
 * main sends no pixels. The renderer reads it through its `MotifFrameReader`
 * at its own divisor (ADR 0154). If that read misses, the renderer captures
 * again `afterMiss`, which main never answers `stored` (ADR 0160). */
/** `pixels`: a bitmap host's picture as straight RGBA, `width × height`. */
export type StoredMotifFrame = (
  | MotifTextureFrame
  | { kind: 'pixels'; width: number; height: number; bytes: Uint8Array }
  | { kind: 'stored' }
) & { persisted?: boolean }

/** `motif:capture`'s answer: a frame, or `superseded` when the request was
 * withdrawn (a cancel, a closed document, a project switch). Superseded is a
 * reply, not a throw: `ipcMain.handle` logs every rejection with its stack,
 * and a cancelled capture is routine. The renderer's transport turns
 * it back into a `superseded` MotifError; every other failure still throws. */
export type MotifCaptureReply = StoredMotifFrame | { kind: 'superseded' }

/** `motif:read` (ADR 0154): the Windows texture lane at a Playback Resolution
 * divisor. Export and finalization reads use 1. */
export interface MotifTextureReadRequest { hash: string; frame: number; div: MotifReaderDiv; finalizationToken?: string }
/** The texture lane does not serve this read; the reader takes the utility
 * lane. Not a miss: the frame stays in coverage.
 * - `lane`: the lane is off for this document (no shared textures, a failed
 *   GPU device, import or send) until main sends `MOTIF_TEXTURE_LANE_RESET`
 *   with a newer `generation`.
 * - `read`: this read alone (a frame over the texture limit or the GPU
 *   budget, a held file or mutex, a failed upload).
 * `generation` is the document's lane generation in main, which every
 * `MotifGpuTransport.close` of the document advances. */
export type MotifReadUnavailable = { kind: 'unavailable'; reason: 'lane' | 'read'; generation: number }
/** null is a miss: the frame is absent or invalid and has left coverage. */
export type MotifTextureReadResult = MotifTextureFrame | MotifReadUnavailable | null

export interface MotifCacheAddress { hash: string; frame: number }

/** Why a Motif frame is wanted, highest first: `current` is on screen or in
 * an export, `ahead` is lookahead at or after the playhead, `background` is
 * history behind it, preparation, and previews nobody plays. Admission and
 * main's capture queue serve them in that order. */
export type MotifFramePriority = 'current' | 'ahead' | 'background'

/** The frame a capture renders. */
export interface MotifCaptureArgs {
  motifId: string
  tSec: number
  propsJson: string
  width: number
  height: number
  contentHash: string
  /** The composition fps `tSec` was computed on, as an exact rational. Absent
   * or invalid falls back to 30 (MCP without a project). */
  fpsNum?: number
  fpsDen?: number
}

/** `motif:capture`: one request for a Motif frame (ADR 0160). */
export interface MotifCaptureRequest extends MotifCaptureArgs {
  /** Names the request for `motif:capture-control`; unique per frame port. */
  requestId: number
  priority: MotifFramePriority
  /** The frame's cache address. Without one, main neither stores the frame,
   * nor answers `stored`, nor shares its capture. */
  address?: MotifCacheAddress
  /** `keep`: main stores the frame and reports whether it did. `offer`
   * (default): main stores it when it has room. */
  store?: 'keep' | 'offer'
  /** Main answered this frame `stored` and the renderer's read of it then
   * missed: main never answers `stored`, so a corrupt file cannot answer
   * again. It captures and offers a write like any display. A first read miss
   * goes without it, so main checks the store and a stale miss captures
   * nothing (ADR 0160). */
  afterMiss?: boolean
  finalizationToken?: string
}

/** `motif:capture-control`, sent after its request on the same port. A
 * priority may go down as well as up; a cancel withdraws a queued capture. */
export type MotifCaptureControl =
  | { requestId: number; action: 'cancel' }
  | { requestId: number; action: 'priority'; priority: MotifFramePriority }
