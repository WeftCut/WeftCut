// Hand-rolled readers for the sfnt tables the font catalog needs (no native
// deps): the table directory of a font or of each face of a collection, the
// face's names, weight and italic, a variable font's weight range, its cmap
// coverage, and the extraction of one collection face into a standalone font.
// Every reader works on untrusted bytes and returns null (or skips the bad
// part) instead of throwing. Table layouts: the OpenType spec, chapter by
// table tag.

import type { FaceWeight } from '../../shared/fonts/types.js'

export interface SfntTable { tag: string; checksum: number; offset: number; length: number }

/** One face's table directory over the bytes it was read from. */
export interface SfntFace {
  buf: Buffer
  sfntVersion: number
  /** Face index in a collection; null for a single-face file. */
  ttcIndex: number | null
  /** Tables whose bytes lie inside `buf`; the first record of a repeated tag wins. */
  tables: Map<string, SfntTable>
}

/** TrueType outlines (0x00010000 and Apple's 'true') and CFF ('OTTO'). Type 1
 *  in an sfnt wrapper ('typ1') is left out: browsers do not load it. */
const SFNT_VERSIONS = new Set([0x00010000, 0x74727565, 0x4f54544f])

/** Every face in `buf`: one for a single font, one per readable face of a
 *  `ttcf` collection, none when the bytes are not a font. */
export function readFaces(buf: Buffer): SfntFace[] {
  const count = collectionSize(buf)
  if (count === null) {
    const face = readFace(buf, null)
    return face ? [face] : []
  }
  const faces: SfntFace[] = []
  for (let i = 0; i < count; i++) {
    const face = readFace(buf, i)
    if (face) faces.push(face)
  }
  return faces
}

/** Number of faces in a collection, or null when `buf` is not a collection. */
function collectionSize(buf: Buffer): number | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'ttcf') return null
  const count = buf.readUInt32BE(8)
  return 12 + count * 4 <= buf.length ? count : 0
}

/** The face at `ttcIndex` of a collection, or the single face when
 *  `ttcIndex` is null; null when there is no such readable face. */
export function readFace(buf: Buffer, ttcIndex: number | null): SfntFace | null {
  try {
    let at = 0
    if (ttcIndex !== null) {
      const count = collectionSize(buf)
      if (count === null || ttcIndex < 0 || ttcIndex >= count) return null
      at = buf.readUInt32BE(12 + ttcIndex * 4)
    } else if (collectionSize(buf) !== null) {
      return null
    }
    const sfntVersion = buf.readUInt32BE(at)
    if (!SFNT_VERSIONS.has(sfntVersion)) return null
    const numTables = buf.readUInt16BE(at + 4)
    const tables = new Map<string, SfntTable>()
    for (let i = 0; i < numTables; i++) {
      const rec = at + 12 + i * 16
      const tag = buf.toString('latin1', rec, rec + 4)
      const table = {
        tag,
        checksum: buf.readUInt32BE(rec + 4),
        offset: buf.readUInt32BE(rec + 8),
        length: buf.readUInt32BE(rec + 12),
      }
      if (table.offset + table.length > buf.length || tables.has(tag)) continue
      tables.set(tag, table)
    }
    return { buf, sfntVersion, ttcIndex, tables }
  } catch {
    return null
  }
}

/** Bytes of one table, or null when the face lacks it or it is shorter than
 *  `minLength`. */
function tableBytes(face: SfntFace, tag: string, minLength = 0): Buffer | null {
  const t = face.tables.get(tag)
  if (!t || t.length < minLength) return null
  return face.buf.subarray(t.offset, t.offset + t.length)
}

export interface FaceNames {
  /** nameID 1. */
  family: string[]
  /** nameID 2. */
  subfamily: string[]
  /** nameID 16. */
  typographicFamily: string[]
  /** nameID 17. */
  typographicSubfamily: string[]
}

const NAME_IDS = { 1: 'family', 2: 'subfamily', 16: 'typographicFamily', 17: 'typographicSubfamily' } as const
const EN_US = 0x409

/** The face's family and style names, every language it carries, en-US first.
 *  Unicode and Windows records are UTF-16BE; Mac Roman records count only for
 *  a name ID no Unicode or Windows record carries. Null without a `name`
 *  table. */
export function readNames(face: SfntFace): FaceNames | null {
  const name = tableBytes(face, 'name', 6)
  if (!name) return null
  try {
    const count = name.readUInt16BE(2)
    const storage = name.readUInt16BE(4)
    const found: { id: keyof typeof NAME_IDS; rank: number; text: string }[] = []
    for (let i = 0; i < count; i++) {
      const rec = 6 + i * 12
      if (rec + 12 > name.length) break
      const platformId = name.readUInt16BE(rec)
      const encodingId = name.readUInt16BE(rec + 2)
      const languageId = name.readUInt16BE(rec + 4)
      const nameId = name.readUInt16BE(rec + 6)
      if (!(nameId in NAME_IDS)) continue
      const start = storage + name.readUInt16BE(rec + 10)
      const bytes = name.subarray(start, start + name.readUInt16BE(rec + 8))
      let text: string
      let rank: number
      if (platformId === 0 || (platformId === 3 && (encodingId === 0 || encodingId === 1 || encodingId === 10))) {
        text = utf16be(bytes)
        rank = platformId === 3 && languageId === EN_US ? 0 : 1
      } else if (platformId === 1 && encodingId === 0) {
        text = macRoman(bytes)
        rank = 2
      } else {
        continue
      }
      text = text.replace(/\0/g, '').trim()
      if (text) found.push({ id: nameId as keyof typeof NAME_IDS, rank, text })
    }
    const names: FaceNames = { family: [], subfamily: [], typographicFamily: [], typographicSubfamily: [] }
    for (const id of [1, 2, 16, 17] as const) {
      const ofId = found.filter(n => n.id === id)
      const unicode = ofId.filter(n => n.rank < 2)
      const chosen = (unicode.length ? unicode : ofId).sort((a, b) => a.rank - b.rank)
      names[NAME_IDS[id]] = dedupe(chosen.map(n => n.text))
    }
    return names
  } catch {
    return null
  }
}

function utf16be(bytes: Buffer): string {
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i))
  return out
}

/** Bytes 0x80–0xFF of Mac OS Roman. */
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'

function macRoman(bytes: Buffer): string {
  let out = ''
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : MAC_ROMAN_HIGH[b - 0x80]
  return out
}

/** Case-insensitive dedupe, keeping the first spelling. */
export function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.filter(n => {
    const key = n.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface FaceStyle { weight: number; italic: boolean }

/** Weight and italic from `OS/2` (usWeightClass; fsSelection ITALIC or
 *  OBLIQUE), else from `head.macStyle` (bold → 700), else 400 upright. */
export function readStyle(face: SfntFace): FaceStyle {
  try {
    const os2 = tableBytes(face, 'OS/2', 64)
    if (os2) {
      const fsSelection = os2.readUInt16BE(62)
      return { weight: cssWeight(os2.readUInt16BE(4)), italic: (fsSelection & 0x0201) !== 0 }
    }
    const head = tableBytes(face, 'head', 46)
    if (head) {
      const macStyle = head.readUInt16BE(44)
      return { weight: macStyle & 1 ? 700 : 400, italic: (macStyle & 2) !== 0 }
    }
  } catch {
    // fall through to the default
  }
  return { weight: 400, italic: false }
}

/** usWeightClass on the CSS scale. Some CFF fonts store 1–9 for 100–900, as
 *  Skia also reads them; 0 means unset. */
function cssWeight(usWeightClass: number): number {
  if (usWeightClass === 0) return 400
  if (usWeightClass < 10) return usWeightClass * 100
  return Math.min(usWeightClass, 1000)
}

/** A variable font's `wght` axis as `[min, max]`, or null when the face has
 *  no such axis or it spans a single value. */
export function readWeightAxis(face: SfntFace): [number, number] | null {
  const fvar = tableBytes(face, 'fvar', 16)
  if (!fvar) return null
  try {
    const axesOffset = fvar.readUInt16BE(4)
    const axisCount = fvar.readUInt16BE(8)
    const axisSize = fvar.readUInt16BE(10)
    if (axisSize < 20) return null
    for (let i = 0; i < axisCount; i++) {
      const at = axesOffset + i * axisSize
      if (at + 20 > fvar.length) return null
      if (fvar.toString('latin1', at, at + 4) !== 'wght') continue
      const min = Math.max(1, fvar.readInt32BE(at + 4) / 65536)
      const max = Math.min(1000, fvar.readInt32BE(at + 12) / 65536)
      return min < max ? [min, max] : null
    }
  } catch {
    // no readable axis
  }
  return null
}

export interface FaceIdentity { families: string[]; weight: FaceWeight; italic: boolean }

/** What the catalog keys a face by: every family name (typographic first),
 *  the weight or variable range, and italic. Null for a face with no family
 *  name. */
export function readIdentity(face: SfntFace): FaceIdentity | null {
  const names = readNames(face)
  if (!names) return null
  const families = dedupe([...names.typographicFamily, ...names.family])
  if (!families.length) return null
  const style = readStyle(face)
  return { families, weight: readWeightAxis(face) ?? style.weight, italic: style.italic }
}

/** Code points a face maps to a glyph other than .notdef, as sorted, merged,
 *  inclusive `[start, end]` pairs. */
export interface Coverage { ranges: Uint32Array }

/** Coverage from every Unicode cmap subtable in format 4 (BMP) or 12 (full
 *  range); other formats are ignored. Null without a readable `cmap`. */
export function readCoverage(face: SfntFace): Coverage | null {
  const cmap = tableBytes(face, 'cmap', 4)
  if (!cmap) return null
  try {
    const pairs: [number, number][] = []
    const numTables = cmap.readUInt16BE(2)
    for (let i = 0; i < numTables; i++) {
      const rec = 4 + i * 8
      if (rec + 8 > cmap.length) break
      const platformId = cmap.readUInt16BE(rec)
      const encodingId = cmap.readUInt16BE(rec + 2)
      const unicode = (platformId === 0 && encodingId !== 5) || (platformId === 3 && (encodingId === 1 || encodingId === 10))
      if (!unicode) continue
      const at = cmap.readUInt32BE(rec + 4)
      if (at + 2 > cmap.length) continue
      const format = cmap.readUInt16BE(at)
      if (format === 4) readFormat4(cmap, at, pairs)
      else if (format === 12) readFormat12(cmap, at, pairs)
    }
    return { ranges: mergeRanges(pairs) }
  } catch {
    return null
  }
}

function readFormat4(cmap: Buffer, at: number, out: [number, number][]): void {
  if (at + 14 > cmap.length) return
  const segCount = cmap.readUInt16BE(at + 6) >> 1
  const ends = at + 14
  const starts = ends + segCount * 2 + 2
  const deltas = starts + segCount * 2
  const rangeOffsets = deltas + segCount * 2
  if (rangeOffsets + segCount * 2 > cmap.length) return
  for (let s = 0; s < segCount; s++) {
    const start = cmap.readUInt16BE(starts + s * 2)
    const end = cmap.readUInt16BE(ends + s * 2)
    const delta = cmap.readUInt16BE(deltas + s * 2)
    const rangeOffsetAt = rangeOffsets + s * 2
    const rangeOffset = cmap.readUInt16BE(rangeOffsetAt)
    let runStart = -1
    for (let c = start; c <= end && c < 0xffff; c++) {
      let glyph: number
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xffff
      } else {
        const glyphAt = rangeOffsetAt + rangeOffset + (c - start) * 2
        glyph = glyphAt + 2 <= cmap.length ? cmap.readUInt16BE(glyphAt) : 0
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff
      }
      if (glyph !== 0 && runStart < 0) runStart = c
      if (glyph === 0 && runStart >= 0) {
        out.push([runStart, c - 1])
        runStart = -1
      }
    }
    if (runStart >= 0) out.push([runStart, Math.min(end, 0xfffe)])
  }
}

function readFormat12(cmap: Buffer, at: number, out: [number, number][]): void {
  if (at + 16 > cmap.length) return
  const groups = cmap.readUInt32BE(at + 12)
  if (at + 16 + groups * 12 > cmap.length) return
  for (let g = 0; g < groups; g++) {
    const rec = at + 16 + g * 12
    const start = cmap.readUInt32BE(rec)
    const end = Math.min(cmap.readUInt32BE(rec + 4), 0x10ffff)
    // A group starting at glyph 0 maps its first code point to .notdef.
    const first = cmap.readUInt32BE(rec + 8) === 0 ? start + 1 : start
    if (first <= end) out.push([first, end])
  }
}

function mergeRanges(pairs: [number, number][]): Uint32Array {
  pairs.sort((a, b) => a[0] - b[0])
  const merged: number[] = []
  for (const [start, end] of pairs) {
    const last = merged.length - 1
    if (last > 0 && start <= (merged[last] as number) + 1) {
      merged[last] = Math.max(merged[last] as number, end)
    } else {
      merged.push(start, end)
    }
  }
  return Uint32Array.from(merged)
}

export function hasGlyph(coverage: Coverage, codePoint: number): boolean {
  const r = coverage.ranges
  let lo = 0
  let hi = r.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (codePoint < (r[mid * 2] as number)) hi = mid - 1
    else if (codePoint > (r[mid * 2 + 1] as number)) lo = mid + 1
    else return true
  }
  return false
}

/** One face of a collection as a standalone single-face font; a single-face
 *  file is returned as is for index 0. Null when there is no such face.
 *
 *  The table directory is rebuilt in tag order with 4-byte aligned, zero-padded
 *  tables; a table two records share is copied once. `DSIG` is dropped: it
 *  signs the collection's bytes, not these. Table checksums are recomputed,
 *  and so is `head.checkSumAdjustment`, over the new file. */
export function extractFace(buf: Buffer, ttcIndex: number): Buffer | null {
  if (collectionSize(buf) === null) return ttcIndex === 0 && readFace(buf, null) ? buf : null
  const face = readFace(buf, ttcIndex)
  if (!face) return null
  const tables = [...face.tables.values()]
    .filter(t => t.tag !== 'DSIG')
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  const n = tables.length
  const placed = new Map<string, number>()
  let size = 12 + n * 16
  for (const t of tables) {
    const key = `${t.offset}:${t.length}`
    if (placed.has(key)) continue
    placed.set(key, size)
    size += (t.length + 3) & ~3
  }
  const out = Buffer.alloc(size)
  const log2 = n > 0 ? Math.floor(Math.log2(n)) : 0
  const searchRange = n > 0 ? 16 * 2 ** log2 : 0
  out.writeUInt32BE(face.sfntVersion, 0)
  out.writeUInt16BE(n, 4)
  out.writeUInt16BE(searchRange, 6)
  out.writeUInt16BE(log2, 8)
  out.writeUInt16BE(n * 16 - searchRange, 10)
  for (const t of tables) buf.copy(out, placed.get(`${t.offset}:${t.length}`) as number, t.offset, t.offset + t.length)
  const head = tables.find(t => t.tag === 'head' && t.length >= 12)
  const headAt = head ? (placed.get(`${head.offset}:${head.length}`) as number) : -1
  if (headAt >= 0) out.writeUInt32BE(0, headAt + 8)
  tables.forEach((t, i) => {
    const at = placed.get(`${t.offset}:${t.length}`) as number
    const rec = 12 + i * 16
    out.write(t.tag, rec, 4, 'latin1')
    out.writeUInt32BE(checksum(out, at, t.length), rec + 4)
    out.writeUInt32BE(at, rec + 8)
    out.writeUInt32BE(t.length, rec + 12)
  })
  if (headAt >= 0) out.writeUInt32BE((0xb1b0afba - checksum(out, 0, size)) >>> 0, headAt + 8)
  return out
}

/** The OpenType table checksum: the sum of big-endian uint32 words, the last
 *  one zero-padded. */
function checksum(buf: Buffer, at: number, length: number): number {
  let sum = 0
  const end = at + length
  for (let i = at; i < end; i += 4) {
    let word = 0
    for (let b = 0; b < 4; b++) word = (word << 8) | (i + b < end ? (buf[i + b] as number) : 0)
    sum = (sum + (word >>> 0)) >>> 0
  }
  return sum
}
