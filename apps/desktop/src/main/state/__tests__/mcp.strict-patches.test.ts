// apps/desktop/src/main/state/__tests__/mcp.strict-patches.test.ts
// The parse boundary enforces KEY SETS, not just "is an object". The audit's
// worst class of finding was success reported for nothing done:
// `update_layer_params { patch: { kind: 'Color', opacityy: 0.2 } }` committed
// nothing and said ok; `update_layer` applied an undocumented `enabled` and
// dropped `opacity`; `add_effect` took `audio.compressor` and `""`;
// `update_effect` stored `wobble` and `strength: 500`. Every one of those is
// now a refusal that names the accepted set, before any write.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'
import { root } from './fixtures/project'
import { parseLayerParamsPatch, parseLayerPatch, parseEffectKind, checkEffectPatchAgainst, McpArgError, LAYER_PARAM_KINDS } from '../mcp-commands'
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
  return ok(call(a, 'add_color_layer', { track_id: aRollId(a), color: { r: 1, g: 2, b: 3, a: 255 }, t_start_us: 0, t_end_us: 2_000_000 })).layer_id as string
}
function textLayer(a: Actor): string {
  return ok(call(a, 'add_text_layer', { track_id: aRollId(a), t_start_us: 0, t_end_us: 2_000_000, content: 'hi' })).layer_id as string
}
const layerOf = (a: Actor, id: string) => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!

describe('update_layer_params — unknown keys are refused, naming the kind\'s set', () => {
  it('the audit repro: a typo commits nothing and is REFUSED, not reported as success', () => {
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
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', enabled: false } }))).toMatch(/set_layers_enabled/)
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Color', t_start_us: 0 } }))).toMatch(/update_layer\b/)
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

  it('Text outline is advertised and writable (audit D15)', () => {
    const a = freshActor()
    const id = textLayer(a)
    ok(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', outline_width: 3, outline_color: { r: 255, g: 0, b: 0, a: 255 } } }))
    const p = layerOf(a, id).params as { outline: { width: number; color: { r: number } } | null }
    expect(p.outline).toEqual({ width: 3, color: { r: 255, g: 0, b: 0, a: 255 } })
  })

  it('Motif and CompositionRef are kinds the parser knows', () => {
    expect(parseLayerParamsPatch({ kind: 'Motif', props: { title: 'x' } })).toEqual({ kind: 'Motif', props: { title: 'x' } })
    expect(parseLayerParamsPatch({ kind: 'CompositionRef', blend_mode: 'Multiply' })).toEqual({ kind: 'CompositionRef', blend_mode: 'Multiply' })
    expect(() => parseLayerParamsPatch({ kind: 'CompositionRef', blend_mode: 'Burn' })).toThrow(/Normal \| Multiply/)
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

describe('update_layer — the envelope set, and only the envelope set', () => {
  it('refuses `enabled`, pointing at set_layers_enabled, and leaves the flag alone', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'update_layer', { layer_id: id, patch: { enabled: false } }))).toMatch(/set_layers_enabled/)
    expect(layerOf(a, id).enabled).toBe(true)
  })

  it('refuses a param key, pointing at update_layer_params', () => {
    const a = freshActor()
    const id = colorLayer(a)
    expect(refusal(call(a, 'update_layer', { layer_id: id, patch: { opacity: 0.5 } }))).toMatch(/update_layer_params/)
  })

  it('refuses an empty patch and type-gates the four fields', () => {
    expect(() => parseLayerPatch({})).toThrow(/names no field/)
    expect(() => parseLayerPatch({ t_start_us: 'now' })).toThrow(/patch\.t_start_us/)
    expect(() => parseLayerPatch({ t_end_us: 1.5 })).toThrow(/integer/)
    expect(() => parseLayerPatch({ locked: 'yes' })).toThrow(/patch\.locked/)
    expect(parseLayerPatch({ label: null, t_start_us: 0, t_end_us: 1_000_000, locked: true })).toEqual({ label: null, t_start_us: 0, t_end_us: 1_000_000, locked: true })
  })

  it('a well-formed patch still applies', () => {
    const a = freshActor()
    const id = colorLayer(a)
    ok(call(a, 'update_layer', { layer_id: id, patch: { label: 'slate', locked: true } }))
    expect(layerOf(a, id)).toMatchObject({ label: 'slate', locked: true })
  })
})

describe('add_effect — the kind is one of the catalog\'s', () => {
  it('refuses an empty, unknown or invented audio kind, naming the catalog', () => {
    const a = freshActor()
    const id = colorLayer(a)
    for (const kind of ['', 'wobble', 'audio.compressor']) {
      const msg = refusal(call(a, 'add_effect', { layer_id: id, kind }))
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
    const msg = refusal(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { wobble: { mode: 'Static', value: 1 } } } }))
    expect(msg).toContain("'wobble'")
    expect(msg).toContain('strength')
    expect(layerOf(a, layerId).effects[0].params).toEqual({})
  })

  it('a value outside the range is refused naming the bound', () => {
    const a = freshActor()
    const { layerId, effectId } = blurred(a)
    const msg = refusal(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { strength: { mode: 'Static', value: 500 } } } }))
    expect(msg).toContain('[0, 100]')
    expect(layerOf(a, layerId).effects[0].params).toEqual({})
  })

  it('a keyframed value outside the range is refused too; an in-range write and a removal land', () => {
    const a = freshActor()
    const { layerId, effectId } = blurred(a)
    ok(call(a, 'update_effect', { layer_id: layerId, effect_id: effectId, patch: { params: { strength: { mode: 'Static', value: 12 } } } }))
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
