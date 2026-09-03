// apps/desktop/src/main/state/__tests__/mcp.easing.test.ts
// The keyframe-shape writers end to end through actor.mcpCall, read back with
// get_param_track: set_keyframe_easing (presets bake to the canonical table
// params in state and the exact-match reverse lookup surfaces the id),
// set_keyframe_tangents (a side lands Free with the numbers sent, the segment
// it shapes goes Spline, Smooth re-derives `in` from `out`) and
// set_extrapolation (the stored track evaluates past its last key through the
// shared engine). The parser-level rejection matrix lives in
// mcp.validators.test.ts; the rejection cases here additionally pin that a
// rejected write leaves the key untouched.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'
import { root } from './fixtures/project'
import { EASING_PRESETS } from '../../../shared/easing'
import { resolveAnimated } from '../../../renderer/render/animated'
import type { Animated } from '../model'

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

/** Text layer on the A roll with Linear opacity keys at the given (t, value)
 *  points — two by default (t=0 → 0 and t=2s → 1). */
function withKeyedOpacity(points: ReadonlyArray<readonly [number, number]> = [[0, 0], [2_000_000, 1]]) {
  const a = freshActor()
  const addR = a.dispatch('add_layer', { kind: 'text', track: aRollId(a), t_start_us: 0, t_end_us: 4_000_000 })
  expect(addR.ok, 'setup add_layer must succeed').toBe(true)
  if (!addR.ok) throw new Error('setup failed')
  const layerId = addR.value as string
  for (const [t, v] of points) {
    const r = a.mcpCall('set_keyframe', JSON.stringify({ layer_id: layerId, param_key: 'opacity', t_us: t, value: v }))
    expect(r.ok, 'setup set_keyframe must succeed').toBe(true)
  }
  return { a, layerId }
}

/** The stored (layer-local) opacity track, as the engine reads it. */
function storedOpacity(a: ReturnType<typeof freshActor>, layerId: string): Animated<number> {
  for (const t of root(a.snapshot()).tracks) {
    const l = t.layers.find((x) => x.id === layerId)
    if (l) return (l.params as { opacity: Animated<number> }).opacity
  }
  throw new Error('layer not found')
}

function setTangents(a: ReturnType<typeof freshActor>, layerId: string, keyframeId: string, args: Record<string, unknown>) {
  return a.mcpCall('set_keyframe_tangents', JSON.stringify({ layer_id: layerId, param_key: 'opacity', keyframe_id: keyframeId, ...args }))
}

function setExtrapolationCall(a: ReturnType<typeof freshActor>, layerId: string, args: Record<string, unknown>) {
  return a.mcpCall('set_extrapolation', JSON.stringify({ layer_id: layerId, param_key: 'opacity', ...args }))
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

describe('set_keyframe_tangents → get_param_track (per-side writes)', () => {
  it('a provided side reads back Free with the numbers sent, and the segment it shapes becomes Spline', () => {
    const { a, layerId } = withKeyedOpacity()
    const [k0, k1] = readKeys(a, layerId)
    // `out` on the first key shapes the segment leaving it: Linear → Spline.
    expect(setTangents(a, layerId, k0.id, { out: { x: 0.42, y: 0 } }).ok).toBe(true)
    let keys = readKeys(a, layerId)
    expect(keys[0].out).toEqual({ x: 0.42, y: 0, mode: 'Free' })
    expect(keys[0].segment).toEqual({ kind: 'Spline' })
    expect(keys[1].in).toEqual({ x: 2 / 3, y: 2 / 3, mode: 'Free' }) // the other end untouched
    expect('preset_id' in keys[0]).toBe(false) // half a preset is no preset
    // `in` on the second key shapes the SAME segment (its left key is k0); with
    // both ends written the pair is exactly the ease_in_out table entry.
    expect(setTangents(a, layerId, k1.id, { in: { x: 0.58, y: 1 } }).ok).toBe(true)
    keys = readKeys(a, layerId)
    expect(keys[1].in).toEqual({ x: 0.58, y: 1, mode: 'Free' })
    expect(keys[0].preset_id).toBe('ease_in_out')
  })

  it('writing a side of an Auto key frees the whole key; the other side keeps its solved numbers, mode Free', () => {
    const { a, layerId } = withKeyedOpacity([[0, 0], [1_000_000, 0.5], [2_000_000, 1]])
    expect(a.mcpCall('smooth_keyframes', JSON.stringify({ layer_id: layerId, param_key: 'opacity' })).ok).toBe(true)
    const mid = readKeys(a, layerId)[1]
    expect(mid.in.mode).toBe('Auto')
    expect(mid.out.mode).toBe('Auto')
    expect(setTangents(a, layerId, mid.id, { out: { x: 0.5, y: 0.5 } }).ok).toBe(true)
    const keys = readKeys(a, layerId)
    expect(keys[1].out).toEqual({ x: 0.5, y: 0.5, mode: 'Free' })
    expect(keys[1].in.mode).toBe('Free')
    expect(keys[1].in.x).toBe(2 / 3)
    // Smooth (set by smooth_keyframes) re-derives in.y from the written out:
    // the same slope, over the arriving segment — here 2/3 again.
    expect(keys[1].in.y).toBeCloseTo(2 / 3, 9)
    expect(keys[1].continuity).toBe('Smooth')
    // Only the written key changed mode.
    expect(keys[0].out.mode).toBe('Auto')
    expect(keys[2].in.mode).toBe('Auto')
  })

  it("continuity 'Smooth' re-derives `in` from `out` in the same write (out wins); 'Broken' changes no number", () => {
    const { a, layerId } = withKeyedOpacity([[0, 0], [1_000_000, 0.5], [2_000_000, 1]])
    const mid = readKeys(a, layerId)[1]
    expect(setTangents(a, layerId, mid.id, { in: { x: 0.8, y: 0.2 }, out: { x: 0.5, y: 0.5 }, continuity: 'Smooth' }).ok).toBe(true)
    let keys = readKeys(a, layerId)
    expect(keys[1].out).toEqual({ x: 0.5, y: 0.5, mode: 'Free' })
    // out's slope over the leaving segment, re-aimed onto the arriving one with
    // in.x kept: in.y = 1 − m·(1 − 0.8)·Δt / Δv = 0.8, not the 0.2 that was sent.
    expect(keys[1].in.x).toBe(0.8)
    expect(keys[1].in.y).toBeCloseTo(0.8, 10)
    expect(keys[1].in.mode).toBe('Free')
    expect(keys[1].continuity).toBe('Smooth')
    // Both adjacent segments were splined by the sides that shape them.
    expect(keys[0].segment).toEqual({ kind: 'Spline' })
    expect(keys[1].segment).toEqual({ kind: 'Spline' })
    const before = keys[1]
    expect(setTangents(a, layerId, mid.id, { continuity: 'Broken' }).ok).toBe(true)
    keys = readKeys(a, layerId)
    expect(keys[1].continuity).toBe('Broken')
    expect(keys[1].in).toEqual(before.in)
    expect(keys[1].out).toEqual(before.out)
  })

  it('rejects with option-bearing messages and leaves the key untouched: x outside [0, 1] (never clamped), nothing to write, a bad continuity, an unknown key', () => {
    const { a, layerId } = withKeyedOpacity()
    const k0 = readKeys(a, layerId)[0]
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [k0.id, { out: { x: 1.2, y: 0 } }, /out\.x is 1\.2 — .*within \[0, 1\]/],
      [k0.id, { in: { x: 0.5 } }, /in\.y must be a finite number/],
      [k0.id, {}, /at least one of in, out, continuity/],
      [k0.id, { continuity: 'Kinked' }, /continuity must be 'Smooth' \| 'Broken', got Kinked/],
      ['00000000-0000-7000-8000-0000000000ff', { out: { x: 0.5, y: 0.5 } }, /keyframe 00000000-0000-7000-8000-0000000000ff not found/],
    ]
    for (const [id, args, msgRe] of cases) {
      const r = setTangents(a, layerId, id, args)
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('invalid_params')
      expect(r.error.message, JSON.stringify(args)).toMatch(msgRe)
    }
    const after = readKeys(a, layerId)[0]
    expect(after.segment).toEqual({ kind: 'Linear' })
    expect(after.out).toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Free' })
  })
})

describe('set_extrapolation → get_param_track → the shared engine', () => {
  it('writes one side and keeps the other; both read back on get_param_track', () => {
    const { a, layerId } = withKeyedOpacity()
    const read = () => (JSON.parse((a.mcpCall('get_param_track', JSON.stringify({ layer_id: layerId, param_key: 'opacity' })) as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text) as { extrapolate: { before: string; after: string } }).extrapolate
    expect(read()).toEqual({ before: 'Hold', after: 'Hold' })
    expect(setExtrapolationCall(a, layerId, { after: 'Loop' }).ok).toBe(true)
    expect(read()).toEqual({ before: 'Hold', after: 'Loop' })
    expect(setExtrapolationCall(a, layerId, { before: 'PingPong' }).ok).toBe(true)
    expect(read()).toEqual({ before: 'PingPong', after: 'Loop' })
    expect(setExtrapolationCall(a, layerId, { before: 'Hold', after: 'Continue' }).ok).toBe(true)
    expect(read()).toEqual({ before: 'Hold', after: 'Continue' })
  })

  it('past the last key the stored track follows the mode: Hold clamps, Loop repeats the cycle, PingPong runs it backwards', () => {
    // 0 → 1 over [0, 2s], Linear. 3.5 s is 1.5 s into the second cycle.
    const { a, layerId } = withKeyedOpacity()
    const at = (tUs: number) => resolveAnimated(storedOpacity(a, layerId), tUs, -1)
    expect(at(3_500_000)).toBe(1) // Hold / Hold: the clamped last value
    expect(setExtrapolationCall(a, layerId, { after: 'Loop' }).ok).toBe(true)
    expect(at(3_500_000)).toBeCloseTo(0.75, 9) // value at 1.5 s of the cycle
    expect(setExtrapolationCall(a, layerId, { after: 'PingPong' }).ok).toBe(true)
    expect(at(3_500_000)).toBeCloseTo(0.25, 9) // odd cycle mirrored: value at 0.5 s
    // Inside the key range nothing changed.
    expect(at(1_000_000)).toBeCloseTo(0.5, 9)
  })

  it('refuses a Static track naming the fix, an unknown mode naming the five, and an empty patch', () => {
    const { a, layerId } = withKeyedOpacity()
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['x', { after: 'Loop' }, /param 'x' on layer .* is Static — extrapolation applies to a keyframed track; add keys first \(set_keyframe\)/],
      ['opacity', { after: 'Cycle' }, /after must be one of 'Hold' \| 'Loop' \| 'PingPong' \| 'Offset' \| 'Continue', got Cycle/],
      ['opacity', {}, /at least one of before, after \(each 'Hold' \| 'Loop' \| 'PingPong' \| 'Offset' \| 'Continue'\)/],
    ]
    for (const [paramKey, args, msgRe] of cases) {
      const r = a.mcpCall('set_extrapolation', JSON.stringify({ layer_id: layerId, param_key: paramKey, ...args }))
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('invalid_params')
      expect(r.error.message, JSON.stringify(args)).toMatch(msgRe)
    }
    expect(storedOpacity(a, layerId)).toMatchObject({ extrapolate: { before: 'Hold', after: 'Hold' } })
  })
})
