/// The capture host's frame identity (ADR 0078). The host page is a shell that
/// frames the Motif at the capture size and keeps one extra pixel row below it.
/// After each frame's seek, in the same task, the shell writes the frame's id
/// into that row; the main process takes the first shared texture whose row
/// carries the id. A texture showing the id was drawn from that seek's commit
/// or a later one, so no settle wait or surface fence is involved.

/// Served by `motif://` beside each Motif's `index.html`, which it frames.
export const CAPTURE_HOST_FILE = '.weftcut-capture-host.html'

/// Rows the host surface adds below the Motif's picture.
export const FRAME_MARKER_ROWS = 1

/// Pixels the id occupies at the start of the marker row: an 8-bit magic, the
/// 32-bit id and an 8-bit check, one bit per opaque black or white pixel.
export const FRAME_MARKER_PIXELS = 48

/// The id's pixel bits, most significant first. Embedded into the page runtime
/// by `toString()`, so it must stay self-contained: no outer names or imports.
export function frameMarkerBits(id: number): number[] {
  const bytes = [0xa5, (id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255]
  bytes.push(0x5a ^ bytes[1]! ^ bytes[2]! ^ bytes[3]! ^ bytes[4]!)
  const bits: number[] = []
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >> bit) & 1)
  return bits
}

/// The id in `rgba` (straight or premultiplied RGBA of the marker row's first
/// FRAME_MARKER_PIXELS), or null when the row holds no complete marker.
export function decodeFrameMarker(rgba: Uint8Array): number | null {
  if (rgba.length < FRAME_MARKER_PIXELS * 4) return null
  const bytes: number[] = []
  for (let b = 0; b < FRAME_MARKER_PIXELS / 8; b++) {
    let value = 0
    for (let i = 0; i < 8; i++) {
      const o = (b * 8 + i) * 4
      if (rgba[o + 3] !== 255) return null
      const on = rgba[o]! > 127
      if ((rgba[o + 1]! > 127) !== on || (rgba[o + 2]! > 127) !== on) return null
      value = (value << 1) | (on ? 1 : 0)
    }
    bytes.push(value)
  }
  if (bytes[0] !== 0xa5 || (0x5a ^ bytes[1]! ^ bytes[2]! ^ bytes[3]! ^ bytes[4]!) !== bytes[5]) return null
  return ((bytes[1]! << 24) | (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]!) >>> 0
}
