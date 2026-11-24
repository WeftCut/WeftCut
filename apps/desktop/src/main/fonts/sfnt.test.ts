// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractFace, hasGlyph, readCoverage, readFace, readFaces, readIdentity, readNames, readStyle } from './sfnt.js'
import { cmapFormat12, cmapFormat4, cmapTable, faceTables, font, headTable, nameTable, sfnt, ttc } from './testing/syntheticFonts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function only(buf: Buffer) {
  const faces = readFaces(buf)
  expect(faces).toHaveLength(1)
  return faces[0]!
}

describe('face identity', () => {
  it('a static SemiBold answers to its typographic family first, then its legacy family', () => {
    const face = only(font({ family: 'Example Sans SemiBold', typographicFamily: 'Example Sans', subfamily: 'SemiBold', weight: 600 }))
    expect(readIdentity(face)).toEqual({ families: ['Example Sans', 'Example Sans SemiBold'], weight: 600, italic: false })
  })

  it('a family repeated across name IDs and languages is listed once, en-US spelling first', () => {
    const face = only(sfnt({
      name: nameTable([
        { id: 1, text: 'Beispiel', language: 0x407 },
        { id: 1, text: 'Example', language: 0x409 },
        { id: 16, text: 'EXAMPLE', language: 0x409 },
        { id: 1, text: 'Mac Only', platform: 'mac' },
      ]),
    }))
    expect(readIdentity(face)?.families).toEqual(['EXAMPLE', 'Beispiel'])
  })

  it('Mac Roman names count only for a name ID no Windows record carries', () => {
    const face = only(sfnt({ name: nameTable([{ id: 1, text: 'Café Mac', platform: 'mac' }, { id: 2, text: 'Regular' }]) }))
    expect(readNames(face)?.family).toEqual(['Café Mac'])
  })

  it('italic comes from OS/2 fsSelection, and from head.macStyle when OS/2 is missing', () => {
    expect(readStyle(only(font({ family: 'A', italic: true, weight: 300 })))).toEqual({ weight: 300, italic: true })
    expect(readStyle(only(font({ family: 'A', noOs2: true, macStyle: { italic: true, bold: true } })))).toEqual({ weight: 700, italic: true })
    expect(readStyle(only(font({ family: 'A', noOs2: true })))).toEqual({ weight: 400, italic: false })
  })

  it('a face is italic when macStyle or its subfamily name says so, though OS/2 fsSelection does not', () => {
    // As macOS's Avenir Next Bold Italic: OS/2 present, its ITALIC bit clear.
    const boldItalic = sfnt({ ...faceTables({ family: 'Avenir Next', weight: 700 }), head: headTable({ bold: true, italic: true }) })
    expect(readStyle(only(boldItalic))).toEqual({ weight: 700, italic: true })
    // As its Ultra Light Italic: only the names say italic.
    const ultraLightItalic = font({ family: 'Avenir Next Ultra Light', typographicFamily: 'Avenir Next', subfamily: 'Ultra Light Italic', weight: 275 })
    expect(readStyle(only(ultraLightItalic))).toEqual({ weight: 275, italic: true })
    // Its upright faces stay upright.
    expect(readStyle(only(font({ family: 'Avenir Next Ultra Light', typographicFamily: 'Avenir Next', subfamily: 'Ultra Light', weight: 275 })))).toEqual({ weight: 275, italic: false })
  })

  it("a variable font's identity carries its wght range, not the default instance", () => {
    const face = only(font({ family: 'Flex', weight: 400, weightAxis: { min: 100, def: 400, max: 900 } }))
    expect(readIdentity(face)?.weight).toEqual([100, 900])
  })

  it('reads the bundled variable CJK font', () => {
    const buf = fs.readFileSync(path.resolve(__dirname, '../../../assets/fonts/NotoSansSC-VF.ttf'))
    const identity = readIdentity(only(buf))
    expect(identity?.families.map(f => f.toLowerCase())).toContain('noto sans sc')
    expect(Array.isArray(identity?.weight)).toBe(true)
    const coverage = readCoverage(only(buf))!
    expect(hasGlyph(coverage, '中'.codePointAt(0)!)).toBe(true)
  })
})

describe('cmap coverage', () => {
  it('format 4 covers its segments, minus code points mapped to glyph 0', () => {
    const cmap = cmapTable([{ platform: 3, encoding: 1, data: cmapFormat4([
      { start: 0x41, end: 0x43 },
      { start: 0x61, end: 0x64, glyphs: [5, 0, 6, 7] },
    ]) }])
    const coverage = readCoverage(only(font({ family: 'A', cmap })))!
    const covered = [0x40, 0x41, 0x43, 0x44, 0x61, 0x62, 0x63, 0x64].filter(c => hasGlyph(coverage, c))
    expect(covered).toEqual([0x41, 0x43, 0x61, 0x63, 0x64])
  })

  it('format 12 covers code points beyond the BMP, and its union with format 4', () => {
    const cmap = cmapTable([
      { platform: 3, encoding: 1, data: cmapFormat4([{ start: 0x41, end: 0x41 }]) },
      { platform: 3, encoding: 10, data: cmapFormat12([{ start: 0x1f600, end: 0x1f602, glyph: 3 }, { start: 0x20000, end: 0x20001, glyph: 0 }]) },
    ])
    const coverage = readCoverage(only(font({ family: 'A', cmap })))!
    const probes = [0x41, 0x42, 0x1f5ff, 0x1f600, 0x1f602, 0x1f603, 0x20000, 0x20001]
    expect(probes.filter(c => hasGlyph(coverage, c))).toEqual([0x41, 0x1f600, 0x1f602, 0x20001])
  })

  it('format 4 adds idDelta to a glyph-array entry, so an entry can land on glyph 0', () => {
    const cmap = cmapTable([{ platform: 3, encoding: 1, data: cmapFormat4([{ start: 0x61, end: 0x62, glyphs: [5, 6], delta: -5 }]) }])
    const coverage = readCoverage(only(font({ family: 'A', cmap })))!
    expect([0x61, 0x62].filter(c => hasGlyph(coverage, c))).toEqual([0x62])
  })

  it('non-Unicode subtables other than the Windows symbol one are ignored', () => {
    const cmap = cmapTable([{ platform: 1, encoding: 0, data: cmapFormat4([{ start: 0x41, end: 0x41 }]) }])
    expect(hasGlyph(readCoverage(only(font({ family: 'A', cmap })))!, 0x41)).toBe(false)
  })

  it('a symbol font covers its U+F0xx codes and the low bytes they stand for', () => {
    const cmap = cmapTable([{ platform: 3, encoding: 0, data: cmapFormat4([{ start: 0xf041, end: 0xf042 }]) }])
    const coverage = readCoverage(only(font({ family: 'Symbols', cmap })))!
    expect([0xf041, 0xf042, 0x41, 0x42].every(c => hasGlyph(coverage, c))).toBe(true)
    expect([0xf043, 0x43].some(c => hasGlyph(coverage, c))).toBe(false)
  })
})

describe('collections', () => {
  const shared = cmapTable([{ platform: 3, encoding: 1, data: cmapFormat4([{ start: 0x30, end: 0x39 }]) }])
  const regular = { ...faceTables({ family: 'Pair', weight: 400 }), cmap: shared }
  const bold = { ...faceTables({ family: 'Pair', weight: 700 }), cmap: shared }
  const collection = ttc([regular, bold])

  it('reads each face of a collection with its own identity', () => {
    const faces = readFaces(collection)
    expect(faces.map(f => [f.ttcIndex, readIdentity(f)?.weight])).toEqual([[0, 400], [1, 700]])
  })

  it('an extracted face is a standalone font with the source face identity and tables', () => {
    const source = readFace(collection, 1)!
    const out = extractFace(collection, 1)!
    const face = only(out)
    expect(face.ttcIndex).toBeNull()
    expect(readIdentity(face)).toEqual(readIdentity(source))
    expect([...face.tables.keys()].sort()).toEqual([...source.tables.keys()].sort())
    for (const [tag, t] of source.tables) {
      const copy = face.tables.get(tag)!
      expect(copy.offset % 4, `${tag} is 4-byte aligned`).toBe(0)
      if (tag === 'head') continue
      expect(out.subarray(copy.offset, copy.offset + copy.length).equals(collection.subarray(t.offset, t.offset + t.length)), tag).toBe(true)
    }
  })

  it("an extracted face's checksums hold: each table's, and the file's through head.checkSumAdjustment", () => {
    const out = extractFace(collection, 0)!
    const sum = (at: number, length: number) => {
      let s = 0
      for (let i = at; i < at + length; i += 4) {
        const word = Buffer.alloc(4)
        out.copy(word, 0, i, Math.min(i + 4, at + length))
        s = (s + word.readUInt32BE(0)) >>> 0
      }
      return s
    }
    const face = only(out)
    const head = face.tables.get('head')!
    const adjustment = out.readUInt32BE(head.offset + 8)
    for (const t of face.tables.values()) {
      const expected = t.tag === 'head' ? (sum(t.offset, t.length) - adjustment) >>> 0 : sum(t.offset, t.length)
      expect(t.checksum, t.tag).toBe(expected)
    }
    expect(sum(0, out.length)).toBe(0xb1b0afba)
  })

  it('a single-face file extracts as itself at index 0 only', () => {
    const single = font({ family: 'Solo' })
    expect(extractFace(single, 0)).toBe(single)
    expect(extractFace(single, 1)).toBeNull()
    expect(extractFace(collection, 2)).toBeNull()
  })
})

describe('malformed input', () => {
  const good = font({ family: 'Broken', typographicFamily: 'Broken Family', weightAxis: { min: 200, def: 400, max: 800 } })
  const goodCollection = ttc([faceTables({ family: 'Broken' }), faceTables({ family: 'Broken', weight: 700 })])

  it('never throws on any truncation of a font or collection', () => {
    for (const buf of [good, goodCollection]) {
      for (let len = 0; len < buf.length; len += 7) {
        const cut = buf.subarray(0, len)
        expect(() => {
          for (const face of readFaces(cut)) {
            readIdentity(face)
            readCoverage(face)
          }
          extractFace(cut, 0)
          extractFace(cut, 1)
        }, `truncated to ${len}`).not.toThrow()
      }
    }
  })

  it('bytes that are not a font read as no face', () => {
    expect(readFaces(Buffer.from('not a font at all'))).toEqual([])
    expect(readFaces(Buffer.alloc(0))).toEqual([])
    expect(extractFace(Buffer.from('ttcf'), 0)).toBeNull()
  })

  it('a collection claiming more faces than it can hold reads as no face', () => {
    const lying = Buffer.from(goodCollection)
    lying.writeUInt32BE(0xffffffff, 8)
    expect(readFaces(lying)).toEqual([])
  })

  it('a table pointing past the end is skipped, the rest still read', () => {
    const buf = Buffer.from(good)
    const face = only(buf)
    const tags = [...face.tables.keys()].sort()
    const cmapRecord = 12 + tags.indexOf('cmap') * 16
    buf.writeUInt32BE(buf.length, cmapRecord + 8)
    const damaged = only(buf)
    expect(damaged.tables.has('cmap')).toBe(false)
    expect(readCoverage(damaged)).toBeNull()
    expect(readIdentity(damaged)?.families).toEqual(['Broken Family', 'Broken'])
  })
})
