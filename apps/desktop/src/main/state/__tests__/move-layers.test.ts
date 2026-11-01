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
