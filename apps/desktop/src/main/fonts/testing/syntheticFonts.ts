// Test-only builders for minimal sfnt fonts: just the tables the catalog
// reads (name, OS/2, head, fvar, cmap), laid out per the OpenType spec. No
// glyph data: these fonts parse, they do not draw.

export interface NameSpec {
  id: number
  text: string
  /** Windows (UTF-16BE) by default; 'mac' writes a Mac Roman record. */
  platform?: 'windows' | 'mac'
  /** Windows language ID; en-US by default. */
  language?: number
}

export function nameTable(names: readonly NameSpec[]): Buffer {
  const strings = names.map(n => n.platform === 'mac' ? macRoman(n.text) : Buffer.from(n.text, 'utf16le').swap16())
  const header = Buffer.alloc(6 + names.length * 12)
  header.writeUInt16BE(names.length, 2)
  header.writeUInt16BE(header.length, 4)
  let offset = 0
  names.forEach((n, i) => {
    const rec = 6 + i * 12
    const mac = n.platform === 'mac'
    header.writeUInt16BE(mac ? 1 : 3, rec)
    header.writeUInt16BE(mac ? 0 : 1, rec + 2)
    header.writeUInt16BE(mac ? 0 : n.language ?? 0x409, rec + 4)
    header.writeUInt16BE(n.id, rec + 6)
    header.writeUInt16BE((strings[i] as Buffer).length, rec + 8)
    header.writeUInt16BE(offset, rec + 10)
    offset += (strings[i] as Buffer).length
  })
  return Buffer.concat([header, ...strings])
}

function macRoman(text: string): Buffer {
  // Enough of Mac Roman for tests: ASCII plus é (0x8E).
  return Buffer.from([...text].map(ch => ch === 'é' ? 0x8e : ch.charCodeAt(0)))
}

export function os2Table(weight: number, style: { italic?: boolean; oblique?: boolean } = {}): Buffer {
  const t = Buffer.alloc(96)
  t.writeUInt16BE(4, 0)
  t.writeUInt16BE(weight, 4)
  t.writeUInt16BE((style.italic ? 0x1 : 0) | (style.oblique ? 0x200 : 0) | (style.italic || style.oblique ? 0 : 0x40), 62)
  return t
}

export function headTable(macStyle: { bold?: boolean; italic?: boolean } = {}): Buffer {
  const t = Buffer.alloc(54)
  t.writeUInt32BE(0x00010000, 0)
  t.writeUInt32BE(0x5f0f3cf5, 12)
  t.writeUInt16BE((macStyle.bold ? 1 : 0) | (macStyle.italic ? 2 : 0), 44)
  return t
}

export function fvarTable(axes: readonly { tag: string; min: number; def: number; max: number }[]): Buffer {
  const t = Buffer.alloc(16 + axes.length * 20)
  t.writeUInt16BE(1, 0)
  t.writeUInt16BE(16, 4)
  t.writeUInt16BE(2, 6)
  t.writeUInt16BE(axes.length, 8)
  t.writeUInt16BE(20, 10)
  axes.forEach((a, i) => {
    const at = 16 + i * 20
    t.write(a.tag, at, 4, 'latin1')
    t.writeInt32BE(a.min * 65536, at + 4)
    t.writeInt32BE(a.def * 65536, at + 8)
    t.writeInt32BE(a.max * 65536, at + 12)
  })
  return t
}

/** A format 4 segment: glyphs from `idDelta` (ids 1…) unless `glyphs` gives
 *  each code point's glyph id through the glyph array (0 = not drawn), to
 *  which a nonzero entry adds `delta`. */
export interface Format4Segment { start: number; end: number; glyphs?: readonly number[]; delta?: number }

export function cmapFormat4(segments: readonly Format4Segment[]): Buffer {
  const segs = [...segments, { start: 0xffff, end: 0xffff }]
  const n = segs.length
  const glyphArray: number[] = []
  const rangeOffsets: number[] = []
  segs.forEach((s, i) => {
    if ('glyphs' in s && s.glyphs) {
      rangeOffsets.push((16 + 8 * n + glyphArray.length * 2) - (16 + 6 * n + i * 2))
      glyphArray.push(...s.glyphs)
    } else {
      rangeOffsets.push(0)
    }
  })
  const t = Buffer.alloc(16 + 8 * n + glyphArray.length * 2)
  t.writeUInt16BE(4, 0)
  t.writeUInt16BE(t.length, 2)
  t.writeUInt16BE(n * 2, 6)
  segs.forEach((s, i) => {
    t.writeUInt16BE(s.end, 14 + i * 2)
    t.writeUInt16BE(s.start, 16 + 2 * n + i * 2)
    const delta = 'glyphs' in s && s.glyphs ? ('delta' in s ? s.delta ?? 0 : 0) & 0xffff : s.start === 0xffff ? 1 : (1 - s.start) & 0xffff
    t.writeUInt16BE(delta, 16 + 4 * n + i * 2)
    t.writeUInt16BE(rangeOffsets[i] as number, 16 + 6 * n + i * 2)
  })
  glyphArray.forEach((g, i) => t.writeUInt16BE(g, 16 + 8 * n + i * 2))
  return t
}

export function cmapFormat12(groups: readonly { start: number; end: number; glyph: number }[]): Buffer {
  const t = Buffer.alloc(16 + groups.length * 12)
  t.writeUInt16BE(12, 0)
  t.writeUInt32BE(t.length, 4)
  t.writeUInt32BE(groups.length, 12)
  groups.forEach((g, i) => {
    t.writeUInt32BE(g.start, 16 + i * 12)
    t.writeUInt32BE(g.end, 20 + i * 12)
    t.writeUInt32BE(g.glyph, 24 + i * 12)
  })
  return t
}

export function cmapTable(subtables: readonly { platform: number; encoding: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(4 + subtables.length * 8)
  header.writeUInt16BE(subtables.length, 2)
  let offset = header.length
  subtables.forEach((s, i) => {
    header.writeUInt16BE(s.platform, 4 + i * 8)
    header.writeUInt16BE(s.encoding, 6 + i * 8)
    header.writeUInt32BE(offset, 8 + i * 8)
    offset += s.data.length
  })
  return Buffer.concat([header, ...subtables.map(s => s.data)])
}

const pad4 = (n: number) => (n + 3) & ~3

/** Table directory records for `tables` placed from `dataStart`, plus where
 *  each table's bytes go. A Buffer passed twice (the same object) is placed
 *  once, as a collection shares a table. */
function layout(tables: Record<string, Buffer>, place: Map<Buffer, number>, cursor: { at: number }) {
  const tags = Object.keys(tables).sort()
  const records = Buffer.alloc(tags.length * 16)
  tags.forEach((tag, i) => {
    const data = tables[tag] as Buffer
    if (!place.has(data)) {
      place.set(data, cursor.at)
      cursor.at += pad4(data.length)
    }
    records.write(tag, i * 16, 4, 'latin1')
    records.writeUInt32BE(place.get(data) as number, i * 16 + 8)
    records.writeUInt32BE(data.length, i * 16 + 12)
  })
  return { tags, records }
}

function offsetTable(numTables: number, version: number): Buffer {
  const t = Buffer.alloc(12)
  t.writeUInt32BE(version, 0)
  t.writeUInt16BE(numTables, 4)
  return t
}

function writeTables(out: Buffer, place: Map<Buffer, number>): void {
  for (const [data, at] of place) data.copy(out, at)
}

export function sfnt(tables: Record<string, Buffer>, version = 0x00010000): Buffer {
  const place = new Map<Buffer, number>()
  const cursor = { at: 12 + Object.keys(tables).length * 16 }
  const { tags, records } = layout(tables, place, cursor)
  const out = Buffer.alloc(cursor.at)
  offsetTable(tags.length, version).copy(out, 0)
  records.copy(out, 12)
  writeTables(out, place)
  return out
}

/** A `ttcf` collection; a table Buffer shared between faces is stored once. */
export function ttc(faces: readonly Record<string, Buffer>[]): Buffer {
  const place = new Map<Buffer, number>()
  const header = 12 + faces.length * 4
  let dirAt = header
  const dirOffsets = faces.map(f => {
    const at = dirAt
    dirAt += 12 + Object.keys(f).length * 16
    return at
  })
  const cursor = { at: dirAt }
  const dirs = faces.map(f => layout(f, place, cursor))
  const out = Buffer.alloc(cursor.at)
  out.write('ttcf', 0, 4, 'latin1')
  out.writeUInt32BE(0x00010000, 4)
  out.writeUInt32BE(faces.length, 8)
  dirs.forEach((d, i) => {
    const at = dirOffsets[i] as number
    out.writeUInt32BE(at, 12 + i * 4)
    offsetTable(d.tags.length, 0x00010000).copy(out, at)
    d.records.copy(out, at + 12)
  })
  writeTables(out, place)
  return out
}

export interface FontSpec {
  family: string
  subfamily?: string
  /** nameID 16; nameID 17 is `subfamily` when set. */
  typographicFamily?: string
  weight?: number
  italic?: boolean
  /** Leave out OS/2 (and with it weight and italic) to test the head fallback. */
  noOs2?: boolean
  macStyle?: { bold?: boolean; italic?: boolean }
  weightAxis?: { min: number; def: number; max: number }
  cmap?: Buffer
}

/** The tables of one face. */
export function faceTables(spec: FontSpec): Record<string, Buffer> {
  const names: NameSpec[] = [{ id: 1, text: spec.family }, { id: 2, text: spec.italic ? 'Italic' : 'Regular' }]
  if (spec.typographicFamily) {
    names.push({ id: 16, text: spec.typographicFamily }, { id: 17, text: spec.subfamily ?? 'Regular' })
  }
  const tables: Record<string, Buffer> = {
    head: headTable(spec.macStyle),
    name: nameTable(names),
    cmap: spec.cmap ?? cmapTable([{ platform: 3, encoding: 1, data: cmapFormat4([{ start: 0x41, end: 0x5a }]) }]),
  }
  if (!spec.noOs2) tables['OS/2'] = os2Table(spec.weight ?? 400, { italic: spec.italic })
  if (spec.weightAxis) tables['fvar'] = fvarTable([{ tag: 'wght', ...spec.weightAxis }])
  return tables
}

export function font(spec: FontSpec): Buffer {
  return sfnt(faceTables(spec))
}
