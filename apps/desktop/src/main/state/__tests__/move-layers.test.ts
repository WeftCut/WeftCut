// apps/desktop/src/main/state/__tests__/move-layers.test.ts
// `move_layers` (spec ticket 09): one move for a named set — a time, a lane,
// a fresh lane, or the ripple move that closes the span behind and opens room
// at the landing. Beside it, the layer-edit vocabulary the same ticket
// settles: `set_layer_flags`, `rename_layer`, `paste_layers { unique }`, the
// retime answer's partners, the slip and `move_track`'s refusals.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

const AV = '00000000-0000-0000-0000-0000000000ab'
const S = 1_000_000

function setup() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'move'), idGen: gen, clock: () => '<TS>' })
  a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: true })
  const [tA, tB] = root(a.snapshot()).tracks.map((t) => t.id)
  return { a, tA: tA!, tB: tB! }
}
const idOf = (r: ReturnType<ActorHandle['dispatch']>): string => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value as string }
const where = (a: ActorHandle, id: string, compId?: string): { track: string; span: [number, number] } => {
  const c = compId ? a.snapshot().compositions[compId]! : root(a.snapshot())
  for (const t of c.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return { track: t.id, span: [l.t_start_us, l.t_end_us] } }
  throw new Error(`no layer ${id}`)
}
const span = (a: ActorHandle, id: string) => where(a, id).span
const color = (a: ActorHandle, track: string, s: number, e: number) => idOf(a.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e }))
const video = (a: ActorHandle, track: string, s: number, e: number, src = 0) => idOf(a.dispatch('add_layer', { track, kind: 'video', media: AV, src_in_us: src, src_out_us: src + e - s, t_start_us: s, t_end_us: e }))
const audio = (a: ActorHandle, track: string, s: number, e: number, src = 0) => idOf(a.dispatch('add_layer', { track, kind: 'audio', media: AV, src_in_us: src, src_out_us: src + e - s, t_start_us: s, t_end_us: e }))
const call = (a: ActorHandle, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const ok = (r: ReturnType<ActorHandle['mcpCall']>): Record<string, unknown> => {
  if (!r.ok) throw new Error(r.error.message)
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>
}
const refused = (r: ReturnType<ActorHandle['mcpCall']>) => { if (r.ok) throw new Error('expected a refusal'); return r.error }
type Rec = { layer_id: string; track_id: string; t_start_us: number; t_end_us: number; adjusted: unknown[] }

describe('move_layers: time and lane', () => {
  it('moves the seed and its link partner by one delta, in one history entry; an unlinked layer stays', () => {
    const { a, tA, tB } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const title = color(a, tB, 0, S)
    const len = a.historyStatus().len
    const rec = ok(call(a, 'move_layers', { layer_ids: [v], t_start_us: S }))
    expect(span(a, v)).toEqual([S, 3 * S])
    expect(span(a, au)).toEqual([S, 3 * S])
    expect(span(a, title)).toEqual([0, S])
    expect(a.historyStatus().len).toBe(len + 1)
    expect((rec.layers as Rec[]).map((l) => l.layer_id)).toEqual([v, au])
    expect(rec.rippled).toEqual([])
    a.dispatch('undo', {})
    expect(span(a, v)).toEqual([0, 2 * S])
  })

  it('delta_us and escape_link: only the named layer moves', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    ok(call(a, 'move_layers', { layer_ids: [v], delta_us: S, escape_link: true }))
    expect(span(a, v)).toEqual([S, 3 * S])
    expect(span(a, au)).toEqual([0, 2 * S])
  })

  it('track_id moves only the seed; the other members keep their own lanes', () => {
    const { a, tA, tB } = setup()
    const one = color(a, tA, 0, S)
    const two = color(a, tB, S, 2 * S)
    const dest = idOf(a.dispatch('add_track', {}))
    ok(call(a, 'move_layers', { layer_ids: [one, two], delta_us: 3 * S, track_id: dest }))
    expect(where(a, one)).toEqual({ track: dest, span: [3 * S, 4 * S] })
    expect(where(a, two)).toEqual({ track: tB, span: [4 * S, 5 * S] })
  })

  it('"spawn" lifts an Audio layer onto a fresh track, keeping its span and link (the old separate-audio)', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    const link = idOf(a.dispatch('links_create', { layers: [v, au] }))
    const tracks = root(a.snapshot()).tracks.length
    const rec = ok(call(a, 'move_layers', { layer_ids: [au], track_id: 'spawn' }))
    const track = rec.track as { track_id: string }
    expect(root(a.snapshot()).tracks).toHaveLength(tracks + 1)
    expect(where(a, au)).toEqual({ track: track.track_id, span: [0, 2 * S] })
    expect(where(a, v)).toEqual({ track: tA, span: [0, 2 * S] })
    expect([...root(a.snapshot()).links.find((l) => l.id === link)!.members].sort()).toEqual([v, au].sort())
  })

  it('refuses what it cannot honour, and moves nothing', () => {
    const { a, tA } = setup()
    const first = color(a, tA, 0, 2 * S)
    const second = color(a, tA, 2 * S, 4 * S)
    const before = JSON.stringify(a.snapshot())
    // Occupied landing → the validator's LayerOverlap, naming the blocker.
    expect(refused(call(a, 'move_layers', { layer_ids: [second], delta_us: -S })).message).toContain(first)
    // Before 0 → NegativeLayerStart, never clamped.
    expect(refused(call(a, 'move_layers', { layer_ids: [first], delta_us: -S })).data).toMatchObject({ error: 'NegativeLayerStart', layer: first })
    // Already there → refused, not a success that changed nothing.
    expect(refused(call(a, 'move_layers', { layer_ids: [first], t_start_us: 0 })).message).toContain('nothing would move')
    // A locked layer refuses.
    ok(call(a, 'set_layer_flags', { layer_ids: [first], locked: true }))
    expect(refused(call(a, 'move_layers', { layer_ids: [first], delta_us: 5 * S })).data).toMatchObject({ error: 'LayerLocked', layer: first })
    ok(call(a, 'set_layer_flags', { layer_ids: [first], locked: false }))
    expect(JSON.stringify(a.snapshot())).toBe(before)
  })
})

describe('an edit the grid settles back where it was records nothing', () => {
  // A 1 µs delta on a 30 fps grid passes every "was anything asked for" check
  // and then rounds home. The recipes lift each layer and reinsert it, so the
  // draft is dirty while the project is the same.
  it('move_layers refuses it by the field that asked, for the seed and for the whole set', () => {
    const { a, tA, tB } = setup()
    const one = color(a, tA, S, 2 * S)
    const two = color(a, tB, 3 * S, 4 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    for (const args of [{ layer_ids: [one], delta_us: 1 }, { layer_ids: [one, two], delta_us: -1 }]) {
      const r = refused(call(a, 'move_layers', args))
      expect(r.message).toMatch(/^delta_us: .*nothing would move/)
      expect(r.data).toMatchObject({ error: 'InvalidArgument' })
    }
    expect(refused(call(a, 'move_layers', { layer_ids: [one], t_start_us: S + 1 })).message).toMatch(/^t_start_us: /)
    expect(refused(call(a, 'move_layers', { layer_ids: [one], track_id: tA })).message).toMatch(/^track_id: /)
    expect(a.historyStatus().len).toBe(len)
    expect(a.snapshot()).toBe(before)
  })

  it('move_layers still records when only a partner on a finer grid moves, or only the lane changes', () => {
    const { a, tA, tB } = setup()
    const v = video(a, tA, S, 2 * S)
    const au = audio(a, tA, S, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const len = a.historyStatus().len
    ok(call(a, 'move_layers', { layer_ids: [v], delta_us: 1000 }))
    expect(span(a, v)).toEqual([S, 2 * S])
    expect(span(a, au)[0]).toBeGreaterThan(S)
    expect(a.historyStatus().len).toBe(len + 1)
    const lone = color(a, tA, 5 * S, 6 * S)
    ok(call(a, 'move_layers', { layer_ids: [lone], delta_us: 1, track_id: tB }))
    expect(where(a, lone)).toEqual({ track: tB, span: [5 * S, 6 * S] })
    expect(a.historyStatus().len).toBe(len + 3)
  })

  it('shift_layers refuses a sweep that rounds home, in either direction', () => {
    const { a, tA } = setup()
    const one = color(a, tA, S, 2 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    for (const delta_us of [1, -1]) {
      const r = refused(call(a, 'shift_layers', { t_from_us: S, delta_us }))
      expect(r.message).toMatch(/^delta_us: .*would move nothing/)
      expect(r.data).toMatchObject({ error: 'InvalidArgument' })
    }
    expect(a.historyStatus().len).toBe(len)
    expect(a.snapshot()).toBe(before)
    expect(span(a, one)).toEqual([S, 2 * S])
  })

  it('the timeline\'s own moves answer ok and spend no history entry and no op id', () => {
    const { a, tA } = setup()
    const one = color(a, tA, S, 2 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    expect(a.dispatch('move_layer', { layer: one, to_track: tA, t_start_us: S }).ok).toBe(true)
    expect(a.dispatch('move_layer', { layer: one, to_track: tA, t_start_us: S + 1 }).ok).toBe(true)
    expect(a.dispatch('move_layers', { placements: [{ layerId: one, trackId: tA }], anchor_layer_id: one, t_start_us: S }).ok).toBe(true)
    expect(a.dispatch('shift_layers', { from_t_us: S, delta_us: 1 }).ok).toBe(true)
    expect(a.historyStatus().len).toBe(len)
    expect(a.snapshot()).toBe(before)
  })
})

describe('move_layers { insert: true }: the ripple move', () => {
  // L3: "move the part after 1:30 to the start" — split, then one move.
  it('moves the tail of a linked A/V clip to the start in one edit: the head shifts right, the span behind closes', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 10 * S)
    const au = audio(a, tA, 0, 10 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const split = ok(call(a, 'split_layer', { layer_id: v, t_cut_us: [6 * S] }))
    const [, tailV] = split.layer_ids as string[]
    const tailA = (split.siblings as Array<{ segments: string[] }>)[0]!.segments[1]!
    const len = a.historyStatus().len
    const rec = ok(call(a, 'move_layers', { layer_ids: [tailV!, tailA], t_start_us: 0, insert: true }))
    expect(span(a, tailV!)).toEqual([0, 4 * S])
    expect(span(a, tailA)).toEqual([0, 4 * S])
    expect(span(a, v)).toEqual([4 * S, 10 * S])
    expect(span(a, au)).toEqual([4 * S, 10 * S])
    expect((rec.rippled as Rec[]).map((r) => r.layer_id).sort()).toEqual([v, au].sort())
    expect(a.historyStatus().len).toBe(len + 1)
    expect(root(a.snapshot()).duration_us).toBe(10 * S)
  })

  it('a later landing is read on the closed timeline: the seed starts at t_start_us afterwards', () => {
    const { a, tA } = setup()
    const one = color(a, tA, 0, 2 * S)
    const two = color(a, tA, 2 * S, 4 * S)
    const three = color(a, tA, 4 * S, 6 * S)
    ok(call(a, 'move_layers', { layer_ids: [one], t_start_us: 4 * S, insert: true }))
    expect(span(a, two)).toEqual([0, 2 * S])
    expect(span(a, three)).toEqual([2 * S, 4 * S])
    expect(span(a, one)).toEqual([4 * S, 6 * S])
  })

  it('refuses like a ripple delete: a layer starting inside the span behind is named', () => {
    const { a, tA, tB } = setup()
    const clip = color(a, tA, 2 * S, 4 * S)
    color(a, tA, 4 * S, 6 * S)
    const title = color(a, tB, 3 * S, 3_500_000)
    const e = refused(call(a, 'move_layers', { layer_ids: [clip], t_start_us: 0, insert: true }))
    expect(e.data).toMatchObject({ error: 'RippleInsideHole', layer: title, tool: 'move_layers' })
    expect(e.message).toContain(`add ${title} to layer_ids`)
    expect(span(a, clip)).toEqual([2 * S, 4 * S])
  })
})

describe('move_layers refuses by name and leaves the project alone', () => {
  const lockTrack = (a: ActorHandle, track: string) => ok(call(a, 'set_track_flags', { track_id: track, locked: true }))

  it('an unknown or locked destination; its own locked lane; a lane in another composition', () => {
    const { a, tA, tB } = setup()
    const one = color(a, tA, 0, S)
    const before = a.snapshot()
    const unknown = '00000000-0000-0000-0000-00000000dead'
    expect(refused(call(a, 'move_layers', { layer_ids: [one], track_id: unknown })).data).toMatchObject({ error: 'TrackNotFound' })
    lockTrack(a, tB)
    expect(refused(call(a, 'move_layers', { layer_ids: [one], track_id: tB })).message).toContain(tB)
    expect(root(a.snapshot()).tracks.find((t) => t.id === tA)!.layers.map((l) => l.id)).toEqual([one])
    lockTrack(a, tA)
    expect(refused(call(a, 'move_layers', { layer_ids: [one], delta_us: S })).message).toContain(tA)
    expect(before.compositions[root(before).id].tracks[0].layers).toEqual(root(a.snapshot()).tracks[0].layers)
  })

  it('a locked partner the call did not name is named, and escape_link steps around it', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, S)
    const au = audio(a, tA, 0, S)
    const link = idOf(a.dispatch('links_create', { layers: [v, au] }))
    ok(call(a, 'set_layer_flags', { layer_ids: [au], locked: true }))
    expect(refused(call(a, 'move_layers', { layer_ids: [v], delta_us: S })).data).toMatchObject({ error: 'LinkLockedMember', link, locked_layer: au, touched: v })
    expect(span(a, v)).toEqual([0, S])
    ok(call(a, 'move_layers', { layer_ids: [v], delta_us: S, escape_link: true }))
    expect(span(a, v)).toEqual([S, 2 * S])
    expect(span(a, au)).toEqual([0, S])
  })

  it('names the earliest member, not the seed, when the set would cross 0', () => {
    const { a, tA, tB } = setup()
    const seed = color(a, tA, 2 * S, 3 * S)
    const earliest = color(a, tB, S, 2 * S)
    const later = color(a, tB, 4 * S, 5 * S)
    expect(refused(call(a, 'move_layers', { layer_ids: [seed, later, earliest], delta_us: -2 * S })).data).toMatchObject({ error: 'NegativeLayerStart', layer: earliest, requested_us: -S })
  })
})

describe('move_layers settles the timeline around the move', () => {
  it('a lane change takes the emptied lane with it and fits the duration, in one undo', () => {
    const { a } = setup()
    const extra = idOf(a.dispatch('add_track', {}))
    const dest = idOf(a.dispatch('add_track', {}))
    const one = color(a, extra, 0, S)
    ok(call(a, 'move_layers', { layer_ids: [one], track_id: dest, t_start_us: 7 * S }))
    const c = root(a.snapshot())
    expect(c.tracks.some((t) => t.id === extra)).toBe(false)
    expect(c.duration_us).toBe(8 * S)
    a.dispatch('undo', {})
    expect(root(a.snapshot()).tracks.some((t) => t.id === extra)).toBe(true)
    expect(where(a, one)).toEqual({ track: extra, span: [0, S] })
  })

  it('moving a member past its neighbours keeps every lane in time order, partners too', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, S)
    const au = audio(a, tA, 0, S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const nextV = color(a, tA, S, 2 * S)
    const nextA = audio(a, tA, S, 2 * S)
    ok(call(a, 'move_layers', { layer_ids: [v], t_start_us: 3 * S }))
    expect(root(a.snapshot()).tracks.find((t) => t.id === tA)!.layers.map((l) => l.id).sort()).toEqual([au, nextA, nextV, v].sort())
    const starts = root(a.snapshot()).tracks.find((t) => t.id === tA)!.layers.map((l) => l.t_start_us)
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
  })

  it('insert closes behind and answers what the closing moved, without the set', () => {
    const { a, tA } = setup()
    const head = color(a, tA, 0, S)
    const seed = color(a, tA, S, 2 * S)
    const tail = color(a, tA, 2 * S, 3 * S)
    const rec = ok(call(a, 'move_layers', { layer_ids: [seed], t_start_us: 5 * S, insert: true }))
    expect(span(a, tail)).toEqual([S, 2 * S])
    expect(span(a, seed)).toEqual([5 * S, 6 * S])
    expect(span(a, head)).toEqual([0, S])
    expect(JSON.stringify(rec.rippled)).toContain(tail)
    expect(JSON.stringify(rec.rippled)).not.toContain(seed)
  })

  it('insert opens room the length of the whole set, from the set\'s earliest landing', () => {
    const { a, tA } = setup()
    const head = color(a, tA, 0, S)
    const other = color(a, tA, S, 2 * S)
    const b = color(a, tA, 2 * S, 3 * S)
    const c = color(a, tA, 3 * S, 4 * S)
    ok(call(a, 'move_layers', { layer_ids: [c, b], t_start_us: 2 * S, insert: true }))
    expect(span(a, head)).toEqual([0, S])
    expect(span(a, c)).toEqual([2 * S, 3 * S])
    expect(span(a, b)).toEqual([S, 2 * S])
    expect(span(a, other)).toEqual([3 * S, 4 * S])
  })

  it('insert refuses to open room through a link it would split, a locked lane or a locked layer', () => {
    const setUp = () => {
      const s = setup()
      return { ...s, seed: color(s.a, s.tA, 5 * S, 6 * S) }
    }
    {
      const { a, tB, seed } = setUp()
      const reach = video(a, tB, 0, 2 * S)
      const after = audio(a, tB, S, 3 * S)
      const link = idOf(a.dispatch('links_create', { layers: [reach, after] }))
      expect(refused(call(a, 'move_layers', { layer_ids: [seed], t_start_us: S, insert: true })).data).toMatchObject({ error: 'ShiftLinkStraddles', link, t_from_us: S })
      expect(span(a, after)).toEqual([S, 3 * S])
    }
    {
      // A member ending exactly on the landing does not reach across it.
      const { a, tB, seed } = setUp()
      const ends = video(a, tB, 0, S)
      const starts = audio(a, tB, S, 2 * S)
      idOf(a.dispatch('links_create', { layers: [ends, starts] }))
      ok(call(a, 'move_layers', { layer_ids: [seed], t_start_us: S, insert: true }))
      expect(span(a, starts)).toEqual([2 * S, 3 * S])
      expect(span(a, ends)).toEqual([0, S])
    }
    {
      const { a, tB, seed } = setUp()
      const held = color(a, tB, S, 2 * S)
      ok(call(a, 'set_layer_flags', { layer_ids: [held], locked: true }))
      expect(refused(call(a, 'move_layers', { layer_ids: [seed], t_start_us: 0, insert: true })).data).toMatchObject({ error: 'RippleLockedLayer', layer: held })
    }
    {
      const { a, tB, seed } = setUp()
      const held = color(a, tB, S, 2 * S)
      ok(call(a, 'set_track_flags', { track_id: tB, locked: true }))
      expect(refused(call(a, 'move_layers', { layer_ids: [seed], t_start_us: 0, insert: true })).message).toContain(tB)
      expect(span(a, held)).toEqual([S, 2 * S])
    }
  })
})

describe('the timeline\'s moves', () => {
  it('move_layers (a drag of many) refuses a locked destination and a locked member', () => {
    const { a, tA, tB } = setup()
    const one = color(a, tA, 0, S)
    ok(call(a, 'set_track_flags', { track_id: tB, locked: true }))
    const r = a.dispatch('move_layers', { placements: [{ layerId: one, trackId: tB }], anchor_layer_id: one, t_start_us: S })
    expect(r).toMatchObject({ ok: false, error: { error: 'TrackLocked', track: tB } })
    expect(where(a, one)).toEqual({ track: tA, span: [0, S] })
  })

  it('move_layer floors a drag past 0 as one body and keeps the partner\'s phase', () => {
    const { a, tA } = setup()
    const v = video(a, tA, S, 2 * S)
    const au = audio(a, tA, 2 * S, 3 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    expect(a.dispatch('move_layer', { layer: au, to_track: tA, t_start_us: 0 }).ok).toBe(true)
    expect(span(a, v)).toEqual([0, S])
    expect(span(a, au)).toEqual([S, 2 * S])
  })

  it('move_layer leaves a locked partner alone only when the drag escapes the link', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, S)
    const au = audio(a, tA, 0, S)
    const link = idOf(a.dispatch('links_create', { layers: [v, au] }))
    ok(call(a, 'set_layer_flags', { layer_ids: [au], locked: true }))
    expect(a.dispatch('move_layer', { layer: v, to_track: tA, t_start_us: S })).toMatchObject({ ok: false, error: { error: 'LinkLockedMember', link, locked_layer: au } })
    expect(a.dispatch('move_layer', { layer: v, to_track: tA, t_start_us: S, escape_link: true }).ok).toBe(true)
    expect(span(a, au)).toEqual([0, S])
    expect(span(a, v)).toEqual([S, 2 * S])
  })

  it('the raise: a verbatim raise leaves the duration, a landing refits it, and every emptied lane goes', () => {
    const { a } = setup()
    const laneOne = idOf(a.dispatch('add_track', {}))
    const laneTwo = idOf(a.dispatch('add_track', {}))
    const one = color(a, laneOne, 0, S)
    const two = color(a, laneTwo, S, 2 * S)
    const pinned = root(a.snapshot()).duration_us
    const raised = idOf(a.dispatch('move_layers_to_new_track', { layers: [one, two] }))
    expect(root(a.snapshot()).duration_us).toBe(pinned)
    const c = root(a.snapshot())
    expect(c.tracks.some((t) => t.id === laneOne || t.id === laneTwo)).toBe(false)
    expect(where(a, one)).toEqual({ track: raised, span: [0, S] })
    idOf(a.dispatch('move_layers_to_new_track', { layers: [one, two], anchor_layer_id: one, t_start_us: 6 * S }))
    expect(root(a.snapshot()).duration_us).toBe(8 * S)
    expect(span(a, two)).toEqual([7 * S, 8 * S])
  })

  it('the raise refuses an empty set and an anchor outside it', () => {
    const { a, tA } = setup()
    const one = color(a, tA, 0, S)
    const two = color(a, tA, S, 2 * S)
    expect(a.dispatch('move_layers_to_new_track', { layers: [] })).toMatchObject({ ok: false, error: { error: 'InvalidArgument', field: 'layers' } })
    const outside = a.dispatch('move_layers_to_new_track', { layers: [one], anchor_layer_id: two, t_start_us: S })
    expect(outside).toMatchObject({ ok: false, error: { error: 'InvalidArgument', field: 'anchor_layer_id', detail: expect.stringContaining(two) } })
  })
})

describe('set_layer_flags and rename_layer', () => {
  it('sets enabled and locked on exactly the named layers, in one entry, nothing expanded', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const len = a.historyStatus().len
    const rec = ok(call(a, 'set_layer_flags', { layer_ids: [v], enabled: false, locked: true }))
    const layers = root(a.snapshot()).tracks.flatMap((t) => t.layers)
    expect(layers.find((l) => l.id === v)).toMatchObject({ enabled: false, locked: true })
    expect(layers.find((l) => l.id === au)).toMatchObject({ enabled: true, locked: false })
    expect(a.historyStatus().len).toBe(len + 1)
    expect((rec.layers as Array<{ layer_id: string }>).map((l) => l.layer_id)).toEqual([v])
    // Unlock and edit are two calls: the lock guards the visibility write.
    expect(refused(call(a, 'set_layer_flags', { layer_ids: [v], enabled: true, locked: false })).data).toMatchObject({ error: 'LayerLocked', layer: v })
    ok(call(a, 'set_layer_flags', { layer_ids: [v], locked: false }))
    ok(call(a, 'set_layer_flags', { layer_ids: [v], enabled: true }))
    expect(root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === v)).toMatchObject({ enabled: true, locked: false })
  })

  it('rename_layer sets and clears the label; a time is refused naming the tools that write it', () => {
    const { a, tA } = setup()
    const l = color(a, tA, 0, S)
    expect(ok(call(a, 'rename_layer', { layer_id: l, label: 'slate' })).label).toBe('slate')
    expect(ok(call(a, 'rename_layer', { layer_id: l, label: null })).label).toBeNull()
    const e = refused(call(a, 'rename_layer', { layer_id: l, label: 'x', t_start_us: S }))
    expect(e.message).toContain('move_layers')
  })
})

describe('paste_layers { unique: true }', () => {
  // L9: duplicate a Group and change its text — the copy must not be another
  // instance of the same composition.
  it('deep-copies a Group clone\'s composition, so an edit inside the copy leaves the source alone', () => {
    const { a, tA } = setup()
    const inner = color(a, tA, 0, 2 * S)
    const g = ok(call(a, 'create_group', { layer_ids: [inner], label: 'Intro' }))
    const groupLayer = g.layer_id as string
    const sourceComp = g.composition_id as string
    const rec = ok(call(a, 'paste_layers', { layer_ids: [groupLayer], t_start_us: 5 * S, unique: true }))
    const [{ composition_id: copyComp }] = rec.groups as Array<{ layer_id: string; composition_id: string }>
    expect(copyComp).not.toBe(sourceComp)
    const copy = a.snapshot().compositions[copyComp!]!
    expect(copy.label).toBe('Intro copy')
    const copiedInner = copy.tracks.flatMap((t) => t.layers)[0]!
    expect(copiedInner.id).not.toBe(inner)
    ok(call(a, 'rename_layer', { layer_id: copiedInner.id, label: 'outro' }))
    expect(a.snapshot().compositions[sourceComp]!.tracks.flatMap((t) => t.layers)[0]!.label).toBeNull()
  })

  it('without unique a Group clone shares the composition; unique with no Group is refused', () => {
    const { a, tA } = setup()
    const inner = color(a, tA, 0, 2 * S)
    const g = ok(call(a, 'create_group', { layer_ids: [inner] }))
    const rec = ok(call(a, 'paste_layers', { layer_ids: [g.layer_id], t_start_us: 5 * S }))
    const clone = (rec.clones as Array<{ clone: string }>)[0]!.clone
    const params = root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === clone)!.params as { composition: string }
    expect(params.composition).toBe(g.composition_id)
    const other = color(a, tA, 8 * S, 9 * S)
    expect(refused(call(a, 'paste_layers', { layer_ids: [other], t_start_us: 10 * S, unique: true })).message).toContain('Group')
  })
})

describe('retime_layers answers what it left behind', () => {
  it('names the link partners left out, and folds the pitch policy in', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const rec = ok(call(a, 'retime_layers', { layer_ids: [v], target: { kind: 'Rate', value: { num: 2, den: 1 } } }))
    expect(rec.unretimed_partners).toEqual([au])
    expect(span(a, v)).toEqual([0, S])
    const pitch = ok(call(a, 'retime_layers', { layer_ids: [au], preserve_pitch: false }))
    expect(pitch.preserve_pitch).toEqual({ value: false, layer_ids: [au] })
    expect((root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === au)!.params as { preserve_pitch?: boolean }).preserve_pitch).toBe(false)
    expect(refused(call(a, 'retime_layers', { layer_ids: [v], preserve_pitch: true })).message).toContain('Audio')
    expect(refused(call(a, 'retime_layers', { layer_ids: [v] })).message).toContain('target')
  })
})

describe('the slip: src_in_us moves the window and keeps the span', () => {
  it.each(['VideoClip', 'Audio'] as const)('%s', (kind) => {
    const { a, tA } = setup()
    const l = kind === 'VideoClip' ? video(a, tA, S, 3 * S, 4 * S) : audio(a, tA, S, 3 * S, 4 * S)
    ok(call(a, 'update_layer_params', { layer_id: l, patch: { kind, src_in_us: 5 * S } }))
    const p = root(a.snapshot()).tracks.flatMap((t) => t.layers).find((x) => x.id === l)!
    expect([p.t_start_us, p.t_end_us]).toEqual([S, 3 * S])
    expect([(p.params as { src_in_us: number }).src_in_us, (p.params as { src_out_us: number }).src_out_us]).toEqual([5 * S, 7 * S])
    // The end is derived; over MCP it is not a field of its own.
    expect(refused(call(a, 'update_layer_params', { layer_id: l, patch: { kind, src_out_us: 9 * S } })).message).toContain('trim_layer')
  })
})

describe('move_track names its refusals', () => {
  it('keeps the reserved A/B roll tracks in place and names a locked layer', () => {
    const { a, tA, tB } = setup()
    expect(refused(call(a, 'move_track', { track_id: tA, new_position: 1 })).data).toMatchObject({ error: 'TrackReserved', track: tA })
    const extra = idOf(a.dispatch('add_track', {}))
    const l = color(a, extra, 0, S)
    ok(call(a, 'set_layer_flags', { layer_ids: [l], locked: true }))
    expect(refused(call(a, 'move_track', { track_id: extra, new_position: 0 })).data).toMatchObject({ error: 'LayerLocked', layer: l })
    ok(call(a, 'set_layer_flags', { layer_ids: [l], locked: false }))
    expect(ok(call(a, 'move_track', { track_id: extra, new_position: 0 })).index).toBe(0)
    expect(root(a.snapshot()).tracks.map((t) => t.id).indexOf(tB)).toBeGreaterThan(0)
  })
})
