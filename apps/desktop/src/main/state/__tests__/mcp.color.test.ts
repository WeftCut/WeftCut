// apps/desktop/src/main/state/__tests__/mcp.color.test.ts
// The colour param end to end through actor.mcpCall: `color` is the one key
// whose track carries `{r,g,b,a}` rather than a number, so the whole keyframe
// family has to route it by KEY — the value parser at the edge, the lens at the
// write, the shaper on the way back. These pin that route on both kinds that
// carry a colour, and pin that neither value type can reach the other's param.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'
import { root } from './fixtures/project'
import type { Animated, Rgba } from '../model'

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 }
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 }
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 }

type Side = { x: number; y: number; mode: string }
type KfEntry = {
  id: string
  t_us: number
  t_local_us: number
  value: Rgba
  in: Side
  out: Side
  continuity: string
  segment: Record<string, unknown>
}

/** A layer of `kind` on the A roll, spanning [0, 4 s). Both kinds that carry an
 *  animatable colour, so every assertion below runs against each. */
function withColorLayer(kind: 'text' | 'color') {
  const a = freshActor()
  const addR = a.dispatch('add_layer', { kind, track: aRollId(a), t_start_us: 0, t_end_us: 4_000_000 })
  expect(addR.ok, 'setup add_layer must succeed').toBe(true)
  if (!addR.ok) throw new Error('setup failed')
  return { a, layerId: addR.value as string }
}

function call(a: ReturnType<typeof freshActor>, tool: string, args: Record<string, unknown>) {
  return a.mcpCall(tool, JSON.stringify(args))
}

function setKeyframe(a: ReturnType<typeof freshActor>, layerId: string, tUs: number, value: unknown, paramKey = 'color') {
  return call(a, 'set_keyframe', { layer_id: layerId, param_key: paramKey, t_us: tUs, value })
}

/** The stored (layer-local) colour track, as the engine reads it. */
function storedColor(a: ReturnType<typeof freshActor>, layerId: string): Animated<Rgba> {
  for (const t of root(a.snapshot()).tracks) {
    const l = t.layers.find((x) => x.id === layerId)
    if (l) return (l.params as { color: Animated<Rgba> }).color
  }
  throw new Error('layer not found')
}

function readTrack(a: ReturnType<typeof freshActor>, layerId: string): { mode: string; keyframes?: KfEntry[]; value?: Rgba; extrapolate?: unknown } {
  const r = call(a, 'get_param_track', { layer_id: layerId, param_key: 'color' })
  expect(r.ok, 'get_param_track must succeed').toBe(true)
  if (!r.ok) throw new Error('get_param_track failed')
  return JSON.parse(r.result.content[0].text)
}

function errorMessage(r: ReturnType<ReturnType<typeof freshActor>['mcpCall']>): string {
  expect(r.ok, 'expected a refusal').toBe(false)
  if (r.ok) throw new Error('expected a refusal')
  return r.error.message
}

describe('set_keyframe → get_param_track on a colour param', () => {
  for (const kind of ['text', 'color'] as const) {
    it(`a ${kind} layer takes two colour keys and reads them back as {r,g,b,a}`, () => {
      const { a, layerId } = withColorLayer(kind)
      expect(setKeyframe(a, layerId, 0, RED).ok).toBe(true)
      expect(setKeyframe(a, layerId, 2_000_000, GREEN).ok).toBe(true)
      const track = readTrack(a, layerId)
      expect(track.mode).toBe('Keyframed')
      expect(track.keyframes?.map((k) => k.value)).toEqual([RED, GREEN])
      expect(track.keyframes?.map((k) => k.t_us)).toEqual([0, 2_000_000])
    })
  }

  it('a Static colour track reads back as its one colour value', () => {
    const { a, layerId } = withColorLayer('color')
    expect(readTrack(a, layerId)).toEqual({ mode: 'Static', value: RED })
  })

  it('an update at the same frame replaces the colour in place', () => {
    const { a, layerId } = withColorLayer('color')
    expect(setKeyframe(a, layerId, 0, RED).ok).toBe(true)
    expect(setKeyframe(a, layerId, 2_000_000, GREEN).ok).toBe(true)
    expect(setKeyframe(a, layerId, 2_000_000, BLUE).ok).toBe(true)
    expect(readTrack(a, layerId).keyframes?.map((k) => k.value)).toEqual([RED, BLUE])
  })
})

describe('a value of the wrong type is refused, naming the type the param takes', () => {
  it('a number on `color`', () => {
    const { a, layerId } = withColorLayer('color')
    const msg = errorMessage(setKeyframe(a, layerId, 0, 0.5))
    expect(msg).toContain("param 'color' takes an {r,g,b,a} colour")
    // Refused at the edge, so no track was written.
    expect(storedColor(a, layerId)).toEqual({ mode: 'Static', value: RED })
  })

  it('an {r,g,b,a} colour on `opacity`, with the hint that `color` is the one key taking one', () => {
    const { a, layerId } = withColorLayer('text')
    const msg = errorMessage(setKeyframe(a, layerId, 0, RED, 'opacity'))
    expect(msg).toContain("param 'opacity' takes a number")
    expect(msg).toContain('param_key "color"')
  })

  it('a channel outside 0..255 on `color`', () => {
    const { a, layerId } = withColorLayer('color')
    expect(errorMessage(setKeyframe(a, layerId, 0, { r: 300, g: 0, b: 0, a: 255 }))).toContain('must be an integer 0..255')
  })

  it('a colour key aimed at a kind that carries no colour track', () => {
    const { a, layerId } = withColorLayer('text')
    // A Group layer carries the transform set and nothing else, so `color`
    // resolves to no slot at all rather than to a mis-typed one.
    const grp = a.dispatch('groups_create', { layers: [layerId], label: null })
    expect(grp.ok, 'setup groups_create must succeed').toBe(true)
    if (!grp.ok) throw new Error('setup failed')
    const groupLayerId = (grp.value as { layer_id: string }).layer_id
    expect(errorMessage(setKeyframe(a, groupLayerId, 0, RED))).toBe('UnknownKeyframeParam')
  })
})

describe('the rest of the keyframe family on a colour track', () => {
  /** A two-key red → green colour track on a Color layer. */
  function keyed() {
    const { a, layerId } = withColorLayer('color')
    expect(setKeyframe(a, layerId, 0, RED).ok).toBe(true)
    expect(setKeyframe(a, layerId, 2_000_000, GREEN).ok).toBe(true)
    return { a, layerId }
  }

  it('set_param_track replaces the whole colour track in one commit', () => {
    const { a, layerId } = keyed()
    const track = readTrack(a, layerId)
    const next = {
      mode: 'Keyframed',
      extrapolate: { before: 'Hold', after: 'Loop' },
      value: track.keyframes!.map((k, i) => ({ ...k, value: i === 0 ? BLUE : RED })),
    }
    expect(call(a, 'set_param_track', { layer_id: layerId, param_key: 'color', track: next }).ok).toBe(true)
    const after = readTrack(a, layerId)
    expect(after.keyframes?.map((k) => k.value)).toEqual([BLUE, RED])
    expect(after.extrapolate).toEqual({ before: 'Hold', after: 'Loop' })
  })

  it('set_param_track refuses a numeric value on the colour track', () => {
    const { a, layerId } = keyed()
    const track = readTrack(a, layerId)
    const next = {
      mode: 'Keyframed',
      extrapolate: { before: 'Hold', after: 'Hold' },
      value: track.keyframes!.map((k) => ({ ...k, value: 1 })),
    }
    expect(errorMessage(call(a, 'set_param_track', { layer_id: layerId, param_key: 'color', track: next })))
      .toContain("param 'color' takes an {r,g,b,a} colour")
  })

  it('smooth_keyframes leaves the identity coordinates — a colour has no slope to solve', () => {
    const { a, layerId } = keyed()
    expect(call(a, 'smooth_keyframes', { layer_id: layerId, param_key: 'color' }).ok).toBe(true)
    const keys = readTrack(a, layerId).keyframes!
    // Auto with no scalar projection: the mode is stored, the numbers are the
    // linear parametrisation's own control points, and both segments went Spline
    // so the engine actually reads them.
    expect(keys[0].out).toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Auto' })
    expect(keys[0].continuity).toBe('Smooth')
    expect(keys[0].segment).toEqual({ kind: 'Spline' })
    expect(keys[1].in).toEqual({ x: 2 / 3, y: 2 / 3, mode: 'Auto' })
  })

  it('set_keyframe_tangents writes a Free side on a colour key and splines its segment', () => {
    const { a, layerId } = keyed()
    const kfId = readTrack(a, layerId).keyframes![0].id
    expect(call(a, 'set_keyframe_tangents', { layer_id: layerId, param_key: 'color', keyframe_id: kfId, out: { x: 0.42, y: 0 } }).ok).toBe(true)
    const keys = readTrack(a, layerId).keyframes!
    expect(keys[0].out).toEqual({ x: 0.42, y: 0, mode: 'Free' })
    expect(keys[0].segment).toEqual({ kind: 'Spline' })
  })

  it('set_extrapolation writes both sides of a colour track', () => {
    const { a, layerId } = keyed()
    expect(call(a, 'set_extrapolation', { layer_id: layerId, param_key: 'color', before: 'Offset', after: 'PingPong' }).ok).toBe(true)
    const stored = storedColor(a, layerId)
    expect(stored.mode === 'Keyframed' && stored.extrapolate).toEqual({ before: 'Offset', after: 'PingPong' })
  })

  it('remove_keyframe drops one key; the last one collapses to Static holding its colour', () => {
    const { a, layerId } = keyed()
    const ids = readTrack(a, layerId).keyframes!.map((k) => k.id)
    expect(call(a, 'remove_keyframe', { layer_id: layerId, param_key: 'color', keyframe_id: ids[0] }).ok).toBe(true)
    expect(readTrack(a, layerId).keyframes?.map((k) => k.value)).toEqual([GREEN])
    expect(call(a, 'remove_keyframe', { layer_id: layerId, param_key: 'color', keyframe_id: ids[1] }).ok).toBe(true)
    expect(readTrack(a, layerId)).toEqual({ mode: 'Static', value: GREEN })
  })

  it('clear_keyframes collapses to the first key\'s colour, or to the one given', () => {
    const { a, layerId } = keyed()
    expect(call(a, 'clear_keyframes', { layer_id: layerId, param_key: 'color' }).ok).toBe(true)
    expect(readTrack(a, layerId)).toEqual({ mode: 'Static', value: RED })

    const second = keyed()
    expect(call(second.a, 'clear_keyframes', { layer_id: second.layerId, param_key: 'color', value: BLUE }).ok).toBe(true)
    expect(readTrack(second.a, second.layerId)).toEqual({ mode: 'Static', value: BLUE })
  })

  it('clear_keyframes refuses a numeric collapse value on a colour param', () => {
    const { a, layerId } = keyed()
    expect(errorMessage(call(a, 'clear_keyframes', { layer_id: layerId, param_key: 'color', value: 1 })))
      .toContain("param 'color' takes an {r,g,b,a} colour")
  })

  it('retime_keyframe moves a colour key and re-sorts', () => {
    const { a, layerId } = keyed()
    const ids = readTrack(a, layerId).keyframes!.map((k) => k.id)
    expect(call(a, 'retime_keyframe', { layer_id: layerId, param_key: 'color', keyframe_id: ids[0], t_us: 3_000_000 }).ok).toBe(true)
    expect(readTrack(a, layerId).keyframes?.map((k) => k.value)).toEqual([GREEN, RED])
  })
})
