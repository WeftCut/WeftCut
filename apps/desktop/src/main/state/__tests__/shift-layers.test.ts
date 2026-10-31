// apps/desktop/src/main/state/__tests__/shift-layers.test.ts
// `shift_layers`: the sweep — every layer starting at or after a time, by one
// delta, as one recorded edit. A positive delta is the ripple insert; a
// negative one closes the span before the time through the ripple planner.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

const AV = '00000000-0000-0000-0000-0000000000ab'
const S = 1_000_000

function setup() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'shift'), idGen: gen, clock: () => '<TS>' })
  a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: true })
  const [tA, tB] = root(a.snapshot()).tracks.map((t) => t.id)
  return { a, tA, tB }
}
const idOf = (r: ReturnType<ActorHandle['dispatch']>): string => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value as string }
const span = (a: ActorHandle, id: string): [number, number] => {
  for (const t of root(a.snapshot()).tracks) { const l = t.layers.find((x) => x.id === id); if (l) return [l.t_start_us, l.t_end_us] }
  throw new Error(`no layer ${id}`)
}
const color = (a: ActorHandle, track: string, s: number, e: number) => idOf(a.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e }))
const video = (a: ActorHandle, track: string, s: number, e: number) => idOf(a.dispatch('add_layer', { track, kind: 'video', media: AV, src_in_us: 0, src_out_us: e - s, t_start_us: s, t_end_us: e }))
const audio = (a: ActorHandle, track: string, s: number, e: number) => idOf(a.dispatch('add_layer', { track, kind: 'audio', media: AV, src_in_us: 0, src_out_us: e - s, t_start_us: s, t_end_us: e }))
const call = (a: ActorHandle, args: Record<string, unknown>) => a.mcpCall('shift_layers', JSON.stringify(args))
type Adjustment = { field: string; requested: number; applied: number; reason: string }
const record = (r: ReturnType<ActorHandle['mcpCall']>): { moved: Array<{ layer_id: string; t_start_us: number; t_end_us: number; adjusted: Adjustment[] }>; delta_us: number } => {
  if (!r.ok) throw new Error(r.error.message)
  return JSON.parse(r.result.content[0].text)
}

describe('shift_layers opens room', () => {
  it('shifts every layer starting at or after from_t_us, on every track, and leaves the ones before', () => {
    const { a, tA, tB } = setup()
    const head = color(a, tA, 0, 2 * S)
    const mid = color(a, tA, 2 * S, 4 * S)
    const tail = color(a, tB, 4 * S, 6 * S)
    const len = a.historyStatus().len
    const rec = record(call(a, { from_t_us: 2 * S, delta_us: S }))
    expect(span(a, head)).toEqual([0, 2 * S])
    expect(span(a, mid)).toEqual([3 * S, 5 * S])
    expect(span(a, tail)).toEqual([5 * S, 7 * S])
    expect(rec.moved.map((m) => m.layer_id).sort()).toEqual([mid, tail].sort())
    expect(a.historyStatus().len).toBe(len + 1)
    // The ripple insert: the gap is open, and a clip fits in it.
    expect(a.dispatch('add_layer', { track: tA, kind: 'color', t_start_us: 2 * S, t_end_us: 3 * S }).ok).toBe(true)
  })

  it('track_ids narrows the sweep to those lanes', () => {
    const { a, tA, tB } = setup()
    const onA = color(a, tA, 2 * S, 4 * S)
    const onB = color(a, tB, 2 * S, 4 * S)
    record(call(a, { from_t_us: 0, delta_us: S, track_ids: [tB] }))
    expect(span(a, onA)).toEqual([2 * S, 4 * S])
    expect(span(a, onB)).toEqual([3 * S, 5 * S])
  })

  it('refuses a sweep that would split a link, naming the way to move it whole', () => {
    // Moving one member and not the other slips their sync, which is what the
    // ripple refuses for the same shape; nothing moves.
    const { a, tA } = setup()
    const v = video(a, tA, 0, 4 * S)
    const au = audio(a, tA, 2 * S, 4 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const r = call(a, { from_t_us: 2 * S, delta_us: S })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.message).toContain('move_layers')
    expect(span(a, v)).toEqual([0, 4 * S])
    expect(span(a, au)).toEqual([2 * S, 4 * S])
  })

  it('sweeps a link whose members all start at or after the time', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 2 * S, 4 * S)
    const au = audio(a, tA, 2 * S, 4 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    record(call(a, { from_t_us: 2 * S, delta_us: S }))
    expect(span(a, v)).toEqual([3 * S, 5 * S])
    expect(span(a, au)).toEqual([3 * S, 5 * S])
  })

  it('snaps each layer on its own grid and echoes the landing in the record', () => {
    const { a, tA } = setup()
    const l = color(a, tA, S, 2 * S)
    const rec = record(call(a, { from_t_us: S, delta_us: 350_000 }))
    expect(rec.delta_us).toBe(350_000)
    expect(rec.moved[0].t_start_us).toBe(1_366_667) // 41 frames at 30 fps
    expect(rec.moved[0].adjusted).toEqual([{ field: 't_start_us', requested: 1_350_000, applied: 1_366_667, reason: 'grid' }])
    expect(span(a, l)[0]).toBe(1_366_667)
  })

  it('an empty sweep is refused, not answered as a success that moved nothing', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const len = a.historyStatus().len
    const r = call(a, { from_t_us: 10 * S, delta_us: S })
    expect(!r.ok && r.error.message).toContain('would move nothing')
    expect(a.historyStatus().len).toBe(len)
  })
})

describe('shift_layers closes the span before from_t_us (ripple planner)', () => {
  it('closes a gap with one edge: everything from the time moves left, on every track', () => {
    const { a, tA, tB } = setup()
    const head = color(a, tA, 0, 2 * S)
    const tail = color(a, tA, 3 * S, 4 * S)
    const other = color(a, tB, 5 * S, 6 * S)
    const rec = record(call(a, { from_t_us: 3 * S, delta_us: -S }))
    expect(span(a, head)).toEqual([0, 2 * S])
    expect(span(a, tail)).toEqual([2 * S, 3 * S])
    expect(span(a, other)).toEqual([4 * S, 5 * S])
    expect(rec.delta_us).toBe(-S)
    expect(rec.moved.map((m) => m.layer_id).sort()).toEqual([tail, other].sort())
  })

  it('refuses a layer starting inside the span by name (RippleInsideHole), moving nothing', () => {
    const { a, tA, tB } = setup()
    color(a, tA, 0, 2 * S)
    const tail = color(a, tA, 3 * S, 4 * S)
    const inside = color(a, tB, 2_500_000, 2_800_000)
    const r = call(a, { from_t_us: 3 * S, delta_us: -S })
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.data).toMatchObject({ error: 'RippleInsideHole', layer: inside, tool: 'shift_layers' })
    expect(r.error.message).toContain('shift by less')
    expect(span(a, tail)).toEqual([3 * S, 4 * S])
  })

  it('refuses a landing on a layer that reaches into the span (RippleCollision)', () => {
    const { a, tA } = setup()
    const head = color(a, tA, 0, 2_500_000)
    const tail = color(a, tA, 3 * S, 4 * S)
    const r = call(a, { from_t_us: 3 * S, delta_us: -S })
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.data).toMatchObject({ error: 'RippleCollision', moving: tail, blocking: head })
  })

  it('carries a transition whose participants both move, keeping it', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const from = color(a, tA, 2 * S, 4 * S)
    const to = color(a, tA, 4 * S, 6 * S)
    expect(a.dispatch('add_transition', { from, to, duration_us: 500_000 }).ok).toBe(true)
    record(call(a, { from_t_us: 2 * S, delta_us: -S }))
    const c = root(a.snapshot())
    expect(c.transitions).toHaveLength(1)
    expect(span(a, from)[0]).toBe(S)
  })

  it('refuses a start before 0', () => {
    const { a, tA } = setup()
    const l = color(a, tA, S, 2 * S)
    const r = call(a, { from_t_us: S, delta_us: -2 * S })
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.data).toMatchObject({ error: 'NegativeLayerStart', layer: l })
  })
})

describe('shift_layers arguments', () => {
  it('needs from_t_us and a non-zero delta', () => {
    const { a, tA } = setup()
    const l = color(a, tA, 0, S)
    for (const args of [{ delta_us: S }, { from_t_us: 0, delta_us: 0 }, { from_t_us: 0 }]) {
      const r = call(a, args)
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_params')
    }
    expect(span(a, l)).toEqual([0, S])
  })

  it('refuses layer_ids and escape_link, naming move_layers', () => {
    const { a, tA } = setup()
    const l = color(a, tA, 0, S)
    for (const args of [{ layer_ids: [l], from_t_us: 0, delta_us: S }, { from_t_us: 0, escape_link: true, delta_us: S }]) {
      const r = call(a, args)
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (!r.ok) { expect(r.error.code).toBe('invalid_params'); expect(r.error.message).toContain('move_layers') }
    }
    expect(span(a, l)).toEqual([0, S])
  })
})
