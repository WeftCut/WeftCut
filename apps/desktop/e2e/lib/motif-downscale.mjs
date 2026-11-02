// Reference for the Motif frame reader conformance spec (ADR 0154,
// e2e/electron/motif-frame-reader.spec.ts): the native downscale written
// again in plain JS, synthetic frames, PNG encoding, and the per-lane rule for
// comparing a bitmap read back from a canvas with the reference.
//
// The downscale must equal native/src/motif_frame.rs `downscale` byte for byte;
// motif-downscale.test.mjs holds it to the shared vectors in
// native/tests/fixtures/motif-downscale-vectors.json.
import { PNG } from 'pngjs'

export const VECTORS_PATH = new URL('../../native/tests/fixtures/motif-downscale-vectors.json', import.meta.url)

/** Alpha-weighted box filter. The output is ceil(w/div) × ceil(h/div); a
 * partial edge block averages only the texels it covers. Colour is
 * round_half_up(Σ(c·a) / Σa), 0 when Σa is 0; alpha is round_half_up(Σa / n). */
export function downscaleReference(rgba, width, height, div) {
  if (![1, 2, 4].includes(div)) throw new RangeError(`invalid divisor ${div}`)
  if (rgba.length !== width * height * 4) throw new RangeError('pixel length does not match the size')
  if (div === 1) return { width, height, rgba: Uint8Array.from(rgba) }
  const ow = Math.ceil(width / div), oh = Math.ceil(height / div)
  const out = new Uint8Array(ow * oh * 4)
  for (let y = 0; y < oh; y++) {
    const y0 = y * div, y1 = Math.min(y0 + div, height)
    for (let x = 0; x < ow; x++) {
      const x0 = x * div, x1 = Math.min(x0 + div, width)
      let a = 0, r = 0, g = 0, b = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4
          const alpha = rgba[i + 3]
          a += alpha
          r += rgba[i] * alpha
          g += rgba[i + 1] * alpha
          b += rgba[i + 2] * alpha
        }
      }
      const n = (x1 - x0) * (y1 - y0)
      const o = (y * ow + x) * 4
      if (a !== 0) {
        out[o] = Math.floor((2 * r + a) / (2 * a))
        out[o + 1] = Math.floor((2 * g + a) / (2 * a))
        out[o + 2] = Math.floor((2 * b + a) / (2 * a))
      }
      out[o + 3] = Math.floor((2 * a + n) / (2 * n))
    }
  }
  return { width: ow, height: oh, rgba: out }
}

/** A deterministic straight-RGBA frame with every kind of alpha a block can
 * meet: transparent bands, opaque bands, and low and mid alpha in between. */
export function syntheticFrame(width, height) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      rgba[i] = (x * 7 + y * 3) & 255
      rgba[i + 1] = (x * y + 11) & 255
      rgba[i + 2] = ((x ^ y) * 5) & 255
      rgba[i + 3] = y % 64 < 4 ? 0 : x % 50 < 5 ? 255 : (x * 3 + y * 5 + ((x * y) >> 3)) & 255
    }
  }
  return rgba
}

/** An 8-bit RGBA PNG of straight pixels (no colour chunks), as a Buffer. */
export function encodePng(rgba, width, height) {
  return PNG.sync.write({ width, height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) },
    { colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true })
}

/** How an 8-bit premultiplied surface stores a straight channel. Never a tie:
 * c·a/255 cannot end in .5 because 255 is odd. */
export const premultiply = (c, a) => Math.round((c * a) / 255)

/**
 * Compares a canvas read-back (`getImageData`, straight) with the reference.
 *
 * Neither lane can be read back without one premultiply: the reader returns an
 * ImageBitmap, and a 2D canvas stores premultiplied pixels and unpremultiplies
 * them again for `getImageData`. Re-premultiplying the read-back recovers the
 * canvas's stored value, so both sides are compared premultiplied.
 *
 * - `straight` (the utility lane: straight RGBA until the worker's bitmap):
 *   alpha exact, opaque texels exact, translucent colour within 2
 *   premultiplied. Its straight bytes are checked exactly at the native core.
 * - `premultiplied` (the Windows texture lane premultiplies before upload):
 *   every channel, alpha included, within 2 premultiplied.
 */
export function compareReadback({ expected, actual, width, height, rule, tolerance = 2 }) {
  if (rule !== 'straight' && rule !== 'premultiplied') throw new RangeError(`unknown rule ${rule}`)
  if (expected.length !== width * height * 4 || actual.length !== width * height * 4) {
    return { mismatches: width * height, maxError: Infinity, first: [{ reason: `length ${actual.length}, expected ${expected.length}` }] }
  }
  let mismatches = 0, maxError = 0
  const first = []
  for (let p = 0; p < width * height; p++) {
    const i = p * 4
    const ea = expected[i + 3], aa = actual[i + 3]
    let error = Math.abs(ea - aa)
    let bad = rule === 'straight' ? error !== 0 : error > tolerance
    for (let c = 0; c < 3; c++) {
      const e = premultiply(expected[i + c], ea), a = premultiply(actual[i + c], aa)
      const diff = Math.abs(e - a)
      error = Math.max(error, diff)
      if (rule === 'straight' && ea === 255) bad ||= diff !== 0
      else bad ||= diff > tolerance
    }
    maxError = Math.max(maxError, error)
    if (bad) {
      mismatches++
      if (first.length < 5) {
        first.push({ x: p % width, y: Math.floor(p / width), expected: [...expected.subarray(i, i + 4)], actual: [...actual.subarray(i, i + 4)] })
      }
    }
  }
  return { mismatches, maxError, first }
}
