/// The capture host's frame identity (ADR 0078). The host page is a shell that
/// frames the Motif at the capture size and keeps marker rows below it. After
/// each frame's seek, in the same task, the shell writes the frame's id into
/// those rows, and a canvas paints the id's witness after it; the main process
/// takes the first paint whose rows carry both. A paint showing the id
/// was drawn from that seek's commit or a later one, and the witness proves the
/// commit holds the page's canvases, so no settle wait or surface fence is
/// involved.

/// Served by `motif://` beside each Motif's `index.html`, which it frames.
export const CAPTURE_HOST_FILE = '.weftcut-capture-host.html'

/// Pixels the id occupies at the start of the marker rows: an 8-bit magic, the
/// 32-bit id and an 8-bit check, one bit per opaque black or white pixel.
export const FRAME_MARKER_PIXELS = 48

/// Pixels after the id that a canvas in the capture host paints with the id's
/// low byte, one bit per opaque black or white pixel. The id is DOM; a new
/// window's first commits can carry it while every canvas of the page, the
/// Motif's included, is still missing, and that commit never fills in
/// (docs/notes/electron-chromium-behavior.md#a-new-capture-windows-first-commits-can-omit-its-canvases).
/// A commit that shows the witness for its id shows the page's canvases.
export const FRAME_WITNESS_PIXELS = 8

/// The marker pixels main reads: the id, then the canvas witness.
export const FRAME_MARKER_READ_PIXELS = FRAME_MARKER_PIXELS + FRAME_WITNESS_PIXELS

/// Rows the host surface adds below a `width`-pixel picture. The marker pixels
/// run left to right and wrap onto the next row, so a picture narrower than the
/// marker still carries it whole while the surface keeps the picture's width:
/// every reader takes the picture as the surface's top rows.
export function frameMarkerRows(width: number): number {
  return Math.ceil(FRAME_MARKER_READ_PIXELS / width)
}

/// The id's pixel bits, most significant first. Embedded into the page runtime
/// by `toString()`, so it must stay self-contained: no outer names or imports.
export function frameMarkerBits(id: number): number[] {
  const bytes = [0xa5, (id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255]
  bytes.push(0x5a ^ bytes[1]! ^ bytes[2]! ^ bytes[3]! ^ bytes[4]!)
  const bits: number[] = []
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >> bit) & 1)
  return bits
}

/// The id in `rgba` (straight or premultiplied RGBA of the marker rows, row
/// after row, from their first pixel), or null when they hold no complete
/// marker.
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

/// The witness's pixel bits for `id`, most significant first. Embedded into the
/// page runtime by `toString()`, like `frameMarkerBits`.
export function frameWitnessBits(id: number): number[] {
  const bits: number[] = []
  for (let bit = 7; bit >= 0; bit--) bits.push((id >> bit) & 1)
  return bits
}

/// Whether the marker rows `rgba` (as for `decodeFrameMarker`, any channel
/// order) carry the canvas witness of `id`.
export function frameWitnessed(rgba: Uint8Array, id: number): boolean {
  if (rgba.length < FRAME_MARKER_READ_PIXELS * 4) return false
  const bits = frameWitnessBits(id)
  for (let i = 0; i < FRAME_WITNESS_PIXELS; i++) {
    const o = (FRAME_MARKER_PIXELS + i) * 4
    if (rgba[o + 3] !== 255) return false
    const on = rgba[o]! > 127
    if ((rgba[o + 1]! > 127) !== on || (rgba[o + 2]! > 127) !== on || on !== (bits[i] === 1)) return false
  }
  return true
}
