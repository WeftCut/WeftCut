// apps/desktop/src/main/state/reviewDiff.test.ts
// diffProjects: entity-level review diff, its projection and Group propagation
// (spec .scratch/agent-review/spec.md Part B — Diff; ADR 0115).
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createActor, type ActorHandle } from './actor'
import { seededGen } from './ids'
import { blankProject, type Layer, type Project, type Uuid } from './model'
import { root } from './__tests__/fixtures/project'
import { PBT_RUNS, PBT_SEED } from './__tests__/pbt/harness'
import {
  ABSENT, carryChangesTo, diffProjects, entityKey, extractEntities, groupDecorations, mergeRanges, parseEntityKey, touchedEntityKeys,
  type Change, type ChangeAspect, type ChangeDetail, type EntityKey, type EntityValue,
} from './reviewDiff'

const S = 1_000_000
const AV = '00000000-0000-0000-0000-0000000000ab'

function setup() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'review'), idGen: gen, clock: () => '<TS>' })
  const [tA, tB] = root(a.snapshot()).tracks.map((t) => t.id)
  return { a, tA, tB }
}
const ok = (r: ReturnType<ActorHandle['dispatch']>): unknown => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value }
const color = (a: ActorHandle, track: Uuid, s: number, e: number) => ok(a.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e })) as Uuid
const video = (a: ActorHandle, track: Uuid, s: number, e: number) =>
  ok(a.dispatch('add_layer', { track, kind: 'video', media: AV, src_in_us: 0, src_out_us: e - s, t_start_us: s, t_end_us: e })) as Uuid
const keyframed = (value: number) => ({
  mode: 'Keyframed' as const, extrapolate: { before: 'Hold' as const, after: 'Hold' as const },
  value: [{ id: 'k1', t_us: 0, value, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' as const }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' as const }, continuity: 'Broken' as const, segment: { kind: 'Linear' as const } }],
})
const L = (id: Uuid): EntityKey => entityKey('Layer', id)
const only = (cs: Change[]): Change => { expect(cs).toHaveLength(1); return cs[0] }
/** `p` with one layer edited in place — for edits no single command makes (a
 *  ripple head trim, a slip). */
const editLayer = (p: Project, id: Uuid, f: (l: Layer) => void): Project => {
  const q = structuredClone(p)
  for (const c of Object.values(q.compositions)) for (const t of c.tracks) for (const l of t.layers) if (l.id === id) f(l)
  return q
}
const window = (l: Layer, t0: number, t1: number, src0: number, src1: number) => {
  l.t_start_us = t0; l.t_end_us = t1
  Object.assign(l.params, { src_in_us: src0, src_out_us: src1 })
}
const detailsOf = (p: Project, q: Project, id: Uuid): ChangeDetail[] => diffProjects(p, q).find((c) => c.id === L(id))!.details

/** The details that can stand for each aspect; a composition move's timing is
 *  said by the move itself, a retime's new length by its speed. */
const SAYS: Record<ChangeAspect, ReadonlyArray<ChangeDetail['type']>> = {
  placement: ['track', 'composition'], timing: ['trim', 'shift', 'slip', 'composition', 'speed'], retime: ['speed'], params: ['params'],
  keyframes: ['keyframes'], effects: ['effect'], label: ['label'], flags: ['enabled', 'locked'],
}
/** Every aspect is said by a detail, and no fact is a zero. */
function detailsCover(c: Change): boolean {
  const covered = c.aspects.every((a) => c.details.some((d) => (d.type === 'aspect' && d.aspect === a) || SAYS[a].includes(d.type)))
  const nonzero = c.details.every((d) => !('delta_us' in d) || d.delta_us !== 0)
  return covered && nonzero
}

describe('entity keys', () => {
  it('round-trip kind and id', () => {
    expect(parseEntityKey(entityKey('Marker', 'a:b'))).toEqual({ kind: 'Marker', id: 'a:b' })
  })
})

describe('diffProjects — classes', () => {
  it('a project against itself, or a deep copy of itself, is empty', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const p = a.snapshot()
    expect(diffProjects(p, p)).toEqual([])
    expect(diffProjects(structuredClone(p), p)).toEqual([])
  })

  it('added and removed layers carry their footprint', () => {
    const { a, tA } = setup()
    const before = a.snapshot()
    const id = color(a, tA, 2 * S, 3 * S)
    const added = only(diffProjects(before, a.snapshot()))
    expect(added).toMatchObject({ class: 'added', kind: 'Layer', keys: [L(id)], aspects: [], ranges: [{ composition_id: before.root_id, t_start_us: 2 * S, t_end_us: 3 * S }] })
    const mid = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [id] }))
    expect(only(diffProjects(mid, a.snapshot()))).toMatchObject({ class: 'removed', keys: [L(id)], from: { composition_id: before.root_id, track_id: tA }, ranges: [{ t_start_us: 2 * S, t_end_us: 3 * S }] })
  })

  it('modified names its aspects: label, flags, params, keyframes, effects', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const id = video(a, tA, 0, S)
    const cases: Array<[() => void, string[]]> = [
      [() => ok(a.dispatch('update_layer', { layer: id, patch: { label: 'Intro' } })), ['label']],
      [() => ok(a.dispatch('set_layers_enabled', { layers: [id], enabled: false })), ['flags']],
      [() => ok(a.dispatch('update_layer_param_track', { layer: id, param_key: 'opacity', track: { mode: 'Static', value: 0.5 } })), ['params']],
      [() => ok(a.dispatch('update_layer_param_track', { layer: id, param_key: 'opacity', track: keyframed(0.2) })), ['keyframes']],
      [() => ok(a.dispatch('add_effect', { layer: id, kind: 'blur' })), ['effects']],
    ]
    for (const [edit, aspects] of cases) {
      const before = a.snapshot()
      edit()
      expect(only(diffProjects(before, a.snapshot()))).toMatchObject({ class: 'modified', keys: [L(id)], aspects })
    }
  })

  it('a trim is a timing modification; a retime adds the retime aspect', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const v = video(a, tA, 0, 4 * S)
    const before = a.snapshot()
    ok(a.dispatch('trim_layer', { layer: v, edge: 'end', new_t_us: 3 * S, escape_link: false }))
    const trim = only(diffProjects(before, a.snapshot()))
    // Where the clip is now — not where it was as well, which is baseline time.
    const now = root(a.snapshot()).tracks[0].layers.find((l) => l.id === v)!
    expect(trim).toMatchObject({ class: 'modified', aspects: ['timing'], ranges: [{ t_start_us: now.t_start_us, t_end_us: now.t_end_us }] })
    expect(now.t_end_us - now.t_start_us).toBe(S)
    const mid = a.snapshot()
    ok(a.dispatch('retime_layers', { layers: [v], target: { kind: 'Rate', value: { num: 2, den: 1 } } }))
    expect(only(diffProjects(mid, a.snapshot())).aspects).toContain('retime')
  })

  it('a move to another track is a placement modification, with both locations and the current footprint', () => {
    const { a, tA, tB } = setup()
    const id = color(a, tA, 0, S)
    const before = a.snapshot()
    ok(a.dispatch('move_layer', { layer: id, to_track: tB, t_start_us: S, escape_link: false }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c).toMatchObject({ class: 'modified', from: { track_id: tA }, to: { track_id: tB }, ranges: [{ t_start_us: S, t_end_us: 2 * S }] })
    expect(c.aspects).toEqual(['placement', 'timing'])
  })

  it('a pure translation in place is a timing modification, and same-delta translations group into one change', () => {
    const { a, tA, tB } = setup()
    const y = color(a, tB, 0, S)
    const x = color(a, tA, 3 * S, 4 * S)
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { layers: [x, y], delta_us: S }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c).toMatchObject({ id: `Shift:${before.root_id}:${S}`, class: 'modified', kind: 'Layer', delta_us: S, aspects: ['timing'] })
    // Moved on purpose, with nothing it was carried by.
    expect(c.carried).toBeUndefined()
    expect(c.keys).toEqual([L(x), L(y)].sort())
    expect(c.ranges.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[S, 2 * S], [4 * S, 5 * S]])
  })

  it('an anchored marker rides its shifted layer into the same group; a free marker moved on its own is its own shift', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const x = video(a, tA, 0, S)
    const m = ok(a.dispatch('add_marker', { t_us: S / 2 })) as Uuid
    ok(a.dispatch('attach_marker', { marker: m, layer: x }))
    const free = ok(a.dispatch('add_marker', { t_us: 5 * S })) as Uuid
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { layers: [x], delta_us: 2 * S }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c).toMatchObject({ class: 'modified', delta_us: 2 * S })
    expect(c.keys).toEqual([L(x), entityKey('Marker', m)].sort())
    const mid = a.snapshot()
    // A free marker moved with nothing under it moved on its own.
    ok(a.dispatch('update_marker', { marker: free, patch: { t_us: 6 * S } }))
    expect(only(diffProjects(mid, a.snapshot()))).toMatchObject({ class: 'modified', kind: 'Marker', aspects: ['timing'], delta_us: S, keys: [entityKey('Marker', free)] })
  })

  it('a ripple delete is one removed change and one shift group', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    const gone = color(a, tA, S, 2 * S)
    const y = color(a, tA, 2 * S, 3 * S)
    const z = color(a, tB, 4 * S, 5 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }))
    const cs = diffProjects(before, a.snapshot())
    expect(cs.map((c) => c.class)).toEqual(['removed', 'modified'])
    // What closed up behind the removal was carried, not moved on purpose.
    expect(cs[1].carried).toBe(true)
    expect(cs[0].keys).toEqual([L(gone)])
    expect(cs[1]).toMatchObject({ delta_us: -S, keys: [L(y), L(z)].sort() })
    expect(cs.flatMap((c) => c.keys)).not.toContain(L(x))
    // On the current timeline: the removal is the seam it closed, the shift
    // where the shifted clips are now.
    expect(cs[0].ranges.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[S, S]])
    expect(cs[1].ranges.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[S, 2 * S], [3 * S, 4 * S]])
  })

  it('a translation is carried only as the tail after another change, starting where it ends', () => {
    const { a, tA, tB } = setup()
    const head = color(a, tA, 0, 2 * S)
    const gone = color(a, tA, 2 * S, 3 * S)
    color(a, tA, 3 * S, 4 * S)
    color(a, tA, 5 * S, 6 * S)
    const far = color(a, tA, 8 * S, 9 * S)
    const broll = color(a, tB, 6 * S, 7 * S)
    const before = a.snapshot()
    // Two ripples: everything after each seam closes up, the tail after the
    // second by both. Both groups are carried — B roll included, as the tail
    // of its own track.
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }))
    ok(a.dispatch('ripple_delete_layers', { layers: [far] }))
    void broll
    const carried = (cs: Change[]) => cs.filter((c) => c.delta_us !== undefined).map((c) => [c.delta_us, c.carried ?? false])
    expect(carried(diffProjects(before, a.snapshot()))).toEqual([[-S, true]])
    // A gap closed with nothing removed: the first clip after it moved on
    // its own, and carried the rest — B roll included — along.
    const mid = a.snapshot()
    ok(a.dispatch('shift_layers', { from_t_us: 4 * S, tracks: null, delta_us: -S }))
    const cs = diffProjects(mid, a.snapshot())
    expect(carried(cs)).toEqual([[-S, false], [-S, true]])
    expect(cs[1]).toMatchObject({ carried_by: cs[0].id, keys: [L(broll)] })
    void head
  })

  it('a removed clip is carried by its neighbours through a later ripple elsewhere', () => {
    const { a, tA } = setup()
    const first = color(a, tA, 0, 2 * S)
    color(a, tA, 2 * S, 4 * S)
    const lifted = color(a, tA, 4 * S, 5 * S)
    color(a, tA, 5 * S, 6 * S)
    const before = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [lifted] }))
    ok(a.dispatch('ripple_delete_layers', { layers: [first] }))
    const gone = diffProjects(before, a.snapshot()).find((c) => c.id === L(lifted))!
    // The gap it left moved 2 s earlier with everything around it.
    expect(gone.ranges.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[2 * S, 3 * S]])
  })

  it('a removed clip follows the material under it, cut short where that material was trimmed away', () => {
    const { a, tA, tB } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const under = video(a, tA, 0, 8 * S)
    const over = color(a, tB, 3 * S, 5 * S)
    const before = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [over] }))
    ok(a.dispatch('trim_layer', { layer: under, edge: 'out', new_t_us: 4 * S, escape_link: false }))
    const gone = diffProjects(before, a.snapshot()).find((c) => c.id === L(over))!
    expect(gone.ranges.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[3 * S, 4 * S]])
  })

  it('listed-only changes have no ranges: track label, link, composition label', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    const y = color(a, tB, 0, S)
    const before = a.snapshot()
    ok(a.dispatch('rename_track', { track: tA, label: 'Dialogue' }))
    const link = ok(a.dispatch('links_create', { layers: [x, y] })) as Uuid
    const cs = diffProjects(before, a.snapshot())
    expect(cs.map((c) => [c.class, c.kind, c.ranges])).toEqual([['added', 'Link', []], ['modified', 'Track', []]])
    expect(cs[0].keys).toEqual([entityKey('Link', link)])
    expect(cs[1].aspects).toEqual(['label'])
  })
})

describe('diffProjects — details', () => {
  function clip() {
    const { a, tA, tB } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const v = video(a, tA, 0, 4 * S)
    return { a, tA, tB, v, before: a.snapshot() }
  }

  it('added and removed say their length; a removed one as it was', () => {
    const { a, tA } = setup()
    const before = a.snapshot()
    const id = color(a, tA, 2 * S, 5 * S)
    const m = ok(a.dispatch('add_marker', { t_us: S, end_t_us: 2 * S })) as Uuid
    const point = ok(a.dispatch('add_marker', { t_us: 3 * S })) as Uuid
    const cs = diffProjects(before, a.snapshot())
    expect(cs.find((c) => c.id === L(id))!.details).toEqual([{ type: 'length', duration_us: 3 * S }])
    expect(cs.find((c) => c.id === entityKey('Marker', m))!.details).toEqual([{ type: 'length', duration_us: S }])
    expect(cs.find((c) => c.id === entityKey('Marker', point))!.details).toEqual([])
    const mid = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [id] }))
    expect(only(diffProjects(mid, a.snapshot())).details).toEqual([{ type: 'length', duration_us: 3 * S }])
  })

  it('an end trimmed or extended is that end alone', () => {
    const { a, v, before } = clip()
    ok(a.dispatch('trim_layer', { layer: v, edge: 'out', new_t_us: 3 * S, escape_link: false }))
    const cut = a.snapshot()
    expect(detailsOf(before, cut, v)).toEqual([{ type: 'trim', side: 'end', delta_us: -S }])
    ok(a.dispatch('trim_layer', { layer: v, edge: 'out', new_t_us: 3.5 * S, escape_link: false }))
    expect(detailsOf(cut, a.snapshot(), v)).toEqual([{ type: 'trim', side: 'end', delta_us: S / 2 }])
  })

  it('a head trimmed in place: the start moved with the source in, the material stayed', () => {
    const { a, v, before } = clip()
    ok(a.dispatch('trim_layer', { layer: v, edge: 'in', new_t_us: S, escape_link: false }))
    expect(detailsOf(before, a.snapshot(), v)).toEqual([{ type: 'trim', side: 'start', delta_us: -S }])
  })

  it('a head trimmed with ripple: the start stayed, so the clip did not move', () => {
    const { v, before } = clip()
    const after = editLayer(before, v, (l) => window(l, 0, 3 * S, S, 4 * S))
    expect(detailsOf(before, after, v)).toEqual([{ type: 'trim', side: 'start', delta_us: -S }])
  })

  it('moved and its end trimmed: a shift with the material, and the end trim', () => {
    const { tA, v, before } = clip()
    const after = editLayer(before, v, (l) => window(l, 2 * S, 5 * S, 0, 3 * S))
    const c = diffProjects(before, after).find((x) => x.id === L(v))!
    expect(c.delta_us).toBeUndefined()
    expect(c.details).toEqual([{ type: 'shift', delta_us: 2 * S }, { type: 'trim', side: 'end', delta_us: -S }])
    // Moved on purpose: it shows where it was.
    expect(c.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: 0, t_end_us: 4 * S }])
  })

  it('trimmed in place is no move: no place it was', () => {
    const { a, v, before } = clip()
    ok(a.dispatch('trim_layer', { layer: v, edge: 'in', new_t_us: S, escape_link: false }))
    expect(diffProjects(before, a.snapshot()).find((x) => x.id === L(v))!.was).toBeUndefined()
  })

  it('a slip: same edges, the source window moved (later in the source is positive)', () => {
    const { v, before } = clip()
    expect(detailsOf(before, editLayer(before, v, (l) => window(l, 0, 4 * S, S, 5 * S)), v)).toEqual([{ type: 'slip', delta_us: S }])
  })

  it('a layer with no source window reads its edges: equal is a shift, else a trim per edge', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    const before = a.snapshot()
    const moved = editLayer(before, x, (l) => { l.t_start_us = S; l.t_end_us = 2 * S; l.label = 'x' })
    expect(detailsOf(before, moved, x)).toEqual([{ type: 'shift', delta_us: S }, { type: 'label' }])
    const both = editLayer(before, x, (l) => { l.t_start_us = S / 2; l.t_end_us = 3 * S })
    expect(detailsOf(before, both, x)).toEqual([{ type: 'trim', side: 'start', delta_us: -S / 2 }, { type: 'trim', side: 'end', delta_us: 2 * S }])
  })

  it('a retime is its speed: the material it kept is no trim', () => {
    const { a, v, before } = clip()
    ok(a.dispatch('retime_layers', { layers: [v], target: { kind: 'Rate', value: { num: 2, den: 1 } } }))
    const fast = a.snapshot()
    expect(detailsOf(before, fast, v)).toEqual([{ type: 'speed', from: 1, to: 2 }])
    // Retimed and its end cut: the cut is against the material at that end.
    const cut = editLayer(fast, v, (l) => { l.t_end_us = 1.5 * S; Object.assign(l.params, { src_out_us: 3 * S }) })
    expect(detailsOf(before, cut, v)).toEqual([{ type: 'trim', side: 'end', delta_us: -S / 2 }, { type: 'speed', from: 1, to: 2 }])
  })

  it('a move to another track: the track, then the shift', () => {
    const { a, tA, tB, v, before } = clip()
    ok(a.dispatch('move_layer', { layer: v, to_track: tB, t_start_us: S, escape_link: false }))
    expect(detailsOf(before, a.snapshot(), v)).toEqual([{ type: 'track', from: tA, to: tB }, { type: 'shift', delta_us: S }])
  })

  it('params and keyframes by wire key, effects per instance, label and flags with their value', () => {
    const { a, v } = clip()
    const cases: Array<[() => void, ChangeDetail[]]> = [
      [() => ok(a.dispatch('update_layer_param_track', { layer: v, param_key: 'opacity', track: { mode: 'Static', value: 0.5 } })), [{ type: 'params', keys: ['opacity'] }]],
      [() => ok(a.dispatch('update_layer_param_track', { layer: v, param_key: 'x', track: { mode: 'Static', value: 40 } })), [{ type: 'params', keys: ['x'] }]],
      [() => ok(a.dispatch('update_layer_param_track', { layer: v, param_key: 'rotation_deg', track: keyframed(2) })), [{ type: 'keyframes', keys: ['rotation_deg'] }]],
      [() => ok(a.dispatch('add_effect', { layer: v, kind: 'blur' })), [{ type: 'effect', op: 'added', effect: 'blur' }]],
      [() => ok(a.dispatch('update_layer', { layer: v, patch: { label: 'Intro' } })), [{ type: 'label' }]],
      [() => ok(a.dispatch('set_layers_enabled', { layers: [v], enabled: false })), [{ type: 'enabled', value: false }]],
    ]
    for (const [edit, details] of cases) {
      const before = a.snapshot()
      edit()
      expect(detailsOf(before, a.snapshot(), v)).toEqual(details)
    }
    const fx = a.snapshot().compositions[a.snapshot().root_id].tracks[0].layers[0].effects[0]
    const before = a.snapshot()
    ok(a.dispatch('remove_effect', { layer: v, effect: fx.id }))
    expect(detailsOf(before, a.snapshot(), v)).toEqual([{ type: 'effect', op: 'removed', effect: 'blur' }])
  })

  it('a marker: moved is a shift, an end moved is a trim, colour is a param', () => {
    const { a } = setup()
    const m = ok(a.dispatch('add_marker', { t_us: S, end_t_us: 2 * S })) as Uuid
    const M = entityKey('Marker', m)
    const step = (patch: object): ChangeDetail[] => {
      const before = a.snapshot()
      ok(a.dispatch('update_marker', { marker: m, patch }))
      return diffProjects(before, a.snapshot()).find((c) => c.keys.includes(M))!.details
    }
    expect(step({ t_us: 2 * S, end_t_us: 3 * S })).toEqual([{ type: 'shift', delta_us: S }])
    expect(step({ end_t_us: 4 * S })).toEqual([{ type: 'trim', side: 'end', delta_us: S }])
    expect(step({ color: { r: 1, g: 2, b: 3, a: 255 }, note: 'n' })).toEqual([{ type: 'params', keys: ['color'] }, { type: 'label' }])
  })

  it('a shift group says its delta; a carried one names its carrier', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const gone = color(a, tA, S, 2 * S)
    color(a, tA, 2 * S, 3 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }))
    const shift = diffProjects(before, a.snapshot()).find((c) => c.delta_us !== undefined)!
    expect(shift).toMatchObject({ carried: true, carried_by: L(gone), details: [{ type: 'shift', delta_us: -S }] })
    expect(shift.was).toBeUndefined()
  })
})

describe('diffProjects — movement against the content around it', () => {
  const span = (c: Change) => c.ranges.map((r) => [r.t_start_us, r.t_end_us])
  const byKey = (cs: Change[], id: Uuid) => cs.find((c) => c.keys.includes(L(id)))!
  /** A-roll footage around a 4 s clip `gone`, B roll `b` over the footage after it. */
  function aroll() {
    const { a, tA, tB } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const head = video(a, tA, 0, 10 * S)
    const gone = video(a, tA, 10 * S, 14 * S)
    const tail = video(a, tA, 14 * S, 30 * S)
    const b = video(a, tB, 16 * S, 20 * S)
    return { a, tA, tB, head, gone, tail, b, before: a.snapshot() }
  }

  it('a ripple delete on the A roll carries its tail and the B roll over it, all by the removal', () => {
    const { a, tB, gone, tail, b, before } = aroll()
    const late = color(a, tB, 31 * S, 32 * S) // over no A roll: the A-roll content before it
    const base = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }))
    const cs = diffProjects(base, a.snapshot())
    expect(cs.map((c) => [c.class, c.carried ?? false])).toEqual([['removed', false], ['modified', true]])
    expect(cs[1]).toMatchObject({ id: `Shift:${before.root_id}:${-4 * S}:${L(gone)}`, carried_by: L(gone), delta_us: -4 * S, details: [{ type: 'shift', delta_us: -4 * S }] })
    expect(cs[1].keys).toEqual([L(tail), L(b), L(late)].sort())
    expect(cs[1].was).toBeUndefined()
  })

  it('carried by a ripple and then trimmed: its own edits only, carried by the removal', () => {
    const { a, gone, tail, b, before } = aroll()
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }))
    ok(a.dispatch('trim_layer', { layer: b, edge: 'in', new_t_us: 12.2 * S, escape_link: false }))
    ok(a.dispatch('trim_layer', { layer: b, edge: 'out', new_t_us: 15.7 * S, escape_link: false }))
    const cs = diffProjects(before, a.snapshot())
    const row = cs.find((c) => c.id === L(b))!
    expect(row).toMatchObject({ class: 'modified', aspects: ['timing'], carried_by: L(gone), carried_us: -4 * S })
    expect(row.details).toEqual([{ type: 'trim', side: 'start', delta_us: -0.2 * S }, { type: 'trim', side: 'end', delta_us: -0.3 * S }])
    expect(row.carried).toBeUndefined()
    expect(row.was).toBeUndefined()
    // The A roll it sat over still goes with the removal alone.
    expect(byKey(cs, tail)).toMatchObject({ carried: true, carried_by: L(gone), keys: [L(tail)] })
  })

  it('carried, then moved again on its own: its own movement, from the carried place', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const gone = color(a, tA, S, 2 * S)
    const b = color(a, tA, 4 * S, 5 * S)
    const c = color(a, tA, 7 * S, 8 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] })) // b → 3 s, c → 6 s
    ok(a.dispatch('shift_layers', { layers: [b], delta_us: -S })) // b → 2 s
    const cs = diffProjects(before, a.snapshot())
    const own = byKey(cs, b)
    expect(own).toMatchObject({ id: `Shift:${before.root_id}:${-S}`, delta_us: -S, details: [{ type: 'shift', delta_us: -S }], keys: [L(b)] })
    expect(own.carried).toBeUndefined()
    expect(own.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: 3 * S, t_end_us: 4 * S }])
    // The clip after it stayed with the ripple, not with it.
    expect(byKey(cs, c)).toMatchObject({ carried: true, carried_by: L(gone), delta_us: -S })
    // Moved on its own and edited: a row that says its own shift, placed the same.
    ok(a.dispatch('update_layer', { layer: b, patch: { label: 'b' } }))
    const row = diffProjects(before, a.snapshot()).find((x) => x.id === L(b))!
    expect(row.details).toEqual([{ type: 'shift', delta_us: -S }, { type: 'label' }])
    expect(row.was).toEqual(own.was)
    expect(row.carried_by).toBeUndefined()
  })

  it('a gap closed with nothing removed: the first clip after it (and its sound) moved on its own and carried the rest', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: true }))
    const sound = (s0: number, e0: number) => ok(a.dispatch('add_layer', { track: tA, kind: 'audio', media: AV, src_in_us: 0, src_out_us: e0 - s0, t_start_us: s0, t_end_us: e0 })) as Uuid
    video(a, tA, 0, S); sound(0, S)
    const v2 = video(a, tA, 3 * S, 4 * S), a2 = sound(3 * S, 4 * S)
    const v3 = video(a, tA, 4 * S, 5 * S), a3 = sound(4 * S, 5 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_gap', { track: tA, s: S, e: 3 * S }))
    const cs = diffProjects(before, a.snapshot())
    expect(cs).toHaveLength(2)
    const id = `Shift:${before.root_id}:${-2 * S}`
    expect(cs[0]).toMatchObject({ id, delta_us: -2 * S, keys: [L(v2), L(a2)].sort() })
    expect(cs[0].carried).toBeUndefined()
    expect(cs[0].was).toEqual([v2, a2].map(() => ({ composition_id: before.root_id, track_id: tA, t_start_us: 3 * S, t_end_us: 4 * S })))
    expect(cs[1]).toMatchObject({ carried: true, carried_by: id, delta_us: -2 * S, keys: [L(v3), L(a3)].sort() })
  })

  it('a lone clip moved into a gap, its neighbours untouched, moved on its own', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const b = color(a, tA, 3 * S, 4 * S)
    color(a, tA, 6 * S, 7 * S)
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { layers: [b], delta_us: S }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c).toMatchObject({ delta_us: S, keys: [L(b)] })
    expect(c.carried).toBeUndefined()
    expect(c.carried_by).toBeUndefined()
    expect(c.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: 3 * S, t_end_us: 4 * S }])
  })

  it('an end trimmed with ripple carries what is after it', () => {
    const { a, tA } = setup()
    const t = color(a, tA, 0, 2 * S)
    const n = color(a, tA, 2 * S, 3 * S)
    const m = color(a, tA, 3 * S, 4 * S)
    const before = a.snapshot()
    ok(a.dispatch('trim_layer', { layer: t, edge: 'out', new_t_us: S, escape_link: false }))
    ok(a.dispatch('shift_layers', { from_t_us: 2 * S, tracks: null, delta_us: -S }))
    const cs = diffProjects(before, a.snapshot())
    expect(cs.map((c) => c.id)).toEqual([L(t), `Shift:${before.root_id}:${-S}:${L(t)}`])
    expect(cs[0].details).toEqual([{ type: 'trim', side: 'end', delta_us: -S }])
    expect(cs[0].was).toBeUndefined()
    expect(cs[1]).toMatchObject({ carried: true, carried_by: L(t), keys: [L(n), L(m)].sort() })
  })

  it('an insert that made room carries what is after it', () => {
    const { a, tA } = setup()
    color(a, tA, 0, 2 * S)
    const b = color(a, tA, 2 * S, 4 * S)
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { from_t_us: 2 * S, tracks: null, delta_us: S }))
    const ins = color(a, tA, 2 * S, 3 * S)
    const cs = diffProjects(before, a.snapshot())
    expect(cs.map((c) => [c.id, c.class])).toEqual([[L(ins), 'added'], [`Shift:${before.root_id}:${S}:${L(ins)}`, 'modified']])
    expect(cs[1]).toMatchObject({ carried: true, carried_by: L(ins), keys: [L(b)] })
  })

  it('two ripples on two tracks by the same amount are two carried groups, each by its own removal', () => {
    const { a, tA, tB } = setup()
    color(a, tA, 0, S)
    const g1 = color(a, tA, S, 2 * S)
    const b = color(a, tA, 2 * S, 3 * S)
    color(a, tB, 4 * S, 5 * S)
    const g2 = color(a, tB, 5 * S, 6 * S)
    const q = color(a, tB, 6 * S, 7 * S)
    const before = a.snapshot()
    // Each track closed up on its own (no single command does both).
    let after = editLayer(before, b, (l) => { l.t_start_us = S; l.t_end_us = 2 * S })
    after = editLayer(after, q, (l) => { l.t_start_us = 5 * S; l.t_end_us = 6 * S })
    for (const t of root(after).tracks) t.layers = t.layers.filter((l) => l.id !== g1 && l.id !== g2)
    const carried = diffProjects(before, after).filter((c) => c.carried)
    expect(carried.map((c) => [c.carried_by, c.delta_us, c.keys])).toEqual([[L(g1), -S, [L(b)]], [L(g2), -S, [L(q)]]])
    expect(new Set(carried.map((c) => c.id)).size).toBe(2)
  })

  it('two ripples on one track: between them carried by the first, after the second by the second, all the way', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const g1 = color(a, tA, S, 2 * S)
    const b = color(a, tA, 2 * S, 3 * S)
    const g2 = color(a, tA, 3 * S, 4 * S)
    const c = color(a, tA, 4 * S, 5 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [g1] }))
    ok(a.dispatch('ripple_delete_layers', { layers: [g2] }))
    const cs = diffProjects(before, a.snapshot())
    expect(byKey(cs, b)).toMatchObject({ carried: true, carried_by: L(g1), delta_us: -S })
    expect(byKey(cs, c)).toMatchObject({ carried: true, carried_by: L(g2), delta_us: -2 * S })
    expect(span(byKey(cs, c))).toEqual([[2 * S, 3 * S]])
  })
})

describe('diffProjects — where a move was', () => {
  it('a deliberate shift: where it was, not following it to where it went', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const b = color(a, tA, S, 2 * S)
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { layers: [b], delta_us: 2 * S }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c.carried).toBeUndefined()
    expect(c.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: S, t_end_us: 2 * S }])
  })

  it('a move to another track: its baseline place on the current timeline, carried by a ripple before it', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    color(a, tA, S, 2 * S)
    const b = color(a, tA, 2 * S, 3 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [x] }))
    ok(a.dispatch('move_layer', { layer: b, to_track: tB, t_start_us: 6 * S, escape_link: false }))
    const c = diffProjects(before, a.snapshot()).find((ch) => ch.id === L(b))!
    expect(c.details[0]).toEqual({ type: 'track', from: tA, to: tB })
    expect(c.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: S, t_end_us: 2 * S }])
  })

  it('what one call moved is placed on today\'s timeline', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    color(a, tA, S, 2 * S)
    const b = color(a, tA, 2 * S, 3 * S)
    const before = a.snapshot()
    ok(a.dispatch('move_layer', { layer: b, to_track: tB, t_start_us: 6 * S, escape_link: false }))
    const then = a.snapshot()
    const c = only(diffProjects(before, then))
    expect(c.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: 2 * S, t_end_us: 3 * S }])
    ok(a.dispatch('ripple_delete_layers', { layers: [x] }))
    const [now] = carryChangesTo([c], then, a.snapshot())
    expect(now.was).toEqual([{ composition_id: before.root_id, track_id: tA, t_start_us: S, t_end_us: 2 * S }])
    expect(now.details).toEqual(c.details)
  })
})

describe('diffProjects — track order', () => {
  it('a track reorder is a listed-only placement change of the composition; adding a track is not', () => {
    const { a, tA } = setup()
    const before = a.snapshot()
    ok(a.dispatch('move_track', { track: tA, new_position: 1 }))
    const after = a.snapshot()
    const c = only(diffProjects(before, after))
    expect(c).toMatchObject({ class: 'modified', kind: 'Composition', keys: [entityKey('Composition', before.root_id)], aspects: ['placement'], ranges: [] })
    expect([...touchedEntityKeys(before, after)]).toEqual([entityKey('Composition', before.root_id)])
    const mid = a.snapshot()
    const t = ok(a.dispatch('add_track', {})) as Uuid
    const added = diffProjects(mid, a.snapshot())
    expect(added.map((x) => [x.class, x.kind, x.id])).toEqual([['added', 'Track', entityKey('Track', t)]])
    expect([...touchedEntityKeys(mid, a.snapshot())]).toEqual([entityKey('Track', t)])
  })
})

describe('diffProjects — exclusions', () => {
  it('track mute/solo/lock/enable, composition envelope, settings and media pool produce nothing', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const before = a.snapshot()
    ok(a.dispatch('update_track_flags', { track: tA, patch: { muted: true, solo: true, locked: true, enabled: false } }))
    ok(a.dispatch('set_composition', { width: 1280, height: 720, background: { r: 9, g: 9, b: 9, a: 255 } }))
    ok(a.dispatch('update_project_settings', { patch: { prefer_proxies: true } }))
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const after = a.snapshot()
    expect(after).not.toBe(before)
    expect(diffProjects(before, after)).toEqual([])
    expect(touchedEntityKeys(before, after).size).toBe(0)
  })

  it('track height and the transient/removable bookkeeping are not compared', () => {
    const { a } = setup()
    const p = a.snapshot()
    const r = root(p)
    const q: Project = { ...p, compositions: { ...p.compositions, [r.id]: { ...r, duration_us: 99 * S, tracks: r.tracks.map((t) => ({ ...t, height_px: 200, transient: true })) } } }
    expect(diffProjects(p, q)).toEqual([])
    expect(touchedEntityKeys(p, q).size).toBe(0)
  })
})

describe('diffProjects — compositions and Groups', () => {
  function grouped() {
    const { a, tA, tB } = setup()
    const v = color(a, tA, 2 * S, 5 * S)
    const w = color(a, tB, 2 * S, 5 * S)
    const { composition_id, layer_id } = ok(a.dispatch('groups_create', { layers: [v, w], label: 'Intro' })) as { composition_id: Uuid; layer_id: Uuid }
    return { a, tA, tB, v, w, inside: composition_id, group: layer_id }
  }

  it('creating a Group: composition added with its tracks folded in; members moved across compositions with one range per composition', () => {
    const { a, tA } = setup()
    const v = color(a, tA, 2 * S, 5 * S)
    const before = a.snapshot()
    const { composition_id, layer_id } = ok(a.dispatch('groups_create', { layers: [v], label: 'Intro' })) as { composition_id: Uuid; layer_id: Uuid }
    const after = a.snapshot()
    const cs = diffProjects(before, after)
    const comp = cs.find((c) => c.kind === 'Composition')!
    expect(comp.class).toBe('added')
    expect(comp.keys).toEqual(expect.arrayContaining([entityKey('Composition', composition_id), ...after.compositions[composition_id].tracks.map((t) => entityKey('Track', t.id))]))
    expect(cs.filter((c) => c.kind === 'Track')).toEqual([])
    const moved = cs.find((c) => c.id === L(v))!
    expect(moved).toMatchObject({ class: 'modified', aspects: expect.arrayContaining(['placement']), from: { composition_id: before.root_id, track_id: tA } })
    expect(new Set(moved.ranges.map((r) => r.composition_id))).toEqual(new Set([before.root_id, composition_id]))
    expect(cs.find((c) => c.id === L(layer_id))).toMatchObject({ class: 'added' })
  })

  it('a change inside a Group decorates the Group layer with the Group layer footprint', () => {
    const { a, v, group } = grouped()
    const before = a.snapshot()
    ok(a.dispatch('update_layer', { layer: v, patch: { label: 'inner' } }))
    const after = a.snapshot()
    const cs = diffProjects(before, after)
    const gl = root(after).tracks.flatMap((t) => t.layers).find((l) => l.id === group)!
    expect(groupDecorations(cs, after)).toEqual([{ layer_id: group, composition_id: after.root_id, t_start_us: gl.t_start_us, t_end_us: gl.t_end_us, change_ids: [L(v)] }])
  })

  it('propagates recursively through nested Groups, and not for composition-level changes', () => {
    const { a, v, inside, group } = grouped()
    // Nest: group the outer Group layer itself into a second Group.
    const outer = ok(a.dispatch('groups_create', { layers: [group], label: 'Outer' })) as { composition_id: Uuid; layer_id: Uuid }
    const before = a.snapshot()
    ok(a.dispatch('update_layer', { layer: v, patch: { label: 'deep' } }))
    ok(a.dispatch('groups_rename', { composition: inside, label: 'Renamed' }))
    const after = a.snapshot()
    const cs = diffProjects(before, after)
    expect(cs.map((c) => c.kind).sort()).toEqual(['Composition', 'Layer'])
    const decos = groupDecorations(cs, after)
    expect(decos.map((d) => [d.layer_id, d.composition_id, d.change_ids])).toEqual(expect.arrayContaining([
      [group, outer.composition_id, [L(v)]],
      [outer.layer_id, after.root_id, [L(v)]],
    ]))
    expect(decos).toHaveLength(2)
  })

  it('a move out of a Group yields a range in each composition', () => {
    const { a, tA, v, inside } = grouped()
    const before = a.snapshot()
    ok(a.dispatch('move_layers_to_composition', { layers: [v], to_composition: before.root_id, anchor_layer: v, anchor_t_start_us: 8 * S, to_track: tA }))
    const c = only(diffProjects(before, a.snapshot()).filter((x) => x.id === L(v)))
    expect(c.class).toBe('modified')
    expect(c.from).toBeDefined()
    expect(c.ranges.map((r) => r.composition_id).sort()).toEqual([before.root_id, inside].sort())
    expect(c.ranges.find((r) => r.composition_id === before.root_id)).toMatchObject({ t_start_us: 8 * S })
  })
})

describe('diffProjects — effective baseline overlay', () => {
  it('an approved value hides its change; ABSENT approves a removal; other changes remain', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    const y = color(a, tA, 2 * S, 3 * S)
    const base = a.snapshot()
    ok(a.dispatch('update_layer', { layer: x, patch: { label: 'edited' } }))
    ok(a.dispatch('delete_layers', { layers: [y] }))
    const cur = a.snapshot()
    expect(diffProjects(base, cur).map((c) => c.id)).toEqual([L(x), L(y)])
    const approved = new Map<EntityKey, EntityValue | typeof ABSENT>([[L(x), extractEntities(cur).get(L(x))!]])
    expect(diffProjects({ base, approved }, cur).map((c) => c.id)).toEqual([L(y)])
    approved.set(L(y), ABSENT)
    expect(diffProjects({ base, approved }, cur)).toEqual([])
    // Editing an approved entity again reappears against the approved value.
    ok(a.dispatch('update_layer', { layer: x, patch: { label: 'again' } }))
    expect(only(diffProjects({ base, approved }, a.snapshot()))).toMatchObject({ id: L(x), class: 'modified', aspects: ['label'] })
  })

  it('an approved value inside a composition both sides share still differs from it', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    const first = a.snapshot()
    ok(a.dispatch('update_layer', { layer: x, patch: { label: 'approved' } }))
    const approved = new Map<EntityKey, EntityValue | typeof ABSENT>([[L(x), extractEntities(a.snapshot()).get(L(x))!]])
    // Undone back to `first`: the base and current root are one object.
    expect(only(diffProjects({ base: first, approved }, first))).toMatchObject({ id: L(x), class: 'modified', aspects: ['label'] })
  })
})

describe('mergeRanges', () => {
  it('merges overlapping and adjacent ranges per composition', () => {
    expect(mergeRanges([
      { composition_id: 'b', t_start_us: 0, t_end_us: 1 },
      { composition_id: 'a', t_start_us: 5, t_end_us: 6 },
      { composition_id: 'a', t_start_us: 0, t_end_us: 2 },
      { composition_id: 'a', t_start_us: 2, t_end_us: 3 },
    ])).toEqual([
      { composition_id: 'a', t_start_us: 0, t_end_us: 3 },
      { composition_id: 'a', t_start_us: 5, t_end_us: 6 },
      { composition_id: 'b', t_start_us: 0, t_end_us: 1 },
    ])
  })
})

describe('touchedEntityKeys', () => {
  it('is empty for one snapshot and names exactly the edited entity', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    color(a, tB, 0, S)
    const before = a.snapshot()
    expect(touchedEntityKeys(before, before).size).toBe(0)
    ok(a.dispatch('update_layer', { layer: x, patch: { label: 'x' } }))
    expect([...touchedEntityKeys(before, a.snapshot())]).toEqual([L(x)])
  })
})

// ── Properties ───────────────────────────────────────────────────────────────

type Op =
  | { t: 'add'; track: 0 | 1; start: number; len: number }
  | { t: 'move'; n: number; track: 0 | 1; start: number }
  | { t: 'trim'; n: number; edge: 'start' | 'end'; to: number }
  | { t: 'shift'; n: number; delta: number }
  | { t: 'delete'; n: number }
  | { t: 'ripple'; n: number }
  | { t: 'label'; n: number }
  | { t: 'marker'; at: number; attach: number | null }
  | { t: 'group'; n: number }
  | { t: 'reorder'; n: number }

const step = (n: number) => n * 100_000
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('add' as const), track: fc.constantFrom(0 as const, 1 as const), start: fc.integer({ min: 0, max: 9 }).map(step), len: fc.integer({ min: 1, max: 9 }).map(step) }),
  fc.record({ t: fc.constant('move' as const), n: fc.nat(20), track: fc.constantFrom(0 as const, 1 as const), start: fc.integer({ min: 0, max: 12 }).map(step) }),
  fc.record({ t: fc.constant('trim' as const), n: fc.nat(20), edge: fc.constantFrom('start' as const, 'end' as const), to: fc.integer({ min: 0, max: 12 }).map(step) }),
  fc.record({ t: fc.constant('shift' as const), n: fc.nat(20), delta: fc.integer({ min: -5, max: 5 }).map(step) }),
  fc.record({ t: fc.constant('delete' as const), n: fc.nat(20) }),
  fc.record({ t: fc.constant('ripple' as const), n: fc.nat(20) }),
  fc.record({ t: fc.constant('label' as const), n: fc.nat(20) }),
  fc.record({ t: fc.constant('marker' as const), at: fc.integer({ min: 0, max: 12 }).map(step), attach: fc.option(fc.nat(20), { nil: null }) }),
  fc.record({ t: fc.constant('group' as const), n: fc.nat(20) }),
  fc.record({ t: fc.constant('reorder' as const), n: fc.nat(20) }),
)

/** Apply one op against the live snapshot; refusals are simply skipped. */
function apply(a: ActorHandle, op: Op): void {
  const p = a.snapshot()
  const tracks = root(p).tracks.map((t) => t.id)
  const layers = Object.values(p.compositions).flatMap((c) => c.tracks.flatMap((t) => t.layers.map((l) => l.id)))
  const pick = (n: number) => layers[n % layers.length]
  if (op.t === 'reorder') { if (tracks.length > 1) a.dispatch('move_track', { track: tracks[op.n % tracks.length], new_position: (op.n + 1) % tracks.length }); return }
  if (op.t !== 'add' && op.t !== 'marker' && layers.length === 0) return
  switch (op.t) {
    case 'add': a.dispatch('add_layer', { track: tracks[op.track], kind: 'color', t_start_us: op.start, t_end_us: op.start + op.len }); break
    case 'move': a.dispatch('move_layer', { layer: pick(op.n), to_track: tracks[op.track], t_start_us: op.start, escape_link: false }); break
    case 'trim': a.dispatch('trim_layer', { layer: pick(op.n), edge: op.edge, new_t_us: op.to, escape_link: false }); break
    case 'shift': a.dispatch('shift_layers', { layers: [pick(op.n)], delta_us: op.delta }); break
    case 'delete': a.dispatch('delete_layers', { layers: [pick(op.n)] }); break
    case 'ripple': a.dispatch('ripple_delete_layers', { layers: [pick(op.n)] }); break
    case 'label': a.dispatch('update_layer', { layer: pick(op.n), patch: { label: `L${op.n}` } }); break
    case 'marker': {
      const r = a.dispatch('add_marker', { t_us: op.at })
      if (r.ok && op.attach !== null && layers.length > 0) a.dispatch('attach_marker', { marker: r.value as Uuid, layer: pick(op.attach) })
      break
    }
    case 'group': a.dispatch('groups_create', { layers: [pick(op.n)], label: null }); break
  }
}

describe('diffProjects — properties', () => {
  it('diff(p, p) and diff(clone(p), p) are empty over generated projects', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 20 }), (ops) => {
      const { a } = setup()
      for (const op of ops) apply(a, op)
      const p = a.snapshot()
      return diffProjects(p, p).length === 0 && diffProjects(structuredClone(p), p).length === 0
    }), { seed: PBT_SEED, numRuns: Math.min(PBT_RUNS, 100) })
  })

  it('an edit followed by undo yields no changes, and touched keys agree with the diff', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 12 }), opArb, (prefix, op) => {
      const { a } = setup()
      for (const o of prefix) apply(a, o)
      const before = a.snapshot()
      const len = a.historyStatus().len
      apply(a, op)
      const after = a.snapshot()
      const diffKeys = new Set(diffProjects(before, after).flatMap((c) => c.keys))
      const touched = touchedEntityKeys(before, after)
      if (diffKeys.size !== touched.size || [...diffKeys].some((k) => !touched.has(k))) return false
      if (a.historyStatus().len > len) ok(a.dispatch('undo', {}))
      // Value equality, not identity: compare against a deep copy of the start.
      return diffProjects(structuredClone(before), a.snapshot()).length === 0
    }), { seed: PBT_SEED, numRuns: Math.min(PBT_RUNS, 100) })
  })

  it('skipping the compositions both sides share by reference changes no result', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 12 }), fc.array(opArb, { minLength: 1, maxLength: 4 }), (prefix, edits) => {
      const { a } = setup()
      for (const o of prefix) apply(a, o)
      const before = a.snapshot()
      for (const o of edits) apply(a, o)
      const after = a.snapshot()
      // A deep copy shares nothing, so it takes the full walk.
      expect(diffProjects(before, after)).toEqual(diffProjects(structuredClone(before), after))
      const approved = new Map([...touchedEntityKeys(before, after)].slice(0, 1).map((k) => [k, extractEntities(after).get(k) ?? ABSENT] as const))
      expect(diffProjects({ base: before, approved }, after)).toEqual(diffProjects({ base: structuredClone(before), approved }, after))
    }), { seed: PBT_SEED, numRuns: Math.min(PBT_RUNS, 100) })
  })

  it('every aspect of every change is said by a detail, and no fact is zero', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 12 }), fc.array(opArb, { minLength: 1, maxLength: 4 }), (prefix, edits) => {
      const { a } = setup()
      for (const o of prefix) apply(a, o)
      const before = a.snapshot()
      for (const o of edits) apply(a, o)
      const cs = diffProjects(before, a.snapshot())
      const ids = new Set(cs.map((c) => c.id))
      // A carrier is in the list, carried changes and riders alike; only a
      // carried change has no details of its own beyond its shift.
      return cs.every((c) => detailsCover(c) && (c.carried_by === undefined || (ids.has(c.carried_by) && c.carried_by !== c.id))
        && (c.carried_us === undefined || (c.carried === undefined && c.carried_by !== undefined && !c.details.some((d) => d.type === 'shift'))))
    }), { seed: PBT_SEED, numRuns: Math.min(PBT_RUNS, 100) })
  })
})
