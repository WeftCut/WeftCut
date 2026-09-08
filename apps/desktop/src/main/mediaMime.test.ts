import { describe, expect, it } from 'vitest'
import { mediaMimeForExt } from './mediaMime.js'

describe('weftcut-media Content-Type', () => {
  it('names the real type for every image the renderer hands to ImageDecoder', () => {
    // ImageDecoder refuses application/octet-stream where createImageBitmap
    // would sniff the bytes; a generic type here froze every animated GIF to
    // its first frame. The set mirrors EXT_MIME in animatedImageCache.ts.
    const images: Array<[string, string]> = [
      ['.gif', 'image/gif'], ['.GIF', 'image/gif'], ['.webp', 'image/webp'], ['.png', 'image/png'],
      ['.apng', 'image/apng'], ['.avif', 'image/avif'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
    ]
    for (const [ext, mime] of images) expect(mediaMimeForExt(ext), ext).toBe(mime)
  })

  it('tags containers binary and falls back to octet-stream for unknown ones', () => {
    expect(mediaMimeForExt('.mp4')).toBe('video/mp4')
    expect(mediaMimeForExt('.MOV')).toBe('video/quicktime')
    expect(mediaMimeForExt('.wav')).toBe('audio/wav')
    expect(mediaMimeForExt('.flac')).toBe('application/octet-stream')
    // Never a text type: that is what re-enables the main-thread text decode.
    for (const ext of ['', '.bin', '.ts', '.txt']) expect(mediaMimeForExt(ext), ext).not.toMatch(/^text\//)
  })
})
