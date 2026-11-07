import { crc32, deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/// Bytes per pixel of 8-bit, non-interlaced PNG color types.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** `png` without its bottom `rows` rows, pixel for pixel. A scanline's filter
 * reads only the line above it, so the kept lines' bytes stay valid as they
 * are: no pixel is decoded or re-encoded. 8-bit, non-interlaced only, which is
 * what Chromium's screenshots are. */
export function dropPngRows(png: Buffer, rows: number): Buffer {
  if (rows === 0) return png
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  const kept: Buffer[] = []
  const idat: Buffer[] = []
  let width = 0, height = 0, pixelBytes = 0
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    at += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      const depth = data[8], color = data[9], interlace = data[12]
      pixelBytes = depth === 8 && interlace === 0 ? CHANNELS[color!] ?? 0 : 0
      if (!pixelBytes) throw new Error(`unsupported PNG layout (depth ${depth}, color ${color}, interlace ${interlace})`)
      if (rows >= height) throw new Error(`cannot drop ${rows} of ${height} rows`)
      const header = Buffer.from(data)
      header.writeUInt32BE(height - rows, 4)
      kept.push(chunk('IHDR', header))
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    else if (!idat.length) kept.push(png.subarray(at - 12 - length, at))
  }
  const lines = inflateSync(Buffer.concat(idat))
  const line = 1 + width * pixelBytes
  if (lines.length !== line * height) throw new Error('PNG image data does not match its header')
  return Buffer.concat([SIGNATURE, ...kept, chunk('IDAT', deflateSync(lines.subarray(0, line * (height - rows)), { level: 1 })), chunk('IEND', Buffer.alloc(0))])
}
