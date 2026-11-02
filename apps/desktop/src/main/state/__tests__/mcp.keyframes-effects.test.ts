// apps/desktop/src/main/state/__tests__/mcp.keyframes-effects.test.ts
// The keyframe family of five and effects in one call (audit issue 10),
// end to end through actor.mcpCall:
// - get_param_track reads `track` in set_param_track's write shape, so the
//   round trip needs no edit;
// - one easing vocabulary, keyed on any key of a set_param_track, and
//   `update_keyframe { smooth }` for Auto tangents;
// - an effect param is its catalog default until written, so it is keyed
//   with no prior update_effect, and add_effect sets values in the same call;
// - translate_position offsets either position mode in one undo step.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'
import { root } from './fixtures/project'
import type { Layer } from '../model'

type Actor = ReturnType<typeof freshActor>
type Answer = Record<string, unknown>
const call = (a: Actor, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
function ok(r: ReturnType<Actor['mcpCall']>): Answer {
  if (!r.ok) throw new Error(`refused: ${r.error.message}`)
  return r.result.structuredContent as Answer
}
function refusal(r: ReturnType<Actor['mcpCall']>): { message: string; data: Answer } {
  if (r.ok) throw new Error(`expected a refusal, got ${r.result.content[0]?.text}`)
  return { message: r.error.message, data: (r.error.data ?? {}) as Answer }
}
const layerOf = (a: Actor, id: string): Layer => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!
const S = 1_000_000

/** A Text layer starting at 1 s, so timeline and layer-local times differ. */
function title(a: Actor): string {
  const r = ok(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: S, t_end_us: 5 * S, content: { kind: 'text', content: 'Title' } }] }))
  return (r.layers as Array<{ layer_id: string }>)[0]!.layer_id
}
type Read = { track: { mode: string; value: unknown; extrapolate?: unknown }; keyframe_ids: string[]; local_t_us: number[]; preset_ids: Array<string | null> }
const read = (a: Actor, layer: string, param_key: string) => ok(call(a, 'get_param_track', { layer_id: layer, param_key })) as unknown as Read

describe('get_param_track → set_param_track round trip', () => {
  it('sends the read track back with no edit, and the track is unchanged but for fresh ids', () => {
    const a = freshActor()
    const layer = title(a)
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: S, value: 0 }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 2 * S, value: 1, easing: { preset: 'ease_out' } }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 3 * S, value: 0.5 }))
    ok(call(a, 'update_keyframe', { layer_id: layer, param_key: 'opacity', keyframe_id: read(a, layer, 'opacity').keyframe_ids[2]!, smooth: true }))
    const first = read(a, layer, 'opacity')
    expect(first.track.mode).toBe('Keyframed')
    expect(first.local_t_us).toEqual([0, S, 2 * S]) // layer-local, beside the timeline `t_us`
    expect((first.track.value as Array<{ t_us: number }>).map((k) => k.t_us)).toEqual([S, 2 * S, 3 * S])
    expect(first.preset_ids).toEqual(['ease_out', null, null])

    const written = ok(call(a, 'set_param_track', { layer_id: layer, param_key: 'opacity', track: first.track }))
    const second = read(a, layer, 'opacity')
    expect(second.track).toEqual(first.track)
    expect(second.preset_ids).toEqual(first.preset_ids)
    expect(second.keyframe_ids).not.toEqual(first.keyframe_ids) // every replacement mints
    // The answer is the committed keys, ids and snapped timeline times.
    expect(written.keyframes).toEqual(second.keyframe_ids.map((id, i) => ({ keyframe_id: id, t_us: (i + 1) * S, value: [0, 1, 0.5][i] })))
  })

  it('a Static track reads as the write shape too, with empty parallels', () => {
    const a = freshActor()
    const layer = title(a)
    expect(read(a, layer, 'opacity')).toEqual({ track: { mode: 'Static', value: 1 }, keyframe_ids: [], local_t_us: [], preset_ids: [] })
    ok(call(a, 'set_param_track', { layer_id: layer, param_key: 'opacity', track: read(a, layer, 'opacity').track }))
  })
})

describe('one easing vocabulary', () => {
  it('set_param_track keys take `easing` — one call authors an eased track', () => {
    const a = freshActor()
    const layer = title(a)
    ok(call(a, 'set_param_track', { layer_id: layer, param_key: 'opacity', track: { mode: 'Keyframed', value: [
      { t_us: S, value: 0, easing: { preset: 'ease_out_cubic' } },
      { t_us: 2 * S, value: 1, easing: { kind: 'Hold' } },
      { t_us: 3 * S, value: 0 },
    ] } }))
    expect(read(a, layer, 'opacity').preset_ids).toEqual(['ease_out_cubic', 'hold', null])
  })

  it('set_keyframe in time order: the last key eases the move into it; a lone key refuses', () => {
    const a = freshActor()
    const layer = title(a)
    expect(refusal(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: S, value: 0, easing: { preset: 'ease_in_out' } })).message).toMatch(/one key, which has no segment to ease/)
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: S, value: 0 }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 2 * S, value: 1, easing: { preset: 'ease_in_out' } }))
    expect(read(a, layer, 'opacity').preset_ids).toEqual(['ease_in_out', null])
  })

  it('a set_keyframe a few µs off a key updates that key and keeps its id', () => {
    const a = freshActor()
    const layer = title(a)
    const k = ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 2 * S, value: 1 })).keyframe_id
    const again = ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 2 * S + 7, value: 0.25 }))
    expect(again.keyframe_id).toBe(k)
    expect(read(a, layer, 'opacity').keyframe_ids).toEqual([k])
  })

  it('update_keyframe { smooth: true } sets one key Auto; it takes no side or easing beside it', () => {
    const a = freshActor()
    const layer = title(a)
    for (const [t, v] of [[S, 0], [2 * S, 1], [3 * S, 0]] as const) ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: t, value: v }))
    const mid = read(a, layer, 'opacity').keyframe_ids[1]!
    ok(call(a, 'update_keyframe', { layer_id: layer, param_key: 'opacity', keyframe_id: mid, smooth: true }))
    const keys = read(a, layer, 'opacity').track.value as Array<{ in: { mode: string }; out: { mode: string }; continuity: string }>
    expect([keys[1]!.in.mode, keys[1]!.out.mode, keys[1]!.continuity]).toEqual(['Auto', 'Auto', 'Smooth'])
    expect(keys[0]!.out.mode).toBe('Free')
    expect(refusal(call(a, 'update_keyframe', { layer_id: layer, param_key: 'opacity', keyframe_id: mid, smooth: true, easing: { kind: 'Linear' } })).message).toMatch(/smooth sets both sides Auto, which easing would overwrite/)
    expect(refusal(call(a, 'update_keyframe', { layer_id: layer, param_key: 'opacity', keyframe_id: mid, smooth: false })).message).toMatch(/smooth takes only true/)
  })

  it('the deleted tools are not dispatched under their names (ADR 0074)', () => {
    const a = freshActor()
    for (const name of ['clear_keyframes', 'smooth_keyframes', 'set_extrapolation', 'set_scale_linked', 'translate_path']) {
      const r = call(a, name, {})
      expect(r.ok, name).toBe(false)
      if (!r.ok) expect(r.error.code, name).toBe('not_found')
    }
  })
})

describe('effects in one call, params as plain values', () => {
  it('add_effect { params } sets values at creation — one call, one undo step — and answers them', () => {
    const a = freshActor()
    const layer = title(a)
    const len = a.historyStatus().len
    const r = ok(call(a, 'add_effect', { layer_id: layer, kind: 'brightness', params: { amount: -20 } }))
    expect(r.params).toEqual({ amount: -20 })
    expect(a.historyStatus().len).toBe(len + 1)
    expect(layerOf(a, layer).effects[0]!.params).toEqual({ amount: { mode: 'Static', value: -20 } })
    // Refused whole, before the effect exists.
    expect(refusal(call(a, 'add_effect', { layer_id: layer, kind: 'blur', params: { amount: 3 } })).message).toMatch(/'amount' is not a param of effect kind 'blur'/)
    expect(layerOf(a, layer).effects).toHaveLength(1)
  })

  it('an unset param reads as its catalog default and is keyed with no prior update_effect', () => {
    const a = freshActor()
    const layer = title(a)
    const effect = ok(call(a, 'add_effect', { layer_id: layer, kind: 'blur' }))
    expect(effect.params).toEqual({ strength: 8 }) // the default stands in, and the record says so
    const key = `effects[${effect.effect_id as string}].params[strength]`
    expect(read(a, layer, key).track).toEqual({ mode: 'Static', value: 8 })
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: key, t_us: S, value: 0 }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: key, t_us: 2 * S, value: 40 }))
    expect((read(a, layer, key).track.value as Array<{ value: number }>).map((k) => k.value)).toEqual([0, 40])
  })

  it('an effect id that names nothing on the layer is EffectNotFound', () => {
    const a = freshActor()
    const layer = title(a)
    const missing = '00000000-0000-7000-8000-0000000000ee'
    const r = refusal(call(a, 'set_keyframe', { layer_id: layer, param_key: `effects[${missing}].params[strength]`, t_us: S, value: 1 }))
    expect(r.data.error).toBe('EffectNotFound')
    expect(r.message).toContain(missing)
  })

  it('update_effect takes plain numbers; null unsets back to the default', () => {
    const a = freshActor()
    const layer = title(a)
    const id = ok(call(a, 'add_effect', { layer_id: layer, kind: 'blur' })).effect_id as string
    expect(ok(call(a, 'update_effect', { layer_id: layer, effect_id: id, patch: { params: { strength: 20 } } })).params).toEqual({ strength: 20 })
    expect(ok(call(a, 'update_effect', { layer_id: layer, effect_id: id, patch: { params: { strength: null } } })).params).toEqual({ strength: 8 })
    expect(layerOf(a, layer).effects[0]!.params).toEqual({})
  })
})

describe('translate_position', () => {
  const pos = (a: Actor, id: string) => (layerOf(a, id).params as unknown as { transform: { position: Record<string, unknown> } }).transform.position

  it('offsets a static XY position, then every XY key, keeping the motion; one undo step each', () => {
    const a = freshActor()
    const layer = title(a)
    const start = pos(a, layer) as { x: { value: number }; y: { value: number } }
    const [x0, y0] = [start.x.value, start.y.value]
    const r = ok(call(a, 'translate_position', { layer_id: layer, dx: 100, dy: -50 }))
    expect(r.position).toEqual({ mode: 'XY', x: { mode: 'Static', value: x0 + 100 }, y: { mode: 'Static', value: y0 - 50 } })

    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'x', t_us: S, value: 0 }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'x', t_us: 2 * S, value: 300, easing: { preset: 'ease_out' } }))
    const len = a.historyStatus().len
    ok(call(a, 'translate_position', { layer_id: layer, dx: 10, dy: 0 }))
    expect(a.historyStatus().len).toBe(len + 1)
    const x = read(a, layer, 'x')
    expect((x.track.value as Array<{ value: number }>).map((k) => k.value)).toEqual([10, 310])
    expect(x.preset_ids).toEqual(['ease_out', null]) // the shape survives an offset
  })

  it('moves every node in Path mode, keeping handles and progress', () => {
    const a = freshActor()
    const layer = title(a)
    ok(call(a, 'set_position', { layer_id: layer, position: { mode: 'Path', path: { nodes: [{ point: { x: 100, y: 200 } }, { point: { x: 500, y: 200 } }] }, progress: { mode: 'Static', value: 0.5 } } }))
    ok(call(a, 'translate_position', { layer_id: layer, dx: 20, dy: -10 }))
    const p = pos(a, layer) as { path: { nodes: Array<{ point: { x: number; y: number } }> }; progress: unknown }
    expect(p.path.nodes.map((n) => n.point)).toEqual([{ x: 120, y: 190 }, { x: 520, y: 190 }])
    expect(p.progress).toEqual({ mode: 'Static', value: 0.5 })
  })

  it('refuses a move of nothing and a layer with no position', () => {
    const a = freshActor()
    const layer = title(a)
    expect(refusal(call(a, 'translate_position', { layer_id: layer, dx: 0, dy: 0 })).message).toMatch(/moves nothing/)
    const color = (ok(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: 6 * S, t_end_us: 7 * S, content: { kind: 'color', color: { r: 1, g: 2, b: 3, a: 255 } } }] })).layers as Array<{ layer_id: string }>)[0]!.layer_id
    expect(refusal(call(a, 'translate_position', { layer_id: color, dx: 1, dy: 0 })).message).toMatch(/has no position/)
  })
})
