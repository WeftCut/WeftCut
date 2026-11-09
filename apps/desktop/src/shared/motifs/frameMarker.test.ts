import { describe, expect, it } from 'vitest'
import { decodeFrameMarker, FRAME_MARKER_PIXELS, FRAME_MARKER_READ_PIXELS, frameMarkerBits, frameWitnessBits, frameWitnessed } from './frameMarker'

const row = (bits: number[]) => {
  const rgba = new Uint8Array(bits.length * 4)
  bits.forEach((bit, i) => rgba.set(bit ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4))
  return rgba
}

describe('frame marker', () => {
  it('round-trips ids across the 32-bit range', () => {
    for (const id of [0, 1, 2, 255, 256, 65_535, 0x12345678, 0xffff_fffe, 0xffff_ffff]) {
      const bits = frameMarkerBits(id)
      expect(bits).toHaveLength(FRAME_MARKER_PIXELS)
      expect(decodeFrameMarker(row(bits))).toBe(id)
    }
  })

  it('reads nothing from a picture that is not a marker', () => {
    expect(decodeFrameMarker(new Uint8Array(FRAME_MARKER_PIXELS * 4))).toBeNull() // transparent
    expect(decodeFrameMarker(row(new Array(FRAME_MARKER_PIXELS).fill(1)))).toBeNull()
    expect(decodeFrameMarker(row(frameMarkerBits(7)).subarray(4))).toBeNull() // short
  })

  it('rejects any single flipped, grey or translucent pixel', () => {
    const good = row(frameMarkerBits(0x0badcafe))
    for (let i = 0; i < FRAME_MARKER_PIXELS; i++) {
      const flipped = good.slice()
      for (let c = 0; c < 3; c++) flipped[i * 4 + c] = 255 - flipped[i * 4 + c]!
      expect(decodeFrameMarker(flipped)).not.toBe(0x0badcafe)
      const grey = good.slice()
      grey[i * 4 + 1] = 255 - grey[i * 4 + 1]!
      expect(decodeFrameMarker(grey)).toBeNull()
      const translucent = good.slice()
      translucent[i * 4 + 3] = 254
      expect(decodeFrameMarker(translucent)).toBeNull()
    }
  })
})

describe('canvas witness', () => {
  const marked = (id: number, witness: number[] | null) => {
    const rgba = new Uint8Array(FRAME_MARKER_READ_PIXELS * 4) // a missing canvas reads transparent
    rgba.set(row(frameMarkerBits(id)))
    if (witness) rgba.set(row(witness), FRAME_MARKER_PIXELS * 4)
    return rgba
  }

  it('is witnessed by the id\'s own low byte only', () => {
    for (const id of [1, 2, 255, 256, 0x12345678]) expect(frameWitnessed(marked(id, frameWitnessBits(id)), id)).toBe(true)
    expect(frameWitnessed(marked(7, frameWitnessBits(6)), 7)).toBe(false) // a canvas a frame behind
    expect(frameWitnessed(marked(7, null), 7)).toBe(false) // the commit without its canvases
    expect(frameWitnessed(marked(7, frameWitnessBits(7)).subarray(4), 7)).toBe(false) // short
  })

  it('rejects a grey or translucent witness pixel', () => {
    const good = marked(0xa5, frameWitnessBits(0xa5))
    const at = (FRAME_MARKER_PIXELS + 3) * 4
    const grey = good.slice(); grey[at + 1] = 255 - grey[at + 1]!
    const translucent = good.slice(); translucent[at + 3] = 254
    expect(frameWitnessed(grey, 0xa5)).toBe(false)
    expect(frameWitnessed(translucent, 0xa5)).toBe(false)
  })
})
