import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { upgradeWire } from './migrate'
import { parseProjectJson, serializeProjectToJson } from './persistence'
import { validate } from './validate'

describe('v1 → v2 clip mute migration', () => {
  it.each([
    { enabled: true, mute: true, result: false },
    { enabled: false, mute: true, result: false },
    { enabled: true, mute: false, result: true },
    { enabled: false, mute: false, result: false },
  ])('preserves audibility for enabled=$enabled, mute=$mute in every composition', ({ enabled, mute, result }) => {
    const composition = () => ({
      tracks: [{ enabled: false, muted: true, layers: [
        { id: 'audio', enabled, params: { kind: 'Audio', mute, gain_db: { mode: 'Static', value: -6 } } },
        { id: 'video', enabled: true, params: { kind: 'VideoClip' } },
      ] }],
      links: [{ id: 'link', members: ['audio', 'video'] }],
    })
    const original = {
      schema_version: 1,
      compositions: { root: composition(), group: composition() },
      audio_roles: { dialogue: { muted: true, solo: false, gain_db: -3 } },
    }
    const before = structuredClone(original)
    const upgraded = upgradeWire(original, 1, 2).wire as typeof original
    for (const c of Object.values(upgraded.compositions)) {
      expect(c.tracks[0].layers[0]).toEqual({
        id: 'audio', enabled: result,
        params: { kind: 'Audio', mute: false, gain_db: { mode: 'Static', value: -6 } },
      })
      expect(c.tracks[0].layers[1]).toEqual(before.compositions.root.tracks[0].layers[1])
      expect(c.tracks[0].enabled).toBe(false)
      expect(c.tracks[0].muted).toBe(true)
      expect(c.links).toEqual(before.compositions.root.links)
    }
    expect(upgraded.audio_roles).toEqual(before.audio_roles)
    expect(original).toEqual(before)
    expect(upgradeWire(upgraded, 2, 2).wire).toBe(upgraded)
  })

  it('loads old JSON, saves the converted state and reopens without a second migration', () => {
    const wire = JSON.parse(readFileSync('fixtures/projects/v1.json', 'utf8'))
    for (const c of Object.values(wire.compositions) as Array<{ tracks: Array<{ layers: Array<{ params: { kind: string; mute?: boolean } }> }> }>) {
      for (const t of c.tracks) for (const l of t.layers) if (l.params.kind === 'Audio') l.params.mute = true
    }
    const { project, upgradedFrom } = parseProjectJson(JSON.stringify(wire))
    expect(upgradedFrom).toBe(1)
    expect(() => validate(project)).not.toThrow()
    const audio = Object.values(project.compositions).flatMap((c) => c.tracks.flatMap((t) => t.layers))
      .filter((l) => l.params.kind === 'Audio')
    expect(audio.length).toBeGreaterThan(0)
    for (const l of audio) {
      expect(l.enabled).toBe(false)
      expect(l.params).toMatchObject({ kind: 'Audio', mute: false })
    }
    const saved = serializeProjectToJson(project)
    const reopened = parseProjectJson(saved)
    expect(reopened.upgradedFrom).toBeNull()
    expect(serializeProjectToJson(reopened.project)).toBe(saved)
  })
})
