import { describe, expect, it } from 'vitest'
import { BUNDLED_FONT_FAMILIES } from '../fonts'
import { faceAlias, familyFaces, parseFamilyList, resolveFace, styleName } from './resolve'
import type { FaceIndexEntry, FaceSource, FaceWeight } from './types'

let next = 0
function face(weight: FaceWeight, opts: { italic?: boolean; source?: FaceSource; families?: string[] } = {}): FaceIndexEntry {
  return {
    families: opts.families ?? ['Example Sans'],
    weight,
    italic: opts.italic ?? false,
    source: opts.source ?? 'system',
    sha256: (next++).toString(16).padStart(16, '0').padEnd(64, '0'),
    size: 1,
    ttcIndex: null,
  }
}

const weightOf = (faces: FaceIndexEntry[], desired: number) => resolveFace(faces, 'Example Sans', desired, false)?.weight

describe('parseFamilyList', () => {
  it('splits on commas outside quotes, in order, without quotes or padding', () => {
    expect(parseFamilyList(` "Example, Sans" ,  Second   Face,'Third',, sans-serif `))
      .toEqual(['Example, Sans', 'Second Face', 'Third', 'sans-serif'])
  })

  it('an empty list has no leaves', () => {
    expect(parseFamilyList('  ,  ')).toEqual([])
  })

  it('reads CSS escapes: a quote or backslash escaped in a string, a code point in hex', () => {
    expect(parseFamilyList(String.raw`'O\'Brien Sans', 'Back\\slash', "Say \"Hi\"", \41 nton`))
      .toEqual(["O'Brien Sans", 'Back\\slash', 'Say "Hi"', 'Anton'])
  })

  it('keeps an apostrophe inside a bare name, as a Text layer stores one', () => {
    expect(parseFamilyList("O'Brien Sans, Impact")).toEqual(["O'Brien Sans", 'Impact'])
  })
})

describe('resolveFace weight (CSS Fonts 4 §5.2)', () => {
  it('above 500: the nearest heavier weight before any lighter one', () => {
    expect(weightOf([face(500), face(800), face(700)], 600)).toBe(700)
  })

  it('above 500 with nothing heavier: lighter weights in descending order', () => {
    expect(weightOf([face(300), face(500)], 600)).toBe(500)
  })

  it('below 400: the nearest lighter weight before any heavier one', () => {
    expect(weightOf([face(100), face(200), face(400)], 300)).toBe(200)
  })

  it('below 400 with nothing lighter: heavier weights in ascending order', () => {
    expect(weightOf([face(700), face(400), face(500)], 300)).toBe(400)
  })

  it('between 400 and 500: heavier weights up to 500 first', () => {
    expect(weightOf([face(400), face(500), face(600)], 450)).toBe(500)
  })

  it('between 400 and 500 with none up to 500: lighter weights descending before weights above 500', () => {
    expect(weightOf([face(300), face(400), face(600)], 450)).toBe(400)
  })

  it('between 400 and 500 with nothing up to 500 or lighter: weights above 500 ascending', () => {
    expect(weightOf([face(800), face(600)], 450)).toBe(600)
  })

  it('a variable range that contains the desired weight matches it exactly', () => {
    const variable = face([100, 900])
    expect(resolveFace([face(600), variable], 'Example Sans', 650, false)).toBe(variable)
  })

  it('a variable range outside the desired weight competes at its nearest end', () => {
    const light = face([100, 300])
    const heavy = face([700, 900])
    expect(resolveFace([light, heavy], 'Example Sans', 600, false)).toBe(heavy)
    expect(resolveFace([light, heavy], 'Example Sans', 350, false)).toBe(light)
  })
})

describe('resolveFace style', () => {
  it('italic wants an italic face before a nearer-weight upright one', () => {
    const italic = face(300, { italic: true })
    expect(resolveFace([face(700), italic], 'Example Sans', 700, true)).toBe(italic)
  })

  it('italic falls back to upright when the family has no italic', () => {
    expect(resolveFace([face(400)], 'Example Sans', 400, true)?.italic).toBe(false)
  })

  it('upright wants an upright face, then falls back to italic', () => {
    const upright = face(900)
    expect(resolveFace([face(400, { italic: true }), upright], 'Example Sans', 400, false)).toBe(upright)
    expect(resolveFace([face(400, { italic: true })], 'Example Sans', 400, false)?.italic).toBe(true)
  })
})

describe('sources and families', () => {
  it('a project face wins over a system face of the same identity, whatever the order', () => {
    const system = face(400)
    const project = face(400, { source: 'project' })
    expect(resolveFace([system, project], 'Example Sans', 400, false)).toBe(project)
  })

  it('a project face wins a tie with a system face of another shape that matches as well', () => {
    const system = face(700)
    const project = face([100, 900], { source: 'project' })
    expect(resolveFace([system, project], 'Example Sans', 700, false)).toBe(project)
  })

  it('a project holding some faces of a family still reaches the system faces it lacks', () => {
    const projectRegular = face(400, { source: 'project' })
    const systemRegular = face(400)
    const systemBold = face(700)
    const faces = [systemRegular, systemBold, projectRegular]
    expect(resolveFace(faces, 'Example Sans', 700, false)).toBe(systemBold)
    expect(familyFaces(faces, 'Example Sans')).toEqual([projectRegular, systemBold])
  })

  it('matches any family name of a face, case-insensitively', () => {
    const semibold = face(600, { families: ['Example Sans', 'Example Sans SemiBold'] })
    expect(resolveFace([semibold], 'example sans semibold', 400, false)).toBe(semibold)
    expect(resolveFace([semibold], 'EXAMPLE SANS', 600, false)).toBe(semibold)
    expect(resolveFace([semibold], 'Other', 400, false)).toBeNull()
  })

  it('bundled families never resolve to a catalog face', () => {
    for (const bundled of BUNDLED_FONT_FAMILIES) {
      const installed = face(400, { families: [bundled] })
      expect(resolveFace([installed], bundled, 400, false)).toBeNull()
      expect(familyFaces([installed], bundled.toUpperCase())).toEqual([])
    }
  })

  it('each face has its own alias family', () => {
    const [a, b] = [face(400), face(700)]
    expect(faceAlias(a.sha256)).not.toBe(faceAlias(b.sha256))
  })
})

describe('styleName', () => {
  it('names a request as a font menu does', () => {
    expect(styleName(400, false)).toBe('Regular')
    expect(styleName(700, false)).toBe('Bold')
    expect(styleName(700, true)).toBe('Bold Italic')
    expect(styleName(400, true)).toBe('Italic')
    expect(styleName(650, false)).toBe('650')
    // An unset request is the 400 upright a renderer draws.
    expect(styleName(null, null)).toBe('Regular')
  })
})
