// The `clipping` style's example Motifs (spec H2-D4, revised). Each package
// must stand alone (a Motif cannot load another's files), so they carry one
// shared helper block; the copies must not drift apart. Each plays its exit
// against `duration_s`, its layer's length, so it declares that prop as its
// content duration.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN_MANIFESTS, validateManifest } from '../../shared/motifs/catalog'

const DIR = path.join(import.meta.dirname, '../../shared/motifs/builtin')
const IDS = [...BUILTIN_MANIFESTS.keys()].filter((id) => id.startsWith('clipping-'))
const common = (id: string) => {
  const html = readFileSync(path.join(DIR, id, 'index.html'), 'utf8')
  const start = html.indexOf('// clipping-common v1'), end = html.indexOf('// end clipping-common')
  return start >= 0 && end > start ? html.slice(start, end) : null
}

describe('clipping Motifs', () => {
  it('are eight, each valid, with token-backed props of the shared keys and types', () => {
    expect(IDS.sort()).toEqual(['clipping-headline', 'clipping-paper', 'clipping-pointer', 'clipping-quote', 'clipping-reveal', 'clipping-scrap', 'clipping-stamp', 'clipping-sticker'])
    const TYPES: Record<string, string> = { ink: 'color', paper: 'color', accent: 'color', highlight: 'color', tilt_deg: 'number', step_fps: 'number' }
    for (const id of IDS) {
      const m = BUILTIN_MANIFESTS.get(id)!
      expect(() => validateManifest(m), id).not.toThrow()
      expect(m.max_duration_prop, id).toBe('duration_s')
      expect(m.props_schema.duration_s, id).toMatchObject({ type: 'number', default: m.default_duration_s })
      expect(m.props_schema.exit, id).toMatchObject({ type: 'enum' })
      for (const [key, spec] of Object.entries(m.props_schema)) {
        if (key in TYPES) expect(spec.type, `${id}.${key}`).toBe(TYPES[key])
        if (key.startsWith('font_')) expect(spec, `${id}.${key}`).toMatchObject({ type: 'string', max_length: 200 })
      }
    }
  })

  it('carry one identical copy of the shared helpers', () => {
    const blocks = IDS.map(common)
    expect(blocks.every((b) => b !== null)).toBe(true)
    expect(new Set(blocks).size).toBe(1)
  })
})
