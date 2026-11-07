import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { dropPngRows } from './pngRows'

/// A PNG whose rows differ, encoded with every filter so dropping a row must
/// keep the remaining lines' filtered bytes valid.
function image(width: number, height: number, filterType: number, colorType: 2 | 6 = 6): { png: Buffer; pixels: Buffer } {
  const png = new PNG({ width, height, colorType, inputHasAlpha: true })
  for (let i = 0; i < width * height; i++) png.data.set([(i * 37) & 255, (i * 11) & 255, (i * 101) & 255, (i * 7) & 255], i * 4)
  if (colorType === 2) for (let i = 0; i < width * height; i++) png.data[i * 4 + 3] = 255
  return { png: PNG.sync.write(png, { filterType, colorType }), pixels: Buffer.from(png.data) }
}

describe('dropPngRows', () => {
  it('drops the bottom rows and keeps every other pixel exact, for every filter', () => {
    for (const filterType of [0, 1, 2, 3, 4, -1]) {
      for (const colorType of [6, 2] as const) {
        const { png, pixels } = image(37, 9, filterType, colorType)
        const cropped = PNG.sync.read(dropPngRows(png, 1))
        expect([cropped.width, cropped.height]).toEqual([37, 8])
        expect(Buffer.from(cropped.data)).toEqual(pixels.subarray(0, 37 * 8 * 4))
      }
    }
  })

  it('returns the image unchanged for no rows and refuses what it cannot crop', () => {
    const { png } = image(4, 3, 4)
    expect(dropPngRows(png, 0)).toBe(png)
    expect(() => dropPngRows(png, 3)).toThrow(/3 of 3/)
    expect(() => dropPngRows(Buffer.from('not a png at all'), 1)).toThrow('not a PNG')
  })
})
