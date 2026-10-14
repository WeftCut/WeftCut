// apps/desktop/src/main/state/reviewDiff.test.ts
// diffProjects: entity-level review diff, its projection and Group propagation
// (spec .scratch/agent-review/spec.md Part B — Diff; ADR 0115).
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createActor, type ActorHandle } from './actor'
import { seededGen } from './ids'
import { blankProject, type Project, type Uuid } from './model'
import { root } from './__tests__/fixtures/project'
import { PBT_RUNS, PBT_SEED } from './__tests__/pbt/harness'
import {
  ABSENT, diffProjects, entityKey, extractEntities, groupDecorations, mergeRanges, parseEntityKey, touchedEntityKeys,
  type Change, type EntityKey, type EntityValue,
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
    const x = color(a, tA, 0, S)
    const y = color(a, tB, 3 * S, 4 * S)
    const z = color(a, tA, 6 * S, 7 * S)
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { layers: [x, y, z], delta_us: S }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c).toMatchObject({ class: 'modified', kind: 'Layer', delta_us: S, aspects: ['timing'] })
    // Moved on purpose, with nothing it was carried by.
    expect(c.carried).toBeUndefined()
    expect(c.keys).toEqual([L(x), L(y), L(z)].sort())
    expect(c.ranges.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[S, 2 * S], [4 * S, 5 * S], [7 * S, 8 * S]])
  })

  it('an anchored marker rides its shifted layer into the same group; a free marker moved is a timing modification', () => {
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
    ok(a.dispatch('update_marker', { marker: free, patch: { t_us: 6 * S } }))
    expect(only(diffProjects(mid, a.snapshot()))).toMatchObject({ class: 'modified', kind: 'Marker', aspects: ['timing'] })
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
    // A gap closed with nothing removed: nothing to be carried by.
    const mid = a.snapshot()
    ok(a.dispatch('shift_layers', { from_t_us: 4 * S, tracks: null, delta_us: -S }))
    expect(carried(diffProjects(mid, a.snapshot()))).toEqual([[-S, false]])
    void head
  })

  it('a translation that left a neighbour behind on its track is a deliberate move, seam or not', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const lifted = color(a, tA, S, 2 * S)
    const next = color(a, tA, 2 * S, 3 * S)
    color(a, tA, 5 * S, 6 * S)
    const before = a.snapshot()
    // Lifted, then only the next clip pulled into the hole: it starts at the
    // seam, but the clip after it stayed where it was.
    ok(a.dispatch('delete_layers', { layers: [lifted] }))
    ok(a.dispatch('shift_layers', { layers: [next], delta_us: -S }))
    const shift = diffProjects(before, a.snapshot()).find((c) => c.delta_us !== undefined)!
    expect(shift.carried).toBeUndefined()
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
})
