import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

const S = 1_000_000
const idOf = (r: ReturnType<ActorHandle['dispatch']>): string => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string
}
function setup() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'selection move'), idGen: gen, clock: () => '<TS>' })
  const [tA, tB] = root(a.snapshot()).tracks.map((t) => t.id) as [string, string]
  const first = idOf(a.dispatch('add_layer', { track: tA, kind: 'color', t_start_us: S, t_end_us: 2 * S }))
  const second = idOf(a.dispatch('add_layer', { track: tA, kind: 'color', t_start_us: 2 * S, t_end_us: 3 * S }))
  const move = (time: number, track = tA) => {
    return a.command('move_layers', { placements: [first, second].map((layerId) => ({ layerId, trackId: track })), anchorLayerId: second, anchorTStartUs: time })
  }
  const positions = () => root(a.snapshot()).tracks.flatMap((t) => t.layers.map((l) => [l.id, t.id, l.t_start_us, l.t_end_us]))
  return { a, tA, tB, first, second, move, positions }
}

describe('selection move', () => {
  it('preserves a chain of transitions and a linked partner through move and undo', () => {
    const { a, tA, tB, first, second } = setup()
    const firstTransition = idOf(a.dispatch('add_transition', { from: first, to: second, duration_us: 400_000 }))
    const third = idOf(a.dispatch('add_layer', { track: tA, kind: 'color', t_start_us: 2_600_000, t_end_us: 4_600_000 }))
    const secondTransition = idOf(a.dispatch('add_transition', { from: second, to: third, duration_us: 400_000 }))
    const partner = idOf(a.dispatch('add_layer', { track: tB, kind: 'color', t_start_us: 1_600_000, t_end_us: 2_600_000 }))
    idOf(a.dispatch('links_create', { layers: [second, partner] }))
    const before = root(a.snapshot())
    expect(a.command('move_layers', {
      placements: [first, second, third, partner].map((layerId) => ({ layerId, trackId: layerId === partner ? tB : tA })),
      anchorLayerId: first, anchorTStartUs: 2_000_000,
    }).ok).toBe(true)
    const after = root(a.snapshot())
    expect(after.transitions.map((t) => t.id)).toEqual([firstTransition, secondTransition])
    expect(after.transitions).toEqual(before.transitions)
    expect(after.links).toEqual(before.links)
    for (const oldTrack of before.tracks) for (const old of oldTrack.layers) {
      const moved = after.tracks.flatMap((t) => t.layers).find((l) => l.id === old.id)!
      expect([moved.t_start_us, moved.t_end_us]).toEqual([old.t_start_us + S, old.t_end_us + S])
    }
    expect(a.dispatch('undo', {}).ok).toBe(true)
    expect(root(a.snapshot()).tracks).toEqual(before.tracks)
    expect(root(a.snapshot()).transitions).toEqual(before.transitions)
  })

  it('moves adjacent clips in one edit despite intermediate overlap, undo and redo restore the whole set', () => {
    const { a, move, positions, first, second, tA } = setup()
    const before = positions()
    const count = a.historyStatus().len
    expect(move(3 * S).ok).toBe(true)
    expect(positions()).toEqual([[first, tA, 2 * S, 3 * S], [second, tA, 3 * S, 4 * S]])
    const after = positions()
    expect(a.historyStatus().len).toBe(count + 1)
    expect(a.dispatch('undo', {}).ok).toBe(true)
    expect(positions()).toEqual(before)
    expect(a.dispatch('redo', {}).ok).toBe(true)
    expect(positions()).toEqual(after)
  })

  it('floors the entire set at zero when the later member is dragged past the start', () => {
    const { move, positions, first, second, tA } = setup()
    expect(move(0).ok).toBe(true)
    expect(positions()).toEqual([[first, tA, 0, S], [second, tA, S, 2 * S]])
  })

  it('changes every destination in one edit', () => {
    const { a, move, positions, first, second, tB } = setup()
    const before = positions()
    expect(move(3 * S, tB).ok).toBe(true)
    expect(positions()).toEqual([[first, tB, 2 * S, 3 * S], [second, tB, 3 * S, 4 * S]])
    a.dispatch('undo', {})
    expect(positions()).toEqual(before)
  })

  it.each(['collision', 'track lock', 'clip lock'] as const)('refuses the entire edit on %s', (reason) => {
    const { a, move, positions, tB, second } = setup()
    if (reason === 'collision') idOf(a.dispatch('add_layer', { track: tB, kind: 'color', t_start_us: 3 * S, t_end_us: 4 * S }))
    if (reason === 'track lock') expect(a.dispatch('update_track_flags', { track: tB, patch: { locked: true } }).ok).toBe(true)
    if (reason === 'clip lock') expect(a.dispatch('update_layer', { layer: second, patch: { locked: true } }).ok).toBe(true)
    const before = positions()
    const count = a.historyStatus().len
    expect(move(3 * S, tB).ok).toBe(false)
    expect(positions()).toEqual(before)
    expect(a.historyStatus().len).toBe(count)
  })
})
