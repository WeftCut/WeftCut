import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { upgradeWire } from './migrate'
import { parseProjectJson, serializeProjectToJson } from './persistence'
import { validate } from './validate'

describe('v4 → v5 graphic role migration', () => {
  it('sets graphic_role null on every Text, Motif and ImageOverlay layer in every composition', () => {
    const composition = () => ({
      tracks: [{ layers: [
        { id: 'text', params: { kind: 'Text', content: 'Title' } },
        { id: 'motif', params: { kind: 'Motif', motif_id: 'lower-third', props: { graphic_role: 'kept' } } },
        { id: 'image', params: { kind: 'ImageOverlay', media: 'm' } },
        { id: 'video', params: { kind: 'VideoClip', media: 'm' } },
        { id: 'color', params: { kind: 'Color' } },
        { id: 'audio', params: { kind: 'Audio', media: 'm' } },
        { id: 'group', params: { kind: 'CompositionRef', composition: 'nested' } },
      ] }],
    })
    const original = { schema_version: 4, compositions: { root: composition(), nested: composition() } }
    const before = structuredClone(original)
    const upgraded = upgradeWire(original, 4, 5).wire as typeof original
    expect(upgraded.schema_version).toBe(5)
    for (const c of Object.values(upgraded.compositions)) {
      const params = Object.fromEntries(c.tracks[0].layers.map((l) => [l.id, l.params as Record<string, unknown>]))
      for (const id of ['text', 'motif', 'image']) expect(params[id]).toHaveProperty('graphic_role', null)
      for (const id of ['video', 'color', 'audio', 'group']) expect(params[id]).not.toHaveProperty('graphic_role')
      // Motif props are the Motif's own data — never touched.
      expect(params.motif.props).toEqual({ graphic_role: 'kept' })
    }
    expect(original).toEqual(before)
  })

  it('loads the v4 fixture, saves v5 and reopens without a second migration', () => {
    const { project, upgradedFrom } = parseProjectJson(readFileSync('fixtures/projects/v4.json', 'utf8'), { migration: { mediaSize: () => [640, 360] } })
    expect(upgradedFrom).toBe(4)
    expect(() => validate(project)).not.toThrow()
    const text = Object.values(project.compositions).flatMap((c) => c.tracks.flatMap((t) => t.layers)).filter((l) => l.params.kind === 'Text')
    expect(text.length).toBeGreaterThan(0)
    for (const l of text) expect(l.params).toMatchObject({ kind: 'Text', graphic_role: null })
    const saved = serializeProjectToJson(project)
    expect(JSON.parse(saved).schema_version).toBe(5)
    const reopened = parseProjectJson(saved)
    expect(reopened.upgradedFrom).toBeNull()
    expect(serializeProjectToJson(reopened.project)).toBe(saved)
  })
})
