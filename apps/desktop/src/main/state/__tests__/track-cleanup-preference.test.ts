import { describe, expect, it } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

function idOf(result: ReturnType<ActorHandle['dispatch']>): string {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value as string
}

function setup(initialEnabled = true) {
  let enabled = initialEnabled
  const idGen = seededGen()
  const actor = createActor({
    initial: blankProject(idGen, 'Cleanup preference'), idGen,
    autoDeleteEmptyTracks: () => enabled,
  })
  const track = idOf(actor.dispatch('add_track', {}))
  const layer = idOf(actor.dispatch('add_layer', {
    track, kind: 'color', t_start_us: 0, t_end_us: 1_000_000,
  }))
  return { actor, track, layer, setEnabled: (value: boolean) => { enabled = value } }
}

describe('app-level empty-track cleanup', () => {
  it.each(['delete_layers', 'move_layer', 'ripple_delete_layers'])(
    '%s respects the live preference and undo/redo restores the entire edit', (operation) => {
      const { actor, track, layer, setEnabled } = setup(false)
      const args = operation === 'move_layer'
        ? { layer, to_track: root(actor.snapshot()).tracks[0].id, t_start_us: 0 }
        : { layers: [layer] }
      const before = actor.snapshot()
      expect(actor.dispatch(operation, args).ok).toBe(true)
      expect(root(actor.snapshot()).tracks.find((t) => t.id === track)?.layers).toEqual([])
      const retained = actor.snapshot()
      setEnabled(true)
      expect(actor.dispatch('undo', {}).ok).toBe(true)
      expect(actor.snapshot()).toEqual(before)
      expect(actor.dispatch('redo', {}).ok).toBe(true)
      expect(actor.snapshot()).toEqual(retained) // redo restores, not re-executes
      actor.dispatch('undo', {})
      expect(actor.dispatch(operation, args).ok).toBe(true)
      expect(root(actor.snapshot()).tracks.some((t) => t.id === track)).toBe(false)
      actor.dispatch('undo', {})
      expect(actor.snapshot()).toEqual(before)
    },
  )

  it('dry-run predicts retained tracks, and preference changes do not sweep existing empty tracks', () => {
    const { actor, track, layer, setEnabled } = setup(false)
    const before = actor.snapshot()
    const target = root(before).tracks[0].id
    expect(actor.dryRun([
      { kind: 'MoveLayer', id: layer, new_track_id: target, new_t_start_us: 0, escape_link: false },
      { kind: 'AddLayer', track_id: track, params: root(before).tracks.at(-1)!.layers[0].params, t_start_us: 0, t_end_us: 1_000_000 },
    ]).every((r) => r.ok)).toBe(true)
    expect(actor.snapshot()).toBe(before)
    setEnabled(true)
    expect(actor.dryRun([
      { kind: 'DeleteLayers', ids: [layer] },
      { kind: 'AddLayer', track_id: track, params: root(before).tracks.at(-1)!.layers[0].params, t_start_us: 0, t_end_us: 1_000_000 },
    ]).map((r) => r.ok)).toEqual([true, false])
    setEnabled(false)
    actor.dispatch('delete_layers', { layers: [layer] })
    setEnabled(true)
    actor.dispatch('add_track', {})
    expect(root(actor.snapshot()).tracks.some((t) => t.id === track)).toBe(true)
  })

  it('explicit track deletion still works with automatic cleanup off', () => {
    const { actor, track } = setup(false)
    const before = actor.snapshot()
    expect(actor.dispatch('delete_track', { track, force: true }).ok).toBe(true)
    expect(root(actor.snapshot()).tracks.some((t) => t.id === track)).toBe(false)
    actor.dispatch('undo', {})
    expect(actor.snapshot()).toEqual(before)
  })

  it('keeps the default-on behavior isolated between actors', () => {
    const off = setup(false), on = setup()
    off.actor.dispatch('delete_layers', { layers: [off.layer] })
    on.actor.dispatch('delete_layers', { layers: [on.layer] })
    expect(root(off.actor.snapshot()).tracks.some((t) => t.id === off.track)).toBe(true)
    expect(root(on.actor.snapshot()).tracks.some((t) => t.id === on.track)).toBe(false)
  })
})
