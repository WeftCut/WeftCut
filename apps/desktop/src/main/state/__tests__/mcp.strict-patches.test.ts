// apps/desktop/src/main/state/__tests__/mcp.strict-patches.test.ts
// The parse boundary enforces KEY SETS, not just "is an object", because the
// worst answer a tool can give is success for nothing done: a typo such as
// `update_layer_params { patch: { kind: 'Color', opacityy: 0.2 } }`, an
// `rename_layer` key the tool does not take, an `add_effect` kind no catalog
// knows (`audio.compressor`, `""`), an `update_effect` param outside its range
// (`wobble`, `strength: 500`). Every one is a refusal that names the accepted
// set, before any write.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'
import { root } from './fixtures/project'
import { parseLayerParamsPatch, parseEffectKind, checkEffectPatchAgainst, McpArgError, LAYER_PARAM_KINDS } from '../mcp-commands'
import { EFFECT_KINDS } from '../../../shared/effects/params'

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
function colorLayer(a: Actor): string {
  return (ok(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'color', color: { r: 1, g: 2, b: 3, a: 255 } } }] })).layers as Array<{ layer_id: string }>)[0]!.layer_id as string
}
function textLayer(a: Actor): string {
  return (ok(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'text', content: 'hi' } }] })).layers as Array<{ layer_id: string }>)[0]!.layer_id as string
}
const layerOf = (a: Actor, id: string) => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!

describe('update_layer_params — unknown keys are refused, naming the kind\'s set', () => {
  it('a typo commits nothing and is REFUSED, not reported as success', () => {
    const a = freshActor()
    const id = colorLayer(a)
    const before = a.historyStatus().len
    const msg = refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', opacityy: 0.2 } }))
    expect(msg).toContain("'opacityy'")
    expect(msg).toContain('Color patch writes color, width, height')
    expect(a.historyStatus().len).toBe(before) // nothing recorded
  })

  it('a key that belongs to another kind says which one', () => {
    const a = freshActor()
    const id = colorLayer(a)
    const msg = refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', gain_db: -3 } }))
    expect(msg).toMatch(/'gain_db' belongs to Audio/)
  })

  it('an envelope field points at the tool that owns it', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', enabled: false } }))).toMatch(/set_layer_flags/)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', t_start_us: 0 } }))).toMatch(/move_layers/)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', label: 'x' } }))).toMatch(/rename_layer/)
  })

  it('a patch with only `kind` is refused: it would report success having changed nothing', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color' } }))).toMatch(/names no field/)
  })

  it('a missing or unknown kind names the seven kinds', () => {
    const a = freshActor()
    const id = colorLayer(a)
    const msg = refusal(call(a, 'update_layer_params', { layer_id: id, patch: { color: { r: 0, g: 0, b: 0, a: 255 } } }))
    for (const k of LAYER_PARAM_KINDS) expect(msg).toContain(k)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Colour', color: { r: 0, g: 0, b: 0, a: 255 } } }))).toContain('Colour')
  })

  it('null is not a value for a field that does not take one — omit it instead', () => {
    const a = freshActor()
    const id = textLayer(a)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', opacity: null } }))).toMatch(/omit/)
    // …but the box pair takes null, because null MEANS "back to auto" there.
    ok(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', box_w: 400, box_h: null } }))
  })

  it('values are type-gated at the boundary, with the field named', () => {
    const a = freshActor()
    const id = textLayer(a)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', content: 5 } }))).toContain('patch.content')
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', align: 'Centre' } }))).toMatch(/Left \| Center \| Right/)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', color: '#fff' } }))).toContain('{r,g,b,a}')
  })

  it('Text outline is advertised and writable', () => {
    const a = freshActor()
    const id = textLayer(a)
    ok(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', outline_width: 3, outline_color: { r: 255, g: 0, b: 0, a: 255 } } }))
    const p = layerOf(a, id).params as { outline: { width: number; color: { r: number } } | null }
    expect(p.outline).toEqual({ width: 3, color: { r: 255, g: 0, b: 0, a: 255 } })
  })

  it('Motif and CompositionRef are kinds the parser knows', () => {
    expect(parseLayerParamsPatch({ kind: 'Motif', props: { title: 'x' } })).toEqual({ kind: 'Motif', props: { title: 'x' } })
    expect(parseLayerParamsPatch({ kind: 'CompositionRef', opacity: 0.5 })).toEqual({ kind: 'CompositionRef', opacity: 0.5 })
  })

  it('refuses blend_mode on every kind: no layer takes one until a renderer draws it', () => {
    for (const kind of ['CompositionRef', 'VideoClip', 'Text']) {
      expect(() => parseLayerParamsPatch({ kind, blend_mode: 'Multiply' })).toThrow(/'blend_mode' is not a .* param.*every layer composites Normal/)
    }
  })

  it('a well-formed patch still applies', () => {
    const a = freshActor()
    const id = colorLayer(a)
    ok(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', color: { r: 9, g: 8, b: 7, a: 255 }, width: 100 } }))
    const p = layerOf(a, id).params as { color: { value: { r: number } }; width: number }
    expect(p.color.value.r).toBe(9)
    expect(p.width).toBe(100)
  })
})

describe('rename_layer / set_layer_flags — the envelope, and only the envelope', () => {
  it('rename_layer refuses `enabled`, pointing at set_layer_flags, and leaves the flag alone', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'rename_layer', { layer_id: id, label: 'x', enabled: false }))).toMatch(/set_layer_flags/)
    expect(layerOf(a, id).enabled).toBe(true)
  })

  it('refuses a param key, pointing at update_layer_params', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'set_layer_flags', { layer_ids: [id], locked: true, opacity: 0.5 }))).toMatch(/update_layer_params/)
    expect(layerOf(a, id).locked).toBe(false)
  })

  it('type-gates the fields and refuses a call naming none', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'rename_layer', { layer_id: id, label: 3 }))).toMatch(/label/)
    expect(refusal(call(a, 'set_layer_flags', { layer_ids: [id], locked: 'yes' }))).toMatch(/locked/)
    expect(refusal(call(a, 'set_layer_flags', { layer_ids: [id] }))).toMatch(/at least one/)
  })

  it('the times are neither tool\'s: the refusal names move_layers and trim_layer (T1)', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'rename_layer', { layer_id: id, label: 'x', t_start_us: 1_000_000 }))).toMatch(/move_layers/)
    expect(refusal(call(a, 'rename_layer', { layer_id: id, label: 'x', t_end_us: 1_000_000 }))).toMatch(/trim_layer/)
  })

  it('label: null clears the name (T2)', () => {
    const a = freshActor()
    const id = colorLayer(a)
    ok(call(a, 'rename_layer', { layer_id: id, label: 'slate' }))
    ok(call(a, 'rename_layer', { layer_id: id, label: null }))
    expect(layerOf(a, id).label).toBeNull()
  })

  it('a well-formed call still applies', () => {
    const a = freshActor()
    const id = colorLayer(a)
    ok(call(a, 'rename_layer', { layer_id: id, label: 'slate' }))
    ok(call(a, 'set_layer_flags', { layer_ids: [id], locked: true }))
    expect(layerOf(a, id)).toMatchObject({ label: 'slate', locked: true })
  })
})

describe('add_effect — the kind is one of the catalog\'s', () => {
  it('refuses an empty, unknown or invented audio kind, naming the catalog', () => {
    const a = freshActor()
    const id = colorLayer(a)
    for (const kind of ['', 'wobble', 'audio.compressor']) {
      const msg = refusal(call(a, 'add_effect', { layer_id: id, kind }))
      expect(msg).toContain(`'${kind}'`) // the value sent, not its type
      for (const k of EFFECT_KINDS) expect(msg).toContain(k)
    }
    expect(layerOf(a, id).effects).toEqual([])
  })

  it('parseEffectKind mirrors the advertised enum', () => {
    for (const k of EFFECT_KINDS) expect(parseEffectKind(k)).toBe(k)
    expect(() => parseEffectKind('Blur')).toThrow(McpArgError)
  })
})

describe('update_effect — params are the kind\'s, inside its range', () => {
  function blurred(a: Actor): { layerId: string; effectId: string } {
    const layerId = colorLayer(a)
    const effectId = ok(call(a, 'add_effect', { layer_id: layerId, kind: 'blur' })).effect_id as string
    return { layerId, effectId }
  }

  it('an unknown param key is refused naming the kind\'s params, and nothing is stored', () => {
    const a = freshActor()
    const { layerId, effectId } = blurred(a)
    const msg = refusal(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { wobble: 1 } } }))
    expect(msg).toContain("'wobble'")
    expect(msg).toContain('strength')
    expect(layerOf(a, layerId).effects[0].params).toEqual({})
  })

  it('a value outside the range is refused naming the bound', () => {
    const a = freshActor()
    const { layerId, effectId } = blurred(a)
    const msg = refusal(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { strength: 500 } } }))
    expect(msg).toContain('[0, 100]')
    expect(layerOf(a, layerId).effects[0].params).toEqual({})
  })

  it('an in-range write and a removal land', () => {
    const a = freshActor()
    const { layerId, effectId } = blurred(a)
    ok(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { strength: 12 } } }))
    expect(layerOf(a, layerId).effects[0].params.strength).toEqual({ mode: 'Static', value: 12 })
    ok(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { strength: null } } }))
    expect(layerOf(a, layerId).effects[0].params).toEqual({})
  })

  it('checkEffectPatchAgainst stays permissive for a kind no catalog knows (ADR 0027)', () => {
    expect(() => checkEffectPatchAgainst('from-a-newer-build', { params: { anything: { mode: 'Static', value: 1e9 } } })).not.toThrow()
    expect(() => checkEffectPatchAgainst('audio.denoise', { params: { strength: { mode: 'Static', value: 41 } } })).toThrow(/\[1, 40\]/)
    expect(() => checkEffectPatchAgainst('audio.denoise', { params: { profile_in_us: null } })).not.toThrow()
  })
})

describe('keyframe writers — one range, one easing rule', () => {
  /** A title with a blur whose `strength` was never written: it reads as its
   *  catalog default, and is keyframable as it stands. */
  function blurredTitle(a: Actor): { layer: string; key: string } {
    const layer = (ok(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'text', content: 'Title' } }] })).layers as Array<{ layer_id: string }>)[0]!.layer_id as string
    const effect = ok(call(a, 'add_effect', { layer_id: layer, kind: 'blur' })).effect_id as string
    return { layer, key: `effects[${effect}].params[strength]` }
  }

  it('an effect param outside its range is refused by set_keyframe, as update_effect refuses it', () => {
    // One param, two writers: a range the patch enforces and the keyframe does
    // not would let an agent store through the door that does not look.
    const a = freshActor()
    const { layer, key } = blurredTitle(a)
    expect(refusal(call(a, 'set_keyframe', { layer_id: layer, param_key: key, t_us: 0, value: 500 }))).toContain('[0, 100]')
    expect(refusal(call(a, 'set_param_track', { layer_id: layer, param_key: key, track: { mode: 'Static', value: 500 } }))).toContain('[0, 100]')
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: key, t_us: 0, value: 40 }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: key, t_us: 1_000_000, value: 60 }))
    // The documented round trip — read the track, edit it, send it back — is
    // held to the same range as the key-at-a-time writer.
    const { track } = ok(call(a, 'get_param_track', { layer_id: layer, param_key: key })) as { track: { value: Array<Record<string, unknown>> } }
    const edited = { ...track, value: track.value.map((k, i) => (i === 1 ? { ...k, value: 500 } : k)) }
    expect(refusal(call(a, 'set_param_track', { layer_id: layer, param_key: key, track: edited }))).toContain('[0, 100]')
  })

  it('a Bezier on a lone key is refused (no segment); authored in time order, each key eases the move into it', () => {
    // Its p2 is stored on the key the segment arrives at; a lone key has no
    // segment at all, so the call would drop it under a success report.
    const a = freshActor()
    const layer = (ok(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'text', content: 'Title' } }] })).layers as Array<{ layer_id: string }>)[0]!.layer_id as string
    const bezier = { kind: 'Bezier', p1: [0.4, 0], p2: [0.2, 0.9] }
    expect(refusal(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 0, value: 1, easing: bezier }))).toMatch(/one key, which has no segment to ease/)
    expect(refusal(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 0, value: 1, interp: bezier }))).toMatch(/takes no `interp` — the easing is `easing`/)
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 0, value: 1 }))
    ok(call(a, 'set_keyframe', { layer_id: layer, param_key: 'opacity', t_us: 1_000_000, value: 0, easing: bezier }))
    const read = ok(call(a, 'get_param_track', { layer_id: layer, param_key: 'opacity' })) as { track: { value: Array<{ out: unknown; in: unknown }> } }
    expect(read.track.value[0]!.out).toEqual({ x: 0.4, y: 0, mode: 'Free' })
    expect(read.track.value[1]!.in).toEqual({ x: 0.2, y: 0.9, mode: 'Free' })
  })
})

describe('set_position — typed and gated', () => {
  it('refuses a malformed position at the boundary with the shared validator\'s sentence', () => {
    const a = freshActor()
    const id = textLayer(a)
    expect(refusal(call(a, 'set_position', { layer_id: id, position: { mode: 'Path', path: { nodes: [] }, progress: { mode: 'Static', value: 0 } } }))).toMatch(/1–128 nodes/)
    expect(refusal(call(a, 'set_position', { layer_id: id, position: 'x' }))).toContain('position')
  })

  it('a well-formed XY position applies', () => {
    const a = freshActor()
    const id = textLayer(a)
    ok(call(a, 'set_position', { layer_id: id, position: { mode: 'XY', x: { mode: 'Static', value: 10 }, y: { mode: 'Static', value: 20 } } }))
    const p = layerOf(a, id).params as { transform: { position: { x: { value: number } } } }
    expect(p.transform.position.x.value).toBe(10)
  })
})
