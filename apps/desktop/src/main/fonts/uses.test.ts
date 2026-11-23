// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { FaceIndexEntry } from '../../shared/fonts/types'
import type { Manifest } from '../../shared/motifs/catalog'
import type { Layer, LayerParams, Project } from '../state/model'
import type { Coverage } from './sfnt'
import { fontUseKey, fontUses, type FontUsesInput } from './uses'

/** A catalog face drawing the code points of `chars` (inclusive ranges). */
function face(sha: string, family: string, over: Partial<FaceIndexEntry> = {}): FaceIndexEntry {
  return { families: [family], weight: 400, italic: false, source: 'system', sha256: sha, size: 10, ttcIndex: null, ...over }
}

/** Coverage of the characters in `chars`. */
function covering(chars: string): Coverage {
  const cps = [...new Set([...chars].map(c => c.codePointAt(0) as number))].sort((a, b) => a - b)
  return { ranges: Uint32Array.from(cps.flatMap(cp => [cp, cp])) }
}

let layerSeq = 0
function layer(params: Partial<LayerParams> & { kind: LayerParams['kind'] }, id = `layer-${++layerSeq}`): Layer {
  return { id, label: null, t_start_us: 0, t_end_us: 1, enabled: true, locked: false, metadata: {}, params: params as LayerParams, effects: [] }
}

function text(content: string, family: string, font: { weight?: number; italic?: boolean } = {}, id?: string): Layer {
  return layer({ kind: 'Text', content, font: { family, size_px: 40, weight: font.weight ?? 400, italic: font.italic ?? false } }, id)
}

function motif(motifId: string, props: Record<string, unknown>, id?: string): Layer {
  return layer({ kind: 'Motif', motif_id: motifId, props }, id)
}

/** A project of one composition per layer list (a Group's layers sit in a
 *  composition of their own), every track disabled-agnostic. */
function project(compositions: Layer[][], excluded: string[] = []): FontUsesInput['project'] {
  const comps: Record<string, unknown> = {}
  compositions.forEach((layers, i) => {
    comps[`comp-${i}`] = { id: `comp-${i}`, tracks: [{ id: `track-${i}`, enabled: false, layers }] }
  })
  return { compositions: comps as Project['compositions'], settings: { excluded_fonts: excluded } as Project['settings'] }
}

async function uses(p: FontUsesInput['project'], faces: FaceIndexEntry[], coverage: Record<string, string>, more: Partial<FontUsesInput> = {}) {
  return fontUses({
    project: p, faces,
    coverage: async (sha) => (sha in coverage ? covering(coverage[sha] as string) : null),
    motifManifest: () => null, ...more,
  })
}

describe('text uses: only families that draw, each whole', () => {
  it('collects the second leaf\'s face for a character the first leaf cannot draw, and not the first\'s for it', async () => {
    const faces = [face('latin', 'Latin Sans'), face('cjk', 'CJK Sans')]
    const result = await uses(project([[text('字', 'Latin Sans, CJK Sans')]]), faces, { latin: 'abc', cjk: '字' })
    expect(result.collect).toEqual(['cjk'])
  })

  it('collects nothing from later leaves when the first draws every character', async () => {
    const faces = [face('latin', 'Latin Sans'), face('cjk', 'CJK Sans')]
    const result = await uses(project([[text('abc', 'Latin Sans, CJK Sans')]]), faces, { latin: 'abc', cjk: 'abc字' })
    expect(result.collect).toEqual(['latin'])
  })

  it('collects every face of the family a layer draws with, whatever weight and style it asks for', async () => {
    const faces = [face('regular', 'Example'), face('bold', 'Example', { weight: 700 }), face('italic', 'Example', { italic: true }), face('other', 'Other')]
    const result = await uses(project([[text('a', 'Example', { weight: 700 })]]), faces, { regular: 'a', bold: 'a', italic: 'a', other: 'a' })
    expect(result.collect).toEqual(['bold', 'italic', 'regular'])
  })

  it('collects the whole family a legacy family name resolves to', async () => {
    const legacy = { families: ['Example', 'Example Semibold'], weight: 600 }
    const faces = [face('regular', 'Example'), face('semibold', 'Example', legacy), face('bold', 'Example', { weight: 700 })]
    const result = await uses(project([[text('a', 'Example Semibold')]]), faces, { regular: 'a', semibold: 'a', bold: 'a' })
    expect(result.collect).toEqual(['bold', 'regular', 'semibold'])
  })

  it('collects the faces of a family Fonts/ holds only some of', async () => {
    const faces = [face('project', 'Example', { source: 'project' }), face('system-regular', 'Example'), face('system-bold', 'Example', { weight: 700 })]
    const result = await uses(project([[text('x', 'Example')]]), faces, { project: 'x', 'system-regular': 'x', 'system-bold': 'x' })
    expect(result.collect).toEqual(['system-bold'])
  })

  it('passes over a bundled leaf: a later leaf that draws the character is a use', async () => {
    const faces = [face('later', 'Later CJK')]
    const result = await uses(project([[text('字', 'Liberation Sans, Later CJK')]]), faces, { later: '字' })
    expect(result.collect).toEqual(['later'])
    expect(result.missing).toEqual([])
  })

  it('creates no use for whitespace', async () => {
    const faces = [face('a', 'Example')]
    expect((await uses(project([[text(' \n\t', 'Example')]]), faces, { a: 'x' })).collect).toEqual([])
  })

  it('walks Text in every composition, a Group\'s included', async () => {
    const faces = [face('a', 'Example')]
    expect((await uses(project([[], [text('x', 'Example')]]), faces, { a: 'x' })).collect).toEqual(['a'])
  })

  it('skips an excluded family, compared without case', async () => {
    const faces = [face('a', 'Example')]
    expect((await uses(project([[text('x', 'Example')]], ['EXAMPLE']), faces, { a: 'x' })).collect).toEqual([])
  })

  it('skips a face Fonts/ already holds in another version', async () => {
    const faces = [face('project', 'Example', { source: 'project' }), face('system', 'Example')]
    const result = await uses(project([[text('x', 'Example')]]), faces, { project: 'x', system: 'x' })
    expect(result.collect).toEqual([])
  })
})

describe('missing uses', () => {
  it('names a leaf that resolves nowhere with the layer\'s weight, italic and id, even when a later leaf draws', async () => {
    const faces = [face('b', 'Present')]
    const result = await uses(project([[text('x', 'Gone, Present', { weight: 700, italic: true }, 'L1')]]), faces, { b: 'x' })
    expect(result.missing).toEqual([{ family: 'Gone', weight: 700, italic: true, layer_ids: ['L1'] }])
    expect(result.collect).toEqual(['b'])
  })

  it('never names a leaf after the first that resolves, even one a character reaches', async () => {
    // The shared rule (shared/fonts/missing.ts): later leaves are fallbacks.
    const faces = [face('a', 'Present')]
    const result = await uses(project([[text('x字', 'Present, Gone')]]), faces, { a: 'x' })
    expect(result.missing).toEqual([])
  })

  it('never names a generic family, and stops the walk at one', async () => {
    const faces = [face('later', 'Later Sans')]
    const result = await uses(project([[text('a', 'sans-serif, Later Sans')]]), faces, { later: 'a' })
    expect(result).toEqual({ collect: [], missing: [] })
  })

  it('walks a layer stored with weight 0 as Regular', async () => {
    const result = await uses(project([[text('a', 'Gone', { weight: 0 }, 'L1')]]), [], {})
    expect(result.missing).toEqual([{ family: 'Gone', weight: 400, italic: false, layer_ids: ['L1'] }])
  })

  it('names every layer asking for the missing family', async () => {
    const result = await uses(project([[text('x', 'Gone', {}, 'L1')], [text('y', 'Gone', {}, 'L2')]]), [], {})
    expect(result.missing).toEqual([{ family: 'Gone', weight: 400, italic: false, layer_ids: ['L1', 'L2'] }])
  })
})

describe('Motif uses: the characters of its string props through each font slot', () => {
  const STACK = "'Display', 'Impact', 'Microsoft YaHei', sans-serif"
  const manifest: Pick<Manifest, 'props_schema' | 'fonts'> = {
    props_schema: {
      font_headline: { type: 'string', default: STACK },
      headline: { type: 'string', default: 'Default' },
      ink: { type: 'color', default: '#000000' },
    },
    fonts: [{ family: 'Shipped Sans', file: 'assets/x.woff2' }],
  }
  const faces = [face('display', 'Display'), face('impact', 'Impact'), face('yahei', 'Microsoft YaHei')]
  const coverage = { display: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', impact: 'ABCabc', yahei: 'ABCabc字' }

  it('collects only the first leaf that covers a Latin headline, not the later ones', async () => {
    const result = await uses(project([[motif('card', { headline: 'Breaking' })]]), faces, coverage, { motifManifest: () => manifest })
    expect(result.collect).toEqual(['display'])
  })

  it('collects the CJK leaf for a CJK character in a prop', async () => {
    const result = await uses(project([[motif('card', { headline: 'Big 字' })]]), faces, coverage, { motifManifest: () => manifest })
    expect(result.collect).toEqual(['display', 'yahei'])
  })

  it('reads the manifest\'s defaults for the slot and the text the layer leaves unset', async () => {
    const result = await uses(project([[motif('card', {})]]), faces, coverage, { motifManifest: () => manifest })
    expect(result.collect).toEqual(['display'])
  })

  it('collects every face of a slot family, the weights its CSS asks for among them', async () => {
    const black = face('display-black', 'Display', { weight: 900 })
    const result = await uses(project([[motif('card', { headline: 'Breaking' })]]), [...faces, black], { ...coverage, 'display-black': coverage.display }, {
      motifManifest: () => manifest,
    })
    expect(result.collect).toEqual(['display', 'display-black'])
  })

  it('passes over a family the package ships and never collects it, even where it is installed', async () => {
    const installed = face('shipped', 'Shipped Sans')
    const result = await uses(project([[motif('card', { font_headline: "'Shipped Sans', Display", headline: 'abc' })]]), [...faces, installed], { ...coverage, shipped: 'abc' }, {
      motifManifest: () => manifest,
    })
    expect(result).toEqual({ collect: ['display'], missing: [] })
  })

  it('names a slot family before the first that draws, but not the package\'s own, a bundled one or a later one', async () => {
    const result = await uses(project([[
      motif('card', { font_headline: "'Shipped Sans', Gone" }, 'M1'),
      motif('card', { font_headline: 'Gone2, Liberation Sans, Gone3' }, 'M2'),
    ]]), [], {}, { motifManifest: () => manifest })
    expect(result.missing).toEqual([{ family: 'Gone2', weight: null, italic: null, layer_ids: ['M2'] }])
  })
})

describe('fontUseKey', () => {
  it('moves when a layer draws a new character, not when it repeats one', () => {
    const before = fontUseKey(project([[text('ab', 'Example', {}, 'L')]]))
    expect(fontUseKey(project([[text('abba', 'Example', {}, 'L')]]))).toBe(before)
    expect(fontUseKey(project([[text('abc', 'Example', {}, 'L')]]))).not.toBe(before)
  })

  it('moves when a Motif\'s text prop draws a new character, not when it repeats one', () => {
    const before = fontUseKey(project([[motif('card', { headline: 'ab' }, 'M')]]))
    expect(fontUseKey(project([[motif('card', { headline: 'ba' }, 'M')]]))).toBe(before)
    expect(fontUseKey(project([[motif('card', { headline: 'ab字' }, 'M')]]))).not.toBe(before)
  })

  it('moves with the exclusion list', () => {
    expect(fontUseKey(project([[]], ['A']))).not.toBe(fontUseKey(project([[]])))
  })
})
