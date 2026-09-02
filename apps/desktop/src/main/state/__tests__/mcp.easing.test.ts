// apps/desktop/src/main/state/__tests__/mcp.easing.test.ts
// set_keyframe_easing payload union + get_param_track preset_id readback, end
// to end through actor.mcpCall: presets bake to the canonical table params in
// state, and the exact-match reverse lookup surfaces the id on readback. The
// parser-level rejection matrix lives in mcp.validators.test.ts; the rejection
// cases here additionally pin that a rejected write leaves the key untouched.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'
import { EASING_PRESETS } from '../../../shared/easing'

type Side = { x: number; y: number; mode: string }
type KfEntry = {
  id: string
  t_us: number
  t_local_us: number
  value: number
  in: Side
  out: Side
  continuity: string
  segment: Record<string, unknown>
  preset_id?: string
}

/** Text layer on the A roll with two Linear opacity keys (t=0 and t=2s). */
function withKeyedOpacity() {
  const a = freshActor()
  const addR = a.dispatch('add_layer', { kind: 'text', track: aRollId(a), t_start_us: 0, t_end_us: 4_000_000 })
  expect(addR.ok, 'setup add_layer must succeed').toBe(true)
  if (!addR.ok) throw new Error('setup failed')
  const layerId = addR.value as string
  for (const [t, v] of [[0, 0], [2_000_000, 1]] as const) {
    const r = a.mcpCall('set_keyframe', JSON.stringify({ layer_id: layerId, param_key: 'opacity', t_us: t, value: v }))
    expect(r.ok, 'setup set_keyframe must succeed').toBe(true)
  }
  return { a, layerId }
}

function readKeys(a: ReturnType<typeof freshActor>, layerId: string): KfEntry[] {
  const r = a.mcpCall('get_param_track', JSON.stringify({ layer_id: layerId, param_key: 'opacity' }))
  expect(r.ok, 'get_param_track must succeed').toBe(true)
  if (!r.ok) throw new Error('get_param_track failed')
  return (JSON.parse(r.result.content[0].text) as { keyframes: KfEntry[] }).keyframes
}

function setEasing(a: ReturnType<typeof freshActor>, layerId: string, keyframeId: string, interp: unknown) {
  return a.mcpCall('set_keyframe_easing', JSON.stringify({ layer_id: layerId, param_key: 'opacity', keyframe_id: keyframeId, interp }))
}

describe('set_keyframe_easing → get_param_track (preset baking + readback)', () => {
  it('a bezier-family preset bakes the table params and round-trips its id', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    expect(setEasing(a, layerId, kfId, { preset: 'ease_in_out' }).ok).toBe(true)
    const keys = readKeys(a, layerId)
    // The cubic is split across the pair: p1 on the left key's out, p2 on the
    // right key's in (un-mirrored), the class on the left key.
    expect(keys[0].segment).toEqual({ kind: 'Spline' })
    expect(keys[0].out).toEqual({ x: 0.42, y: 0, mode: 'Free' })
    expect(keys[1].in).toEqual({ x: 0.58, y: 1, mode: 'Free' })
    expect(keys[0].preset_id).toBe('ease_in_out')
    // The last key has no leaving segment, so it names no preset.
    expect('preset_id' in keys[1]).toBe(false)
  })

  it('an elastic preset bakes dir plus the shared defaults and reads its id back', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    expect(setEasing(a, layerId, kfId, { preset: 'ease_out_elastic' }).ok).toBe(true)
    const k = readKeys(a, layerId)[0]
    expect(k.segment).toEqual({ kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 })
    expect(k.preset_id).toBe('ease_out_elastic')
  })

  it('a raw Elastic without amplitude/period lands on the defaults, hence the matching preset id', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    expect(setEasing(a, layerId, kfId, { kind: 'Elastic', dir: 'In' }).ok).toBe(true)
    const k = readKeys(a, layerId)[0]
    expect(k.segment).toEqual({ kind: 'Elastic', dir: 'In', amplitude: 1, period: 0.3 })
    expect(k.preset_id).toBe('ease_in_elastic')
  })

  it('a perturbed raw bezier stores its params and OMITS preset_id (no false identity)', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    expect(setEasing(a, layerId, kfId, { kind: 'Bezier', p1: [0.42, 0.001], p2: [1, 1] }).ok).toBe(true)
    const keys = readKeys(a, layerId)
    expect(keys[0].segment).toEqual({ kind: 'Spline' })
    expect(keys[0].out).toEqual({ x: 0.42, y: 0.001, mode: 'Free' })
    expect(keys[1].in).toEqual({ x: 1, y: 1, mode: 'Free' })
    expect('preset_id' in keys[0]).toBe(false)
  })

  it('raw Bounce and Hold forms are accepted (and reverse-match their table ids)', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    expect(setEasing(a, layerId, kfId, { kind: 'Bounce', dir: 'InOut' }).ok).toBe(true)
    expect(readKeys(a, layerId)[0].preset_id).toBe('ease_in_out_bounce')
    expect(setEasing(a, layerId, kfId, { kind: 'Hold' }).ok).toBe(true)
    expect(readKeys(a, layerId)[0].preset_id).toBe('hold')
  })

  it('every table preset id is accepted end to end and round-trips through readback', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    for (const p of EASING_PRESETS) {
      expect(setEasing(a, layerId, kfId, { preset: p.id }).ok, p.id).toBe(true)
      expect(readKeys(a, layerId)[0].preset_id, p.id).toBe(p.id)
    }
  })

  it('malformed payloads reject with option-bearing messages and leave the key untouched', () => {
    const { a, layerId } = withKeyedOpacity()
    const kfId = readKeys(a, layerId)[0].id
    const cases: Array<[unknown, RegExp]> = [
      [{ preset: 'ease_in_bogus' }, /presets: linear, hold, ease,/], // full id list rides the message
      [{ kind: 'Elastic', dir: 'Out', amplitude: 0.5 }, /amplitude must be >= 1/],
      [{ kind: 'Elastic', dir: 'Out', period: 0 }, /period must be > 0/],
      [{ kind: 'Bezier', p1: [1.5, 0], p2: [0.58, 1] }, /p1\[0\].*within \[0, 1\]/],
      [{ kind: 'EaseIn' }, /"preset":"ease_in"/], // named eases are presets, not kinds
    ]
    for (const [interp, msgRe] of cases) {
      const r = setEasing(a, layerId, kfId, interp)
      expect(r.ok, JSON.stringify(interp)).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('invalid_params')
      expect(r.error.message, JSON.stringify(interp)).toMatch(msgRe)
    }
    // No rejected write may have committed: the key still reads Linear.
    expect(readKeys(a, layerId)[0].segment).toEqual({ kind: 'Linear' })
  })
})
