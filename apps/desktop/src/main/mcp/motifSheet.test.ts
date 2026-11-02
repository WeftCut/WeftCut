// apps/desktop/src/main/mcp/motifSheet.test.ts
// The contact sheet's PNG reader must read what a capture writes: Chromium and
// nativeImage pick a filter per scanline, so every filter type is decoded here
// against an independent encoder (node:zlib).
import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { composeMotifSheet, decodePng, encodePng, SHEET_LABEL_PX } from './motifSheet'

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1 }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** An RGBA PNG whose row y uses filter `y % 5`. */
function filteredPng(w: number, h: number, px: Uint8Array): Uint8Array {
  const stride = w * 4, out: number[] = []
  for (let y = 0; y < h; y++) {
    const f = y % 5
    out.push(f)
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x]!, a = x >= 4 ? px[y * stride + x - 4]! : 0, b = y > 0 ? px[(y - 1) * stride + x]! : 0, c = y > 0 && x >= 4 ? px[(y - 1) * stride + x - 4]! : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]!
      out.push((v - pred + 256) & 255)
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8)
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(out))), chunk('IEND', Buffer.alloc(0))]))
}

describe('the Motif contact sheet', () => {
  it('decodes every PNG filter type, and round-trips its own encoding', () => {
    const w = 7, h = 10
    const px = new Uint8Array(w * h * 4).map((_, i) => (i * 37 + (i >> 3) * 11) & 255)
    expect(decodePng(filteredPng(w, h, px)).pixels).toEqual(px)
    expect(decodePng(encodePng({ width: w, height: h, pixels: px })).pixels).toEqual(px)
  })

  it('lays frames out under label strips, keeping each frame\'s alpha', () => {
    const tile = (v: number) => encodePng({ width: 4, height: 3, pixels: new Uint8Array(48).fill(v) })
    const sheet = composeMotifSheet([{ tSec: 0, png: tile(0) }, { tSec: 1.5, png: tile(90) }])
    expect([sheet.width, sheet.height, sheet.columns]).toEqual([8, 3 + SHEET_LABEL_PX, 2])
    const img = decodePng(sheet.png)
    const at = (x: number, y: number) => Array.from(img.pixels.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))
    expect(at(1, SHEET_LABEL_PX)).toEqual([0, 0, 0, 0])
    expect(at(5, SHEET_LABEL_PX + 2)).toEqual([90, 90, 90, 90])
    expect(at(0, 0)).toEqual([30, 30, 30, 255])
  })

  it('refuses frames of different sizes and non-PNG bytes', () => {
    const a = encodePng({ width: 2, height: 2, pixels: new Uint8Array(16) }), b = encodePng({ width: 3, height: 2, pixels: new Uint8Array(24) })
    expect(() => composeMotifSheet([{ tSec: 0, png: a }, { tSec: 1, png: b }])).toThrow(/differ in size/)
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/)
  })
})
