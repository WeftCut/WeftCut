// apps/desktop/src/main/state/__tests__/shift-layers.test.ts
// `shift_layers`: one delta over a set, as one recorded edit — the multi-layer
// move and the ripple insert, which are otherwise N moves and a read.
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

describe('shift_layers by layer_ids', () => {
  it('shifts the named layer and its link partner by the same delta, in one history entry; an unlinked layer stays', () => {
    const { a, tA, tB } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    const title = color(a, tB, 0, S)
    const len = a.historyStatus().len
    const rec = record(call(a, { layer_ids: [v], delta_us: S }))
    expect(span(a, v)).toEqual([S, 3 * S])
    expect(span(a, au)).toEqual([S, 3 * S])
    expect(span(a, title)).toEqual([0, S])
    expect(a.historyStatus().len).toBe(len + 1)
    expect(rec.delta_us).toBe(S)
    expect(rec.moved.map((m) => m.layer_id).sort()).toEqual([v, au].sort())
    a.dispatch('undo', {})
    expect(span(a, v)).toEqual([0, 2 * S])
    expect(span(a, au)).toEqual([0, 2 * S])
  })

  it('escape_link leaves the partner where it was', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 2 * S)
    const au = audio(a, tA, 0, 2 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    record(call(a, { layer_ids: [v], delta_us: S, escape_link: true }))
    expect(span(a, v)).toEqual([S, 3 * S])
    expect(span(a, au)).toEqual([0, 2 * S])
  })

  it('refuses a set that would cross 0, naming the earliest member, and moves nothing', () => {
    const { a, tA, tB } = setup()
    const early = color(a, tA, S, 2 * S)
    const late = color(a, tB, 3 * S, 4 * S)
    const r = call(a, { layer_ids: [early, late], delta_us: -2 * S })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain(early)
    expect(r.error.message).not.toContain('clamp')
    expect(span(a, early)).toEqual([S, 2 * S])
    expect(span(a, late)).toEqual([3 * S, 4 * S])
  })

  it('refuses a landing on an occupied span, naming the pair, and moves nothing', () => {
    const { a, tA } = setup()
    const first = color(a, tA, 0, 2 * S)
    const second = color(a, tA, 2 * S, 4 * S)
    const r = call(a, { layer_ids: [second], delta_us: -S })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error.message).toContain('collides with layer')
    expect(r.error.message).toContain(first)
    expect(span(a, first)).toEqual([0, 2 * S])
    expect(span(a, second)).toEqual([2 * S, 4 * S])
  })

  it('refuses a layer on a locked lane', () => {
    const { a, tA } = setup()
    const l = color(a, tA, 0, S)
    expect(a.dispatch('update_track_flags', { track: tA, patch: { locked: true } }).ok).toBe(true)
    const r = call(a, { layer_ids: [l], delta_us: S })
    expect(!r.ok && r.error.message).toContain('locked')
  })

  it('snaps each layer on its own grid and echoes the landing in the record', () => {
    const { a, tA } = setup()
    const l = color(a, tA, 0, S)
    const rec = record(call(a, { layer_ids: [l], delta_us: 350_000 }))
    expect(rec.delta_us).toBe(350_000)
    expect(rec.moved[0].t_start_us).toBe(366_667) // 11 frames at 30 fps
    // The record says the start moved off the requested delta, so an agent
    // reads the landing rather than assuming its own arithmetic.
    expect(rec.moved[0].adjusted).toEqual([{ field: 't_start_us', requested: 350_000, applied: 366_667, reason: 'grid' }])
    expect(span(a, l)[0]).toBe(366_667)
  })
})

describe('shift_layers from a time', () => {
  it('shifts every layer starting at or after from_t_us, on every track, and leaves the ones before', () => {
    const { a, tA, tB } = setup()
    const head = color(a, tA, 0, 2 * S)
    const mid = color(a, tA, 2 * S, 4 * S)
    const tail = color(a, tB, 4 * S, 6 * S)
    const rec = record(call(a, { from_t_us: 2 * S, delta_us: S }))
    expect(span(a, head)).toEqual([0, 2 * S])
    expect(span(a, mid)).toEqual([3 * S, 5 * S])
    expect(span(a, tail)).toEqual([5 * S, 7 * S])
    expect(rec.moved.map((m) => m.layer_id).sort()).toEqual([mid, tail].sort())
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
    expect(r.error.message).toContain('layer_ids')
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

  it('an empty sweep records nothing', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const len = a.historyStatus().len
    const rec = record(call(a, { from_t_us: 10 * S, delta_us: S }))
    expect(rec.moved).toEqual([])
    expect(a.historyStatus().len).toBe(len)
  })
})

describe('shift_layers arguments', () => {
  it('takes exactly one of layer_ids / from_t_us, and a non-zero delta', () => {
    const { a, tA } = setup()
    const l = color(a, tA, 0, S)
    for (const args of [{ delta_us: S }, { layer_ids: [l], from_t_us: 0, delta_us: S }, { layer_ids: [l], delta_us: 0 }]) {
      const r = call(a, args)
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_params')
    }
    expect(span(a, l)).toEqual([0, S])
  })

  it('refuses an empty layer_ids by its own name, not the actor\'s', () => {
    const { a } = setup()
    const r = call(a, { layer_ids: [], delta_us: S })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error.message).toContain('layer_ids')
    expect(r.error.message).toContain('from_t_us')
  })

  it('refuses a key of the other branch instead of ignoring it', () => {
    const { a, tA, tB } = setup()
    const l = color(a, tA, 0, S)
    for (const args of [{ layer_ids: [l], track_ids: [tB], delta_us: S }, { layer_ids: [l], composition_id: root(a.snapshot()).id, delta_us: S }, { from_t_us: 0, escape_link: true, delta_us: S }]) {
      const r = call(a, args)
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (!r.ok) { expect(r.error.code).toBe('invalid_params'); expect(r.error.message).toContain('goes with') }
    }
    expect(span(a, l)).toEqual([0, S])
  })
})
