import type { MotifReaderDiv, MotifReadTiming } from './readerProtocol'

/** Native stage times of one texture-lane read, in milliseconds. */
export interface MotifUploadTiming { read: MotifReadTiming; mapMs: number; acquireMs: number; gpuMs: number }

/** `timing` is present when the texture was read from the frame cache. */
export type MotifTextureFrame = { kind: 'texture'; key: string; token: string; timing?: MotifUploadTiming }
/** `stored` (capture only, always `persisted: true`): the frame is on disk and
 * main sends no pixels. The renderer reads it through its `MotifFrameReader`
 * at its own divisor (ADR 0154). If that read misses, the renderer captures
 * again without `cache`, so a corrupt file cannot loop. */
/** `pixels`: a bitmap host's picture as straight RGBA, `width × height`. */
export type StoredMotifFrame = (
  | MotifTextureFrame
  | { kind: 'pixels'; width: number; height: number; bytes: Uint8Array }
  | { kind: 'stored' }
) & { persisted?: boolean }

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
export type MotifCaptureControl = { key: string; action: 'promote' | 'cancel' }
