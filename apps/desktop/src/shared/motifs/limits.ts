// The fixed sizes a Motif frame, GPU texture and pool must fit
// (docs/motifs.md#limits). Mirrors `native/src/motif_limits.rs`;
// `loadMotifNative` checks the two agree with `assertMotifLimits`.

export interface MotifLimits {
  /** The largest width or height of a stored frame, in pixels. */
  maxDimension: number
  /** A stored frame's straight RGBA bytes: `maxDimension²` at four bytes a pixel. */
  maxFrameBytes: number
  /** One GPU allocation: a pool's slots plus its staging texture, or an OSR
   * texture read back. A full-size 8K frame does not fit. */
  maxTextureBytes: number
  /** Slots one GPU pool may hold. */
  maxPoolSlots: number
}

export const MOTIF_LIMITS: Readonly<MotifLimits> = Object.freeze({
  maxDimension: 8192,
  maxFrameBytes: 256 * 1024 * 1024,
  maxTextureBytes: 128 * 1024 * 1024,
  maxPoolSlots: 4,
})

const isSize = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/** Whether a `width × height` frame can be captured and stored. */
export function fitsMotifFrame(width: number, height: number): boolean {
  return isSize(width) && isSize(height) && width <= MOTIF_LIMITS.maxDimension && height <= MOTIF_LIMITS.maxDimension
    && width * height * 4 <= MOTIF_LIMITS.maxFrameBytes
}

/** Whether a one-slot GPU pool of `width × height` fits `maxTextureBytes`. An
 * `upload` pool reads stored frames through a staging texture as large as its
 * slot, so it counts twice. */
export function fitsMotifTexture(width: number, height: number, use: 'upload' | 'copy'): boolean {
  return isSize(width) && isSize(height)
    && width * height * 4 * (use === 'upload' ? 2 : 1) <= MOTIF_LIMITS.maxTextureBytes
}

/** Throws unless the addon's `motifLimits()` are exactly `MOTIF_LIMITS`: a
 * mismatch would let one side accept frames or pools the other refuses. */
export function assertMotifLimits(native: unknown): void {
  const keys = Object.keys(MOTIF_LIMITS) as (keyof MotifLimits)[]
  const actual = native as Partial<Record<string, unknown>> | null
  const same = !!actual && typeof actual === 'object' && Object.keys(actual).length === keys.length
    && keys.every(key => actual[key] === MOTIF_LIMITS[key])
  if (!same) throw new Error(`Motif limits differ between the native core and the app: ${JSON.stringify(native)} vs ${JSON.stringify(MOTIF_LIMITS)}`)
}
