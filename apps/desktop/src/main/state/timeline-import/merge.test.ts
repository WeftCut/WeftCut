import { describe, expect, it } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, rootComposition } from '../model'
import { applyAddLayer, colorParams } from '../mutations/add'
import { validate } from '../validate'

describe('importing into a current project', () => {
  function projects() {
    const idGen = seededGen()
    const existing = blankProject(idGen, 'Existing')
    const r = rootComposition(existing)
    applyAddLayer(existing, idGen, r.tracks[0]!.id,
      colorParams({ r: 4, g: 5, b: 6, a: 255 }, r.width, r.height), 0, 1_000_000)
    const imported = blankProject(idGen, 'Imported sequence')
    const source = rootComposition(imported)
    source.width = 1080
    source.height = 1920
    applyAddLayer(imported, idGen, source.tracks[0]!.id,
      colorParams({ r: 80, g: 3, b: 2, a: 255 }, 1080, 1920), 0, 1_000_000)
    validate(existing)
    validate(imported)
    return { idGen, existing, imported }
  }

  it('adds a valid editable Group after existing content with one undo entry', () => {
    const { idGen, existing, imported } = projects()
    const actor = createActor({ initial: existing, idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const before = actor.snapshot()
    const originalClip = rootComposition(before).tracks[0]!.layers[0]
    const result = actor.dispatch('import_timeline_group', {
      imported, expectedProjectId: before.project_id, canvas: 'fit',
    })
    expect(result.ok).toBe(true)
    const after = actor.snapshot()
    expect(after.project_id).toBe(before.project_id)
    expect(rootComposition(after).tracks[0]!.layers[0]).toEqual(originalClip)
    const group = after.compositions[imported.root_id]!
    expect(group.label).toBe('Imported sequence')
    expect(group.width).toBe(1080)
    expect(group.height).toBe(1920)
    expect(group.tracks[0]!.layers).toHaveLength(1)
    const added = rootComposition(after).tracks.flatMap(track => track.layers)
      .find(layer => layer.params.kind === 'CompositionRef')!
    expect(added.t_start_us).toBeGreaterThanOrEqual(originalClip!.t_end_us)
    if (added.params.kind !== 'CompositionRef') throw new Error('Expected Group')
    expect(added.params.composition).toBe(imported.root_id)
    expect(added.params.transform.scale_x).toMatchObject({ mode: 'Static', value: 1080 / 1920 })
    expect(added.params.transform.position.x).toMatchObject({ mode: 'Static', value: 960 })
    validate(after)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(rootComposition(actor.snapshot()).tracks[0]!.layers[0]).toEqual(originalClip)
    expect(Object.keys(actor.snapshot().compositions)).toEqual(Object.keys(before.compositions))
    expect(actor.snapshot().project_id).toBe(before.project_id)
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(actor.snapshot().compositions[imported.root_id]).toBeDefined()
  })

  it.each([
    ['fit', 1080 / 1920],
    ['fill', 1920 / 1080],
    ['original', 1],
  ] as const)('uses the reviewed %s canvas option without changing source clip placement', (canvas, expectedScale) => {
    const { idGen, existing, imported } = projects()
    const actor = createActor({ initial: existing, idGen })
    const input = rootComposition(imported).tracks[0]!.layers[0]!
    const result = actor.dispatch('import_timeline_group', {
      imported, expectedProjectId: existing.project_id, canvas,
    })
    expect(result.ok).toBe(true)
    const output = actor.snapshot()
    const group = rootComposition(output).tracks.flatMap(t => t.layers)
      .find(l => l.params.kind === 'CompositionRef')!
    if (group.params.kind !== 'CompositionRef') throw new Error('expected Group')
    expect(group.params.transform.scale_x).toEqual({ mode: 'Static', value: expectedScale })
    expect(group.params.transform.scale_y).toEqual({ mode: 'Static', value: expectedScale })
    expect(output.compositions[imported.root_id]!.tracks[0]!.layers[0]).toEqual(input)
  })

  it('refuses differing frame rates without touching the current project', () => {
    const { idGen, existing, imported } = projects()
    rootComposition(imported).fps = { num: 25, den: 1 }
    const actor = createActor({ initial: existing, idGen })
    const before = actor.snapshot()
    expect(() => actor.dispatch('import_timeline_group', {
      imported, expectedProjectId: before.project_id, canvas: 'fill',
    })).toThrow(/Frame rates differ/)
    expect(actor.snapshot()).toBe(before)
    expect(actor.dispatch('undo', {}).ok).toBe(false)
  })

  it('refuses a stale project identity and an invalid canvas choice atomically', () => {
    const { idGen, existing, imported } = projects()
    const actor = createActor({ initial: existing, idGen })
    const before = actor.snapshot()
    expect(actor.dispatch('import_timeline_group', {
      imported, expectedProjectId: 'outdated', canvas: 'fit',
    }).ok).toBe(false)
    expect(() => actor.dispatch('import_timeline_group', {
      imported, expectedProjectId: before.project_id, canvas: 'invalid',
    })).toThrow(/Choose how/)
    expect(actor.snapshot()).toBe(before)
  })
})
