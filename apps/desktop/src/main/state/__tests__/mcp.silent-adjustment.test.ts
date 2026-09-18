// apps/desktop/src/main/state/__tests__/mcp.silent-adjustment.test.ts
// One rule for a time an agent sends: a GRID SNAP is applied and echoed in
// `adjusted` (reason 'grid'); a CLAMP — anything that changes what was asked
// beyond the lattice — is refused before any write. So `trim_layer` past the
// other edge never lands a one-frame clip, `move_layer` to a negative start
// never lands at 0, and a marker is never stored negative. The renderer's drag
// keeps its clamps (the user sees the ghost); the MCP parsers set `strict` on
// the mutations.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'
import { root } from './fixtures/project'
import { mapCommandError } from '../mcp-commands'

type Actor = ReturnType<typeof freshActor>
const call = (a: Actor, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const ok = (r: ReturnType<Actor['mcpCall']>): Record<string, unknown> => {
  expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
  if (!r.ok) throw new Error('call failed')
  return r.result.structuredContent as Record<string, unknown>
}
const refusal = (r: ReturnType<Actor['mcpCall']>): string => {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected a refusal')
  expect(r.error.code).toBe('invalid_params')
  return r.error.message
}
const layerOf = (a: Actor, id: string) => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!
function colorLayer(a: Actor, track: string, t0: number, t1: number): string {
  return ok(call(a, 'add_color_layer', { track_id: track, color: { r: 1, g: 2, b: 3, a: 255 }, t_start_us: t0, t_end_us: t1 })).layer_id as string
}
const FRAME = 33_333 // one frame at 30 fps, rounded

describe('a grid snap is applied and echoed', () => {
  it('add_color_layer at an off-grid start lands on the frame and says so', () => {
    const a = freshActor()
    const rec = ok(call(a, 'add_color_layer', { track_id: aRollId(a), color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 350_000, t_end_us: 3_000_000 }))
    expect(rec.t_start_us).toBe(366_667)
    expect(rec.adjusted).toEqual([{ field: 't_start_us', requested: 350_000, applied: 366_667, reason: 'grid' }])
  })

  it('move_layer to an off-grid start snaps and echoes; an on-grid one echoes nothing', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 0, 1_000_000)
    const moved = ok(call(a, 'move_layer', { layer_id: id, new_track_id: aRollId(a), new_t_start_us: 350_000 }))
    expect(moved.t_start_us).toBe(366_667)
    expect(moved.adjusted).toEqual([{ field: 't_start_us', requested: 350_000, applied: 366_667, reason: 'grid' }])
    expect(ok(call(a, 'move_layer', { layer_id: id, new_track_id: aRollId(a), new_t_start_us: 1_000_000 })).adjusted).toEqual([])
  })

  it('update_layer\'s times snap like every other placing tool\'s instead of being refused with snap_to', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 0, 2_000_000)
    const rec = ok(call(a, 'update_layer', { layer_id: id, patch: { t_end_us: 1_990_000 } }))
    expect(rec.t_end_us).toBe(2_000_000)
    expect(rec.adjusted).toEqual([{ field: 't_end_us', requested: 1_990_000, applied: 2_000_000, reason: 'grid' }])
    expect(layerOf(a, id).t_end_us).toBe(2_000_000)
  })

  it('add_marker snaps to the frame and echoes', () => {
    const a = freshActor()
    const rec = ok(call(a, 'add_marker', { t_us: 40_000, label: 'm', color: { r: 0, g: 0, b: 0, a: 255 } }))
    expect(rec.t_us).toBe(FRAME)
    expect(rec.adjusted).toEqual([{ field: 't_us', requested: 40_000, applied: FRAME, reason: 'grid' }])
  })
})

describe('a clamp is refused before any write', () => {
  it('move_layer to a negative start: refused naming the layer and 0, and nothing moved', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 1_000_000, 2_000_000)
    const before = a.historyStatus().len
    const msg = refusal(call(a, 'move_layer', { layer_id: id, new_track_id: aRollId(a), new_t_start_us: -500_000 }))
    expect(msg).toContain('timeline time starts at 0')
    expect(msg).toContain(id)
    expect(layerOf(a, id).t_start_us).toBe(1_000_000)
    expect(a.historyStatus().len).toBe(before)
  })

  it('a linked set that would carry a sibling past 0 is refused naming that sibling', () => {
    // Video at 1 s and its linked audio at 0.5 s: moving the video to 0.2 s
    // would put the audio at −0.3 s. The renderer's drag stops the set as a
    // body; the agent is told which member would have crossed.
    const a = freshActor()
    const v = colorLayer(a, aRollId(a), 1_000_000, 2_000_000)
    const s = colorLayer(a, bRollId(a), 500_000, 1_500_000)
    ok(call(a, 'create_link', { layer_ids: [v, s] }))
    const msg = refusal(call(a, 'move_layer', { layer_id: v, new_track_id: aRollId(a), new_t_start_us: 200_000 }))
    expect(msg).toContain(s)
    expect(msg).toContain('-300000')
    expect(layerOf(a, v).t_start_us).toBe(1_000_000)
    expect(layerOf(a, s).t_start_us).toBe(500_000)
  })

  it('trim_layer past the other edge is refused with the legal window — a one-frame clip never lands', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 0, 3_000_000)
    const msg = refusal(call(a, 'trim_layer', { layer_id: id, edge: 'out', new_t_us: 0 }))
    expect(msg).toContain('cannot be trimmed to 0')
    expect(msg).toMatch(/t_end_us may land within \[33333, ∞\]/)
    expect(msg).toContain('never clamped')
    expect(layerOf(a, id)).toMatchObject({ t_start_us: 0, t_end_us: 3_000_000 })
  })

  it('trim_layer IN past the out edge is refused too, and a legal trim still lands', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 0, 3_000_000)
    expect(refusal(call(a, 'trim_layer', { layer_id: id, edge: 'in', new_t_us: 5_000_000 }))).toMatch(/t_start_us may land within \[0, 2966667\]/)
    const rec = ok(call(a, 'trim_layer', { layer_id: id, edge: 'in', new_t_us: 1_000_000 }))
    expect(rec.t_start_us).toBe(1_000_000)
    expect(rec.adjusted).toEqual([])
  })

  it('a negative marker time is refused on add and on update', () => {
    const a = freshActor()
    expect(refusal(call(a, 'add_marker', { t_us: -1_000_000, label: 'm', color: { r: 0, g: 0, b: 0, a: 255 } }))).toContain('timeline time starts at 0')
    expect(root(a.snapshot()).markers).toEqual([])
    const id = ok(call(a, 'add_marker', { t_us: 1_000_000, label: 'm', color: { r: 0, g: 0, b: 0, a: 255 } })).marker_id as string
    expect(refusal(call(a, 'update_marker', { marker_id: id, patch: { t_us: -1 } }))).toContain('t_us -1')
    expect(refusal(call(a, 'update_marker', { marker_id: id, patch: { end_t_us: -5 } }))).toContain('end_t_us -5')
    expect(root(a.snapshot()).markers[0].t_us).toBe(1_000_000)
  })
})

describe('the renderer\'s drag keeps its clamps — the flag is the MCP parsers\' alone', () => {
  it('a non-strict move floors at 0 and a non-strict trim clamps, as before', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 1_000_000, 2_000_000)
    expect(a.dispatch('move_layer', { layer: id, to_track: aRollId(a), t_start_us: -500_000 }).ok).toBe(true)
    expect(layerOf(a, id).t_start_us).toBe(0)
    expect(a.dispatch('trim_layer', { layer: id, edge: 'out', new_t_us: 0 }).ok).toBe(true)
    expect(layerOf(a, id).t_end_us).toBe(FRAME)
  })
})

describe('mapCommandError — TrimEdgeOutOfRange carries the window into the message', () => {
  it('names the edge, the span and the window; ∞ for an unbounded out edge', () => {
    const out = mapCommandError({ error: 'TrimEdgeOutOfRange', layer: 'L1', new_t: 0, cur_start: 0, cur_end: 3_000_000, edge: 'Out', window: { lo: 33_333, hi: Number.MAX_SAFE_INTEGER } })
    expect(out.code).toBe('invalid_params')
    expect(out.message).toContain('layer L1 cannot be trimmed to 0 µs')
    expect(out.message).toContain('[33333, ∞]')
    expect(out.data).toEqual({ error: 'TrimEdgeOutOfRange', layer: 'L1', requested_us: 0, span_us: [0, 3_000_000], window_us: [33_333, Number.MAX_SAFE_INTEGER] })
  })

  it('still reads without a window (the legacy clamp-to-zero path)', () => {
    const out = mapCommandError({ error: 'TrimEdgeOutOfRange', layer: 'L1', new_t: 0, cur_start: 0, cur_end: 3_000_000 })
    expect(out.message).toContain('spans [0, 3000000)')
    expect(out.message).not.toContain('within')
  })
})

describe('dry_run rehearses under the same rule', () => {
  type DryRun = { results: Array<{ status: string; error?: string }> }
  const dry = (a: Actor, operations: unknown[]): DryRun => {
    const r = call(a, 'dry_run', { operations })
    if (!r.ok) throw new Error(r.error.message)
    return JSON.parse(r.result.content[0].text) as DryRun
  }
  it('a rehearsed move below 0 is an error naming the start, as the wet call refuses it', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 1_000_000, 2_000_000)
    const r = dry(a, [{ kind: 'move_layer', layer_id: id, new_track_id: aRollId(a), new_t_start_us: -500_000 }])
    expect(r.results[0].status).toBe('error')
    expect(r.results[0].error).toMatch(/NegativeLayerStart|-500000/)
    expect(layerOf(a, id).t_start_us).toBe(1_000_000)
  })
  it('a rehearsed off-grid envelope time is snapped, as the wet call snaps it', () => {
    const a = freshActor()
    const id = colorLayer(a, aRollId(a), 1_000_000, 2_000_000)
    const r = dry(a, [{ kind: 'update_layer', layer_id: id, patch: { t_start_us: 1_010_000 } }])
    expect(r.results[0].status).toBe('ok')
  })
})
