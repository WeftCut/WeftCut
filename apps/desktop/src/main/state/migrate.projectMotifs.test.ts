import { describe, expect, it } from 'vitest'
import { projectMotifKey } from '../../shared/motifs/projectMotifs'
import { upgradeWire, type LegacyMotif, type MotifCopy } from './migrate'

const layer = (id: string, motifId: string) => ({ id, params: { kind: 'Motif', motif_id: motifId, motif_version: 1, props: {} } })
const wireAt5 = () => ({
  schema_version: 5,
  compositions: {
    root: { tracks: [{ layers: [layer('a', 'countdown'), layer('b', 'lower'), { id: 'c', params: { kind: 'Text' } }] }] },
    group: { tracks: [{ layers: [layer('d', 'lower'), layer('e', 'sketch-draft'), layer('f', 'gone')] }] },
  },
})

const BUILTIN = { uid: '697b544c-7aa2-460a-87cd-8e646bdaa149', revision: '1'.repeat(64), from: { uid: '697b544c-7aa2-460a-87cd-8e646bdaa149', version: 1, revision: '1'.repeat(64) } }
const LIBRARY = { uid: '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f', revision: '2'.repeat(64), from: { uid: '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f', version: 4, revision: '2'.repeat(64) } }
const DRAFT = { uid: '3d2e1f0a-9b8c-4d7e-8f6a-5b4c3d2e1f0a', revision: '3'.repeat(64), from: null }
const resolved: Record<string, LegacyMotif> = { countdown: BUILTIN, lower: LIBRARY, 'sketch-draft': DRAFT }

describe('v5 → v6 project Motif table', () => {
  it('names every Motif a layer of any composition uses, as v5 resolved it, and plans their copies', () => {
    const original = wireAt5()
    const before = structuredClone(original)
    const copies: MotifCopy[] = []
    const { wire } = upgradeWire(original, 5, 6, undefined, {
      legacyMotif: id => resolved[id] ?? null,
      onMotifCopy: copy => copies.push(copy),
      newUid: () => '4e3f2a1b-0c9d-4e8f-9a7b-6c5d4e3f2a1b',
    })
    expect(wire.schema_version).toBe(6)
    expect(wire.motifs).toEqual({
      countdown: BUILTIN,
      lower: LIBRARY,
      'sketch-draft': DRAFT,
      gone: { uid: '4e3f2a1b-0c9d-4e8f-9a7b-6c5d4e3f2a1b', revision: null, from: null },
    })
    // Planned for what resolved only, once per id.
    expect(copies.sort((a, b) => a.id < b.id ? -1 : 1)).toEqual([
      { id: 'countdown', revision: BUILTIN.revision },
      { id: 'lower', revision: LIBRARY.revision },
      { id: 'sketch-draft', revision: DRAFT.revision },
    ])
    expect(original).toEqual(before)
  })

  it('drops motif_version from every Motif layer: the table says what it renders', () => {
    const { wire } = upgradeWire(wireAt5(), 5, 6, undefined, { legacyMotif: id => resolved[id] ?? null })
    const motifParams = JSON.stringify(wire.compositions)
    expect(motifParams).not.toContain('motif_version')
    expect(motifParams).toContain('"motif_id":"lower"')
  })

  it('keys an id URL parsing would lowercase by its lowercase form, and its layers follow', () => {
    const original = { schema_version: 5, compositions: { root: { tracks: [{ layers: [layer('a', 'Lower'), layer('b', 'lower'), layer('c', 'Lower')] }] } } }
    const copies: MotifCopy[] = []
    const LOWER: LegacyMotif = { ...LIBRARY, uid: '5f4e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c' }
    const { wire } = upgradeWire(original, 5, 6, undefined, {
      legacyMotif: id => id === 'Lower' ? LOWER : resolved[id] ?? null,
      onMotifCopy: copy => copies.push(copy),
    })
    const keys = Object.keys(wire.motifs as object)
    // The id already in key form keeps it; the other takes its lineage prefix.
    expect(keys.sort()).toEqual(['lower', 'lower-5f4e3d2c'])
    const ids = (wire.compositions as { root: { tracks: [{ layers: Array<{ id: string; params: { motif_id: string } }> }] } })
      .root.tracks[0].layers.map(l => [l.id, l.params.motif_id])
    expect(ids).toEqual([['a', 'lower-5f4e3d2c'], ['b', 'lower'], ['c', 'lower-5f4e3d2c']])
    // The copy is read from the id v5 resolved, into the key's folder.
    expect(copies).toContainEqual({ id: 'lower-5f4e3d2c', source: 'Lower', revision: LOWER.revision })
  })

  it('opens without a resolver: every Motif is a missing entry of its own lineage', () => {
    const { wire } = upgradeWire(wireAt5(), 5, 6)
    const motifs = wire.motifs as Record<string, { uid: string; revision: string | null; from: unknown }>
    expect(Object.keys(motifs).sort()).toEqual(['countdown', 'gone', 'lower', 'sketch-draft'])
    for (const entry of Object.values(motifs)) expect(entry).toMatchObject({ revision: null, from: null })
    expect(new Set(Object.values(motifs).map(e => e.uid)).size).toBe(4)
  })
})

describe('v5 → v6 keys', () => {
  // The step keeps a frozen twin of `projectMotifKey`, which placement keys by.
  it('are the ones placement derives', () => {
    for (const id of ['lower', 'MyMotif', 'Lower Third', '__proto__']) {
      const { wire } = upgradeWire({ schema_version: 5, compositions: { root: { tracks: [{ layers: [layer('a', id)] }] } } }, 5, 6)
      expect(Object.keys(wire.motifs as object), id).toEqual([projectMotifKey(id)])
    }
  })
})
