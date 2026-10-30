import type { MotifReaderDiv, MotifReadTiming } from './readerProtocol'

/** Native stage times of one texture-lane read, in milliseconds. */
export interface MotifUploadTiming { read: MotifReadTiming; premultiplyMs: number; acquireMs: number; gpuMs: number }

/** `timing` is present when the texture was read from the frame cache. */
export type MotifTextureFrame = { kind: 'texture'; key: string; token: string; timing?: MotifUploadTiming }
/** `stored` (capture only, always `persisted: true`): the frame is on disk and
 * main sends no pixels. The renderer reads it through its `MotifFrameReader`
 * at its own divisor (ADR 0154). If that read misses, the renderer captures
 * again without `cache`, so a corrupt file cannot loop. */
export type StoredMotifFrame = (
  | MotifTextureFrame
  | { kind: 'png'; bytes: Uint8Array }
  | { kind: 'rgba'; width: number; height: number; rgba: Uint8Array }
  | { kind: 'stored' }
) & { persisted?: boolean }

/** `motif:read` (ADR 0154): the Windows texture lane at a Playback Resolution
 * divisor. Export and finalization reads use 1. */
export interface MotifTextureReadRequest { hash: string; frame: number; div: MotifReaderDiv; finalizationToken?: string }
/** The texture lane cannot serve this read (no shared textures, GPU budget,
 * a failed pool or import). Not a miss: the frame stays in coverage. */
export type MotifReadUnavailable = { kind: 'unavailable' }
/** null is a miss: the frame is absent or invalid and has left coverage. */
export type MotifTextureReadResult = MotifTextureFrame | MotifReadUnavailable | null

export interface MotifCacheAddress { hash: string; frame: number }
export type MotifCaptureControl =
  | { key: string; action: 'promote' | 'cancel' }
  | { key: string; action: 'bake'; bake: MotifCacheAddress }
