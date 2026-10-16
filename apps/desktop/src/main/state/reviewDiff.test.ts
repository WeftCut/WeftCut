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
import { diffProjects, locateChanges, groupDecorations } from './reviewDiff'
import { mediaLabel } from './summary'
import { ABSENT, entityKey, extractEntities, touchedEntityKeys, type EntityValue } from './reviewEntities'
import { changeKind, parseEntityKey, type Change, type ChangeDetail, type EntityKey } from '../../shared/review'

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

/** The kinds of fact a change is told by, in order. */
const says = (c: Change): Array<ChangeDetail['type']> => c.details.map((d) => d.type)
/** A modification says at least one fact — the renderer words nothing else —
 *  and no fact is a zero. */
function detailsCover(c: Change): boolean {
  const told = c.class !== 'modified' || c.details.length > 0
  const nonzero = c.details.every((d) => !('delta_us' in d) || d.delta_us !== 0)
  return told && nonzero
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
    expect(added).toMatchObject({ id: L(id), class: 'added', details: [{ type: 'length', duration_us: S }], ranges: [{ composition_id: before.root_id, track_id: tA, t_start_us: 2 * S, t_end_us: 3 * S }] })
    const mid = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [id] }))
    expect(only(diffProjects(mid, a.snapshot()))).toMatchObject({ id: L(id), class: 'removed', ranges: [], before_ranges: [{ composition_id: before.root_id, track_id: tA, t_start_us: 2 * S, t_end_us: 3 * S }] })
  })

  it('modified says what differs: label, flags, params, keyframes, effects', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const id = video(a, tA, 0, S)
    const cases: Array<[() => void, Array<ChangeDetail['type']>]> = [
      [() => ok(a.dispatch('update_layer', { layer: id, patch: { label: 'Intro' } })), ['label']],
      [() => ok(a.dispatch('set_layers_enabled', { layers: [id], enabled: false })), ['enabled']],
      [() => ok(a.dispatch('update_layer_param_track', { layer: id, param_key: 'opacity', track: { mode: 'Static', value: 0.5 } })), ['params']],
      [() => ok(a.dispatch('update_layer_param_track', { layer: id, param_key: 'opacity', track: keyframed(0.2) })), ['keyframes']],
      [() => ok(a.dispatch('add_effect', { layer: id, kind: 'blur' })), ['effect']],
    ]
    for (const [edit, types] of cases) {
      const before = a.snapshot()
      edit()
      const c = only(diffProjects(before, a.snapshot()))
      expect(c).toMatchObject({ class: 'modified', id: L(id) })
      expect(says(c)).toEqual(types)
    }
  })

  it('a trim says its times and the cut; a retime says its speed', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const v = video(a, tA, 0, 4 * S)
    const before = a.snapshot()
    ok(a.dispatch('trim_layer', { layer: v, edge: 'end', new_t_us: 3 * S, escape_link: false }))
    const trim = only(diffProjects(before, a.snapshot()))
    // Where the clip is now — not where it was as well, which is baseline time.
    const now = root(a.snapshot()).tracks[0].layers.find((l) => l.id === v)!
    expect(trim).toMatchObject({ class: 'modified', ranges: [{ t_start_us: now.t_start_us, t_end_us: now.t_end_us }] })
    expect(says(trim)).toContain('trim')
    expect(says(trim).every((t) => t === 'time' || t === 'trim')).toBe(true)
    expect(now.t_end_us - now.t_start_us).toBe(S)
    const mid = a.snapshot()
    ok(a.dispatch('retime_layers', { layers: [v], target: { kind: 'Rate', value: { num: 2, den: 1 } } }))
    expect(says(only(diffProjects(mid, a.snapshot())))).toContain('speed')
  })

  it('a move to another track says the track first, with the footprint on each side on its track', () => {
    const { a, tA, tB } = setup()
    const id = color(a, tA, 0, S)
    const before = a.snapshot()
    ok(a.dispatch('move_layer', { layer: id, to_track: tB, t_start_us: S, escape_link: false }))
    const c = only(diffProjects(before, a.snapshot()))
    expect(c).toMatchObject({ class: 'modified', ranges: [{ track_id: tB, t_start_us: S, t_end_us: 2 * S }], before_ranges: [{ track_id: tA, t_start_us: 0, t_end_us: S }] })
    expect(c.details[0]).toEqual({ type: 'track', from: tA, to: tB })
    expect(says(c).slice(1).every((t) => t === 'time')).toBe(true)
  })

  it('same-delta translations remain independent entity changes; a marker riding its clip is not one', () => {
    const { a, tA, tB } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const x = video(a, tA, 0, S), y = color(a, tB, 3 * S, 4 * S)
    const m = ok(a.dispatch('add_marker', { t_us: S / 2 })) as Uuid
    ok(a.dispatch('attach_marker', { marker: m, layer: x }))
    const before = a.snapshot()
    ok(a.dispatch('shift_layers', { layers: [x, y], delta_us: S }))
    const cs = diffProjects(before, a.snapshot())
    // The marker's anchor — its truth — is unchanged; only its cached time followed the clip.
    expect(root(a.snapshot()).markers[0]!.t_us).toBe(1.5 * S)
    expect(new Set(cs.map(c => c.id))).toEqual(new Set([L(x), L(y)]))
    expect(cs.find(c => c.id === L(x))!.details).toEqual([
      { type: 'time', field: 'start', from_us: 0, to_us: S },
      { type: 'time', field: 'end', from_us: S, to_us: 2 * S },
    ])
  })

  it('an anchored marker moved within its clip is timing; tying and untying are placement', () => {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const x = video(a, tA, 0, 4 * S), y = video(a, tA, 5 * S, 9 * S)
    const m = ok(a.dispatch('add_marker', { t_us: S })) as Uuid
    const M = entityKey('Marker', m)
    ok(a.dispatch('attach_marker', { marker: m, layer: x }))
    const tied = a.snapshot()
    ok(a.dispatch('update_marker', { marker: m, patch: { t_us: 3 * S } }))
    const moved = only(diffProjects(tied, a.snapshot()))
    expect(moved).toMatchObject({ id: M, details: [{ type: 'time', field: 'start', from_us: S, to_us: 3 * S }] })
    // Moved within its clip while the clip moved too: the marker's own instant changed, and its times say where it went.
    ok(a.dispatch('shift_layers', { layers: [x], delta_us: S / 2 }))
    expect(only(diffProjects(tied, a.snapshot()).filter(c => c.id === M)).details).toEqual([{ type: 'time', field: 'start', from_us: S, to_us: 3.5 * S }])
    const free = structuredClone(tied)
    root(free).markers[0]!.anchor = null
    expect(only(diffProjects(free, tied))).toMatchObject({ id: M, details: [{ type: 'aspect', aspect: 'placement' }] })
    const other = structuredClone(tied)
    root(other).markers[0]!.anchor!.layer = y
    expect(only(diffProjects(other, tied).filter(c => c.id === M)).details).toEqual([{ type: 'aspect', aspect: 'placement' }])
  })

  it('ripple deletion reports all changed entities and never relocates the removal', () => {
    const { a, tA, tB } = setup()
    const gone = color(a, tA, S, 2 * S)
    const tail = color(a, tA, 2 * S, 3 * S), other = color(a, tB, 4 * S, 5 * S)
    const before = a.snapshot()
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }))
    const cs = diffProjects(before, a.snapshot())
    expect(new Set(cs.map(c => c.id))).toEqual(new Set([L(gone), L(tail), L(other)]))
    expect(cs.find(c => c.id === L(gone))).toMatchObject({ ranges: [], before_ranges: [{ track_id: tA, t_start_us: S, t_end_us: 2 * S }] })
    expect(cs.find(c => c.id === L(tail))!.details).toEqual([
      { type: 'time', field: 'start', from_us: 2 * S, to_us: S },
      { type: 'time', field: 'end', from_us: 3 * S, to_us: 2 * S },
    ])
  })

  it('a removed entity carries its own baseline name: label, media, marker label; none for an unnamed clip', () => {
    const { a, tA, tB } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const clip = video(a, tA, 0, S), titled = color(a, tB, 0, S), plain = color(a, tB, 2 * S, 3 * S)
    ok(a.dispatch('update_layer', { layer: titled, patch: { label: '  Title card ' } }))
    const m = ok(a.dispatch('add_marker', { t_us: S, label: 'Beat' })) as Uuid
    const before = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [clip, titled, plain] }))
    ok(a.dispatch('remove_marker', { marker: m }))
    const cs = diffProjects(before, a.snapshot())
    const name = (id: EntityKey) => cs.find(c => c.id === id)!.before_name
    expect(name(L(clip))).toBe(mediaLabel(before.media_pool[AV]!))
    expect(name(L(titled))).toBe('Title card')
    expect(name(L(plain))).toBeUndefined()
    expect(name(entityKey('Marker', m))).toBe('Beat')
  })

  it('a point marker moved says its time, no end', () => {
    const { a } = setup()
    const m = ok(a.dispatch('add_marker', { t_us: S })) as Uuid
    const before = a.snapshot()
    ok(a.dispatch('update_marker', { marker: m, patch: { t_us: 2 * S } }))
    expect(only(diffProjects(before, a.snapshot())).details).toEqual([{ type: 'time', field: 'start', from_us: S, to_us: 2 * S }])
  })

  it('listed-only changes have no ranges: track label, link, composition label', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    const y = color(a, tB, 0, S)
    const before = a.snapshot()
    ok(a.dispatch('rename_track', { track: tA, label: 'Dialogue' }))
    const link = ok(a.dispatch('links_create', { layers: [x, y] })) as Uuid
    const cs = diffProjects(before, a.snapshot())
    expect(cs.map((c) => [c.class, changeKind(c), c.ranges])).toEqual([['added', 'Link', []], ['modified', 'Track', []]])
    expect(cs[0].id).toEqual(entityKey('Link', link))
    expect(cs[1].details).toEqual([{ type: 'label' }])
  })
})

describe('diffProjects — direct timing facts', () => {
  function source() {
    const { a, tA } = setup()
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    const id = video(a, tA, 2 * S, 6 * S)
    return { a, id, before: a.snapshot() }
  }
  it('reports every changed edge and measures its own source trim even after a move', () => {
    const { id, before } = source()
    const after = editLayer(before, id, l => window(l, S, 4 * S, S, 4 * S))
    expect(detailsOf(before, after, id)).toEqual([
      { type: 'time', field: 'start', from_us: 2 * S, to_us: S },
      { type: 'time', field: 'end', from_us: 6 * S, to_us: 4 * S },
      { type: 'time', field: 'source_start', from_us: 0, to_us: S },
      { type: 'trim', side: 'start', delta_us: -S },
    ])
  })
  it('measures both trim edges and extensions without changing entity membership', () => {
    const { a, tA } = setup()
    const id = color(a, tA, 0, 4 * S)
    const before = a.snapshot()
    const after = editLayer(before, id, l => { l.t_start_us = S; l.t_end_us = 3 * S })
    expect(only(diffProjects(before, after))).toMatchObject({ id: L(id), details: [
      { type: 'time', field: 'start', from_us: 0, to_us: S },
      { type: 'time', field: 'end', from_us: 4 * S, to_us: 3 * S },
      { type: 'trim', side: 'start', delta_us: -S },
      { type: 'trim', side: 'end', delta_us: -S },
    ] })
    expect(detailsOf(after, before, id).filter(d => d.type === 'trim')).toEqual([
      { type: 'trim', side: 'start', delta_us: S },
      { type: 'trim', side: 'end', delta_us: S },
    ])
  })
  it('converts source trim amounts at the clip rate and excludes source replacement', () => {
    const { id, before } = source()
    const fast = editLayer(before, id, l => {
      window(l, 2 * S, 4 * S, 0, 4 * S)
      Object.assign(l.params, { time_map: { kind: 'Affine', rate: { num: 2, den: 1 } } })
    })
    const trimmed = editLayer(fast, id, l => window(l, 2 * S, 3 * S, 0, 2 * S))
    expect(detailsOf(fast, trimmed, id).filter(d => d.type === 'trim')).toEqual([
      { type: 'trim', side: 'end', delta_us: -S },
    ])
    const replaced = editLayer(trimmed, id, l => Object.assign(l.params, { media: 'replacement' }))
    expect(detailsOf(fast, replaced, id).some(d => d.type === 'trim')).toBe(false)
  })
  it('reports source-only changes and retime duration directly', () => {
    const { a, id, before } = source()
    expect(detailsOf(before, editLayer(before, id, l => window(l, 2 * S, 6 * S, S, 5 * S)), id)).toEqual([
      { type: 'time', field: 'source_start', from_us: 0, to_us: S },
      { type: 'time', field: 'source_end', from_us: 4 * S, to_us: 5 * S },
    ])
    ok(a.dispatch('retime_layers', { layers: [id], target: { kind: 'Rate', value: { num: 2, den: 1 } } }))
    expect(detailsOf(before, a.snapshot(), id)).toEqual([
      { type: 'time', field: 'end', from_us: 6 * S, to_us: 4 * S },
      { type: 'speed', from: 1, to: 2 },
    ])
  })
  it('neighbour changes cannot change an entity diff', () => {
    const { a, tA, tB } = setup()
    const gone = color(a, tA, 0, S), id = color(a, tB, 2 * S, 5 * S)
    const before = a.snapshot()
    const after = editLayer(before, id, l => { l.t_start_us += S; l.t_end_us += S })
    const unrelated = structuredClone(after)
    root(unrelated).tracks[0].layers = root(unrelated).tracks[0].layers.filter(l => l.id !== gone)
    expect(diffProjects(before, unrelated).find(c => c.id === L(id))).toEqual(only(diffProjects(before, after)))
  })
  it('activity locations follow surviving identities and retain historical footprints unchanged', () => {
    const { a, tA, tB } = setup()
    const gone = color(a, tA, 0, S), id = color(a, tB, 2 * S, 3 * S)
    const before = a.snapshot()
    ok(a.dispatch('delete_layers', { layers: [gone] }))
    ok(a.dispatch('shift_layers', { layers: [id], delta_us: S }))
    const changes = diffProjects(before, a.snapshot())
    ok(a.dispatch('move_layer', { layer: id, to_track: tA, t_start_us: 8 * S, escape_link: false }))
    const located = locateChanges(changes, a.snapshot())
    expect(located.find(c => c.id === L(gone))).toEqual(changes.find(c => c.id === L(gone)))
    expect(located.find(c => c.id === L(id))).toMatchObject({ ranges: [{ t_start_us: 8 * S, t_end_us: 9 * S }], before_ranges: [{ track_id: tB, t_start_us: 2 * S, t_end_us: 3 * S }] })
    ok(a.dispatch('delete_layers', { layers: [id] }))
    expect(locateChanges(changes, a.snapshot()).every(c => c.ranges.length === 0)).toBe(true)
  })
  it('params and keyframes by wire key, effects per instance, label and flags with their value', () => {
    const { a, id: v } = source()
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


})

describe('diffProjects — track order', () => {
  it('a track reorder is a listed-only placement change of the composition; adding a track is not', () => {
    const { a, tA } = setup()
    const before = a.snapshot()
    ok(a.dispatch('move_track', { track: tA, new_position: 1 }))
    const after = a.snapshot()
    const c = only(diffProjects(before, after))
    expect(c).toMatchObject({ class: 'modified', id: entityKey('Composition', before.root_id), details: [{ type: 'aspect', aspect: 'placement' }], ranges: [] })
    expect([...touchedEntityKeys(before, after)]).toEqual([entityKey('Composition', before.root_id)])
    const mid = a.snapshot()
    const t = ok(a.dispatch('add_track', {})) as Uuid
    const added = diffProjects(mid, a.snapshot())
    expect(added.map((x) => [x.class, x.id])).toEqual([['added', entityKey('Track', t)]])
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
    const comp = cs.find((c) => changeKind(c) === 'Composition')!
    expect(comp.class).toBe('added')
    expect(comp.id).toEqual(entityKey('Composition', composition_id))
    expect(cs.filter((c) => changeKind(c) === 'Track').map(c => c.id).sort()).toEqual(after.compositions[composition_id].tracks.map(t => entityKey('Track', t.id)).sort())
    const moved = cs.find((c) => c.id === L(v))!
    expect(moved).toMatchObject({ class: 'modified', before_ranges: [{ composition_id: before.root_id, track_id: tA }] })
    expect(moved.details[0]).toEqual({ type: 'composition', from: before.root_id, to: composition_id })
    expect(new Set(moved.ranges.map((r) => r.composition_id))).toEqual(new Set([composition_id]))
    expect(cs.find((c) => c.id === L(layer_id))).toMatchObject({ class: 'added' })
    // Its badge counts the clip moved in, not the tracks it was created with:
    // they have no place on its timeline.
    expect(groupDecorations(cs, after).map((d) => [d.layer_id, d.change_ids])).toEqual([[layer_id, [L(v)]]])
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
    expect(cs.map(changeKind).sort()).toEqual(['Composition', 'Layer'])
    const decos = groupDecorations(cs, after)
    expect(decos.map((d) => [d.layer_id, d.composition_id, d.change_ids])).toEqual(expect.arrayContaining([
      [group, outer.composition_id, [L(v)]],
      [outer.layer_id, after.root_id, [L(v)]],
    ]))
    expect(decos).toHaveLength(2)
  })

  it('moving across compositions compares no timeline times — two clocks — only the move', () => {
    const { a, v, inside } = grouped()
    const before = a.snapshot()
    ok(a.dispatch('move_layers_to_composition', { layers: [v], to_composition: before.root_id, anchor_layer: v, anchor_t_start_us: 8 * S }))
    const c = only(diffProjects(before, a.snapshot()).filter((x) => x.id === L(v)))
    expect(c.details).toEqual([{ type: 'composition', from: inside, to: before.root_id }])
  })

  it('a move out of a Group yields a range in each composition', () => {
    const { a, tA, v, inside } = grouped()
    const before = a.snapshot()
    ok(a.dispatch('move_layers_to_composition', { layers: [v], to_composition: before.root_id, anchor_layer: v, anchor_t_start_us: 8 * S, to_track: tA }))
    const c = only(diffProjects(before, a.snapshot()).filter((x) => x.id === L(v)))
    expect(c.class).toBe('modified')
    expect(c.ranges.map(r => r.composition_id)).toEqual([before.root_id])
    expect(c.before_ranges?.map(r => r.composition_id)).toEqual([inside])
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
    expect(only(diffProjects({ base, approved }, a.snapshot()))).toMatchObject({ id: L(x), class: 'modified', details: [{ type: 'label' }] })
  })

  it('an approved value inside a composition both sides share still differs from it', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    const first = a.snapshot()
    ok(a.dispatch('update_layer', { layer: x, patch: { label: 'approved' } }))
    const approved = new Map<EntityKey, EntityValue | typeof ABSENT>([[L(x), extractEntities(a.snapshot()).get(L(x))!]])
    // Undone back to `first`: the base and current root are one object.
    expect(only(diffProjects({ base: first, approved }, first))).toMatchObject({ id: L(x), class: 'modified', details: [{ type: 'label' }] })
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
      const diffKeys = new Set(diffProjects(before, after).map((c) => c.id))
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
      return ids.size === cs.length && cs.every(detailsCover)
    }), { seed: PBT_SEED, numRuns: Math.min(PBT_RUNS, 100) })
  })
})
