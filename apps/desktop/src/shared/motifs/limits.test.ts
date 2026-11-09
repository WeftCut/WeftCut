import { describe, expect, it } from 'vitest'
import { assertMotifLimits, fitsMotifFrame, fitsMotifTexture, MOTIF_LIMITS } from './limits'

describe('Motif limits', () => {
  it('are the native core\'s values', () => {
    // LANDMINE: twin of the test in `native/src/motif_limits.rs`; change both.
    expect(MOTIF_LIMITS).toEqual({
      maxDimension: 8192,
      maxFrameBytes: 256 * 1024 * 1024,
      maxTextureBytes: 128 * 1024 * 1024,
    })
  })

  it('a frame may be 8192 square and no larger, in whole pixels', () => {
    expect(fitsMotifFrame(8192, 8192)).toBe(true)
    expect(fitsMotifFrame(8193, 1)).toBe(false)
    expect(fitsMotifFrame(1, 8193)).toBe(false)
    expect(fitsMotifFrame(0, 1)).toBe(false)
    expect(fitsMotifFrame(1.5, 1)).toBe(false)
    expect(fitsMotifFrame(Number.NaN, 1)).toBe(false)
  })

  it('a texture fits up to exactly 128 MiB, an upload pool counting its staging texture', () => {
    expect(fitsMotifTexture(8192, 4096, 'copy')).toBe(true)
    expect(fitsMotifTexture(8192, 4097, 'copy')).toBe(false)
    expect(fitsMotifTexture(4096, 4096, 'upload')).toBe(true)
    expect(fitsMotifTexture(4096, 4097, 'upload')).toBe(false)
    expect(fitsMotifTexture(8192, 8192, 'copy')).toBe(false)
    expect(fitsMotifTexture(0, 1, 'copy')).toBe(false)
  })

  it('the addon check passes only the same values under the same keys', () => {
    expect(() => assertMotifLimits({ ...MOTIF_LIMITS })).not.toThrow()
    expect(() => assertMotifLimits({ ...MOTIF_LIMITS, maxTextureBytes: 256 * 1024 * 1024 })).toThrow(/differ/)
    expect(() => assertMotifLimits({ ...MOTIF_LIMITS, extra: 1 })).toThrow(/differ/)
    const { maxTextureBytes: _, ...missing } = MOTIF_LIMITS
    expect(() => assertMotifLimits(missing)).toThrow(/differ/)
    expect(() => assertMotifLimits(undefined)).toThrow(/differ/)
  })
})
