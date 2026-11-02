// apps/desktop/src/main/mcp/motifSheet.ts
//
// `preview_motif { local_t_s: [...] }` answers one labelled contact sheet, laid
// out as `render_frames` lays out its own (renderer/app/stillsSheet.ts): at
// most four columns, each frame under a label strip with its time, never
// over the picture. A Motif frame is an overlay with alpha, so the sheet stays
// a PNG and each cell keeps the frame's own transparency.
//
// Pure: PNG bytes in, PNG bytes out (fflate for the zlib streams). The capture
// hands 8-bit RGBA or RGB PNGs; anything else is refused, not guessed.
import { unzlibSync, zlibSync } from 'fflate'

export const SHEET_MAX_COLUMNS = 4
export const SHEET_LABEL_PX = 26

export interface Rgba { width: number; height: number; pixels: Uint8Array }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Decode a non-interlaced 8-bit RGBA or RGB PNG to RGBA. */
export function decodePng(png: Uint8Array): Rgba {
  if (png.length < 33 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error('the captured frame is not a PNG')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = 8, width = 0, height = 0, channels = 0
  const idat: Uint8Array[] = []
  while (at + 8 <= png.length) {
    const len = view.getUint32(at), type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12)
      const depth = data[8], color = data[9], interlace = data[12]
      if (depth !== 8 || (color !== 6 && color !== 2) || interlace !== 0) throw new Error(`unsupported PNG frame (bit depth ${depth}, colour type ${color}, interlace ${interlace})`)
      channels = color === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!channels || !idat.length) throw new Error('the captured PNG has no image data')
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of idat) { joined.set(c, o); o += c.length }
  const raw = unzlibSync(joined)
  const stride = width * channels
  const rows = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = rows.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0, b = prev ? prev[x]! : 0, c = prev && x >= channels ? prev[x - channels]! : 0
      const v = src[x]!
      switch (filter) {
        case 0: cur[x] = v; break
        case 1: cur[x] = v + a; break
        case 2: cur[x] = v + b; break
        case 3: cur[x] = v + ((a + b) >> 1); break
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); cur[x] = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break }
        default: throw new Error(`bad PNG filter ${filter}`)
      }
    }
  }
  if (channels === 4) return { width, height, pixels: rows }
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) { pixels[j] = rows[i]!; pixels[j + 1] = rows[i + 1]!; pixels[j + 2] = rows[i + 2]!; pixels[j + 3] = 255 }
  return { width, height, pixels }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encode RGBA as an 8-bit RGBA PNG. */
export function encodePng(img: Rgba): Uint8Array {
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, img.width); v.setUint32(4, img.height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const stride = img.width * 4
  const raw = new Uint8Array(img.height * (stride + 1))
  for (let y = 0; y < img.height; y++) raw.set(img.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** A 5×7 face for the label strip: digits and the few marks a time needs. */
const GLYPHS: Record<string, number[]> = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12], '.': [0, 0, 0, 0, 0, 12, 12], 's': [0, 0, 15, 16, 14, 1, 30],
  '-': [0, 0, 0, 31, 0, 0, 0], ' ': [0, 0, 0, 0, 0, 0, 0],
}
const GLYPH_SCALE = 2

export const sheetLabel = (tSec: number) => `${tSec.toFixed(2)} s`

function drawLabel(sheet: Rgba, text: string, x0: number, y0: number, xMax: number): void {
  let x = x0
  for (const ch of text) {
    const rows = GLYPHS[ch] ?? GLYPHS[' ']!
    rows.forEach((bits, ry) => {
      for (let rx = 0; rx < 5; rx++) {
        if (!(bits & (16 >> rx))) continue
        for (let dy = 0; dy < GLYPH_SCALE; dy++) for (let dx = 0; dx < GLYPH_SCALE; dx++) {
          const px = x + rx * GLYPH_SCALE + dx, py = y0 + ry * GLYPH_SCALE + dy
          if (px >= xMax || py >= sheet.height) continue
          sheet.pixels.fill(255, (py * sheet.width + px) * 4, (py * sheet.width + px) * 4 + 4)
        }
      }
    })
    x += 6 * GLYPH_SCALE
  }
}

export function sheetLayout(count: number, frameW: number, frameH: number) {
  const columns = Math.max(1, Math.min(SHEET_MAX_COLUMNS, count))
  const rows = Math.max(1, Math.ceil(count / columns))
  return { columns, rows, width: columns * frameW, height: rows * (frameH + SHEET_LABEL_PX) }
}

/** Lay equal-size frames out with a time label above each. */
export function composeMotifSheet(frames: ReadonlyArray<{ tSec: number; png: Uint8Array }>): { png: Uint8Array; width: number; height: number; columns: number } {
  const tiles = frames.map((f) => decodePng(f.png))
  const w = tiles[0]!.width, h = tiles[0]!.height
  if (tiles.some((t) => t.width !== w || t.height !== h)) throw new Error('the captured frames differ in size')
  const layout = sheetLayout(tiles.length, w, h)
  const sheet: Rgba = { width: layout.width, height: layout.height, pixels: new Uint8Array(layout.width * layout.height * 4) }
  tiles.forEach((tile, i) => {
    const x = (i % layout.columns) * w, y = Math.floor(i / layout.columns) * (h + SHEET_LABEL_PX)
    for (let ly = 0; ly < SHEET_LABEL_PX; ly++) {
      const row = ((y + ly) * sheet.width + x) * 4
      for (let lx = 0; lx < w; lx++) sheet.pixels.set([30, 30, 30, 255], row + lx * 4)
    }
    drawLabel(sheet, sheetLabel(frames[i]!.tSec), x + 8, y + 6, x + w)
    for (let ty = 0; ty < h; ty++) sheet.pixels.set(tile.pixels.subarray(ty * w * 4, (ty + 1) * w * 4), ((y + SHEET_LABEL_PX + ty) * sheet.width + x) * 4)
  })
  return { png: encodePng(sheet), width: layout.width, height: layout.height, columns: layout.columns }
}
