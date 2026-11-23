import { describe, expect, it } from 'vitest'
import type { FaceIndexEntry } from '../fonts/types'
import { motifFonts } from './fontProps'
import type { Manifest } from './catalog'

const face = (family: string, sha: string, over: Partial<FaceIndexEntry> = {}): FaceIndexEntry =>
  ({ families: [family], weight: 400, italic: false, source: 'system', sha256: sha.repeat(64), size: 1, ttcIndex: null, ...over })
const manifest = (over: Partial<Manifest> = {}): Pick<Manifest, 'props_schema' | 'fonts'> => ({
  props_schema: {
    font_headline: { type: 'string', default: 'serif', max_length: 200 },
    font_size: { type: 'number', default: 12 },
    title: { type: 'string', default: '' },
  },
  ...over,
})

describe('motifFonts', () => {
  it('is null for a Motif without font props', () => {
    expect(motifFonts({ props_schema: { title: { type: 'string', default: '' } } }, { title: 'Anton' }, [face('Anton', 'a')])).toBeNull()
  })

  it('keys each font prop by every face of every leaf, in list order, a project face before the system face it replaces', () => {
    const faces = [face('Impact', 'i'), face('Anton', 'a'), face('Anton', 'b', { weight: 700 }), face('Anton', 'p', { source: 'project' })]
    const fonts = motifFonts(manifest(), { font_headline: "'Anton', Impact, sans-serif" }, faces)!
    expect(fonts.keys).toEqual({ font_headline: ['p', 'b', 'i'].map(c => c.repeat(64)) })
    expect(fonts.faces.map(f => [f.family, f.sha256[0], f.weight])).toEqual([['Anton', 'p', 400], ['Anton', 'b', 700], ['Impact', 'i', 400]])
  })

  it('leaves out the families the package ships and the bundled ones', () => {
    const faces = [face('Inter', 'n'), face('Liberation Sans', 'l'), face('Anton', 'a')]
    const fonts = motifFonts(manifest({ fonts: [{ family: 'inter', file: 'Inter.woff2' }] }), { font_headline: 'Inter, Liberation Sans, Anton' }, faces)!
    expect(fonts.keys).toEqual({ font_headline: ['a'.repeat(64)] })
    expect(fonts.faces.map(f => f.family)).toEqual(['Anton'])
  })

  it('keys a font prop that resolves nowhere with an empty list, so the key is still the font-aware one', () => {
    expect(motifFonts(manifest(), { font_headline: 'Nowhere Sans' }, [])!.keys).toEqual({ font_headline: [] })
  })
})
