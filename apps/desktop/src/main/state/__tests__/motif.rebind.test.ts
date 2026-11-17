// A project copy updated from the library rebinds the layers on it to the new
// props schema in the same commit (`update_project_motif`).
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'
import type { MotifParams } from '../model'
import { root } from './fixtures/project'
import { fakeRevision, libraryMotifs } from './fixtures/motifs'

const UID = '10000000-0000-4000-8000-000000000000'
const NEXT = { uid: UID, version: 2, revision: fakeRevision('mx@2') }

function setup() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't') // mints A#1, B#2, project#3
  const motifs = libraryMotifs()
  initial.motifs.mx = { uid: UID, revision: fakeRevision('mx'), from: { uid: UID, version: 1, revision: fakeRevision('mx') } }
  motifs.folders.set('mx', { id: 'mx', name: 'mx', version: 1, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} })
  const actor = createActor({ initial, idGen, clock: () => '<TS>', motifs })
  const aRoll = root(initial).tracks[0].id
  const add = (kind: 'Motif' | 'color', t: number): string => {
    const r = actor.dispatch('add_layer', kind === 'Motif'
      ? { track: aRoll, kind, motif_id: 'mx', props: {}, t_start_us: t, t_end_us: t + 1_000_000 }
      : { track: aRoll, kind, t_start_us: t, t_end_us: t + 1_000_000 })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value as string
  }
  return { actor, add }
}

describe('update_project_motif rebinds the layers on the Motif', () => {
  it('sets each layer\'s props and records the entry, in one commit', () => {
    const { actor, add } = setup()
    const id1 = add('Motif', 0), id2 = add('Motif', 2_000_000)
    const before = actor.historyStatus().len
    const r = actor.dispatch('update_project_motif', {
      motif_id: 'mx', revision: NEXT.revision, from: NEXT,
      updates: [{ layer_id: id1, motif_id: 'mx', props: { x: 1 } }, { layer_id: id2, motif_id: 'mx', props: { x: 2 } }],
    })
    expect(r.ok).toBe(true)
    expect(actor.historyStatus().len).toBe(before + 1)
    const layers = root(actor.snapshot()).tracks.flatMap((t) => t.layers)
    expect((layers.find((l) => l.id === id1)!.params as MotifParams).props).toEqual({ x: 1 })
    expect((layers.find((l) => l.id === id2)!.params as MotifParams).props).toEqual({ x: 2 })
    expect(actor.snapshot().motifs.mx).toEqual({ uid: UID, revision: NEXT.revision, from: NEXT })
  })

  it('skips a non-Motif layer named in the updates', () => {
    const { actor, add } = setup()
    const colorId = add('color', 0)
    const r = actor.dispatch('update_project_motif', {
      motif_id: 'mx', revision: NEXT.revision, from: NEXT, updates: [{ layer_id: colorId, motif_id: 'mx', props: {} }],
    })
    expect(r.ok).toBe(true)
    expect(root(actor.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === colorId)!.params.kind).toBe('Color')
  })

  it('never moves a layer to another Motif', () => {
    const { actor, add } = setup()
    const id = add('Motif', 0)
    const before = actor.snapshot()
    const r = actor.dispatch('update_project_motif', {
      motif_id: 'mx', revision: NEXT.revision, from: NEXT, updates: [{ layer_id: id, motif_id: 'other', props: {} }],
    })
    expect(r.ok).toBe(false)
    expect(actor.snapshot()).toBe(before)
  })
})
