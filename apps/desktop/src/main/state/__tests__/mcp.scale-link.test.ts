// MCP surface of the Linked scale (CONTEXT): `update_layer_params
// { scale_linked }` links through the SAME relink mutation as the UI chain
// (snap + flag, one commit), and while linked a write to one scale axis writes
// both — on update_layer_params and on the keyframe tools alike, the UI
// fan-out's rule. Asserted through mcpCall per the emit-smoke-tests house rule
// — invoke the real tool, don't string-match schemas.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'
import { layerParamsView } from '../summary'
import type { Animated, Transform } from '../model'
import { root } from './fixtures/project'

// Factory, not a shared literal: a dispatched track object gets frozen by the
// actor's immer produce, so reusing one instance across dispatches throws.
const KF = () => ({ mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [{ id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 2, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } }] })

type Actor = ReturnType<typeof freshActor>
const call = (a: Actor, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const answer = (r: ReturnType<Actor['mcpCall']>): Record<string, unknown> => {
  if (!r.ok) throw new Error(`refused: ${r.error.message}`)
  return r.result.structuredContent as Record<string, unknown>
}
const refusal = (r: ReturnType<Actor['mcpCall']>): string => {
  if (r.ok) throw new Error('expected a refusal')
  return r.error.message
}

function addTextLayer(a: Actor): string {
  const r = a.dispatch('add_layer', { track: bRollId(a), kind: 'text', t_start_us: 0, t_end_us: 2_000_000 })
  expect(r.ok).toBe(true)
  return (r as { ok: true; value: string }).value
}
/** A Group layer: a visual kind whose patch writes the scale pair. */
function addGroupLayer(a: Actor): string {
  const add = answer(call(a, 'add_layers', { layers: [{ track_id: aRollId(a), t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'color', color: { r: 1, g: 2, b: 3, a: 255 } } }] }))
  const inner = (add.layers as Array<{ layer_id: string }>)[0]!.layer_id
  return answer(call(a, 'create_group', { layer_ids: [inner] })).layer_id as string
}
const transformOf = (a: Actor, id: string): Transform => {
  for (const t of root(a.snapshot()).tracks) {
    const l = t.layers.find((x) => x.id === id)
    if (l) return (l.params as { transform: Transform }).transform
  }
  throw new Error('layer not found')
}
const shape = (t: Animated<number>) => (t.mode === 'Static' ? t : { ...t, value: t.value.map(({ id: _id, ...k }) => k) })

describe('MCP linked scale', () => {
  it('scale_linked: true on a diverged layer snaps scale_y := scale_x in ONE commit (one undo restores both)', () => {
    const a = freshActor()
    const id = addGroupLayer(a)
    expect(a.dispatch('update_layer_param_track', { layer: id, param_key: 'scale_x', track: KF() }).ok).toBe(true)
    expect(transformOf(a, id).scale_linked).toBe(false) // divergent write auto-unlinked
    const before = JSON.stringify(a.snapshot())

    const r = answer(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'CompositionRef', scale_linked: true } }))
    const t = transformOf(a, id)
    expect(t.scale_linked).toBe(true)
    expect(shape(t.scale_y)).toEqual(shape(t.scale_x))
    expect((r.params as Record<string, unknown>).scale_linked).toBe(true)

    expect(a.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(a.snapshot())).toBe(before)
  })

  it('while linked, one axis sent writes both and the link holds; the answer carries both', () => {
    const a = freshActor()
    const id = addGroupLayer(a)
    expect(transformOf(a, id).scale_linked).toBe(true)
    const r = answer(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'CompositionRef', scale_x: 1.5 } }))
    expect(r.params).toEqual({ scale_x: 1.5, scale_y: 1.5, scale_linked: true })
    const t = transformOf(a, id)
    expect([t.scale_x, t.scale_y, t.scale_linked]).toEqual([{ mode: 'Static', value: 1.5 }, { mode: 'Static', value: 1.5 }, true])
  })

  it('scale_linked: false unlinks first, so the axis lands alone; two unequal axes with true refuse', () => {
    const a = freshActor()
    const id = addGroupLayer(a)
    answer(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'CompositionRef', scale_x: 2, scale_linked: false } }))
    const t = transformOf(a, id)
    expect([t.scale_x, t.scale_y, t.scale_linked]).toEqual([{ mode: 'Static', value: 2 }, { mode: 'Static', value: 1 }, false])
    expect(refusal(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'CompositionRef', scale_x: 2, scale_y: 3, scale_linked: true } }))).toMatch(/two scales for one link/)
  })

  it('a keyframe tool writing one axis of a linked layer writes the twin too, and the link holds', () => {
    const a = freshActor()
    const id = addGroupLayer(a)
    expect(call(a, 'set_keyframe', { layer_id: id, param_key: 'scale_x', t_us: 0, value: 1 }).ok).toBe(true)
    expect(call(a, 'set_keyframe', { layer_id: id, param_key: 'scale_x', t_us: 1_000_000, value: 2, easing: { preset: 'ease_out' } }).ok).toBe(true)
    const t = transformOf(a, id)
    expect(t.scale_linked).toBe(true)
    expect(t.scale_y.mode).toBe('Keyframed')
    expect(shape(t.scale_y)).toEqual(shape(t.scale_x))
  })

  it('Text takes no scale_linked in its patch, and a static Text scale other than 1 is refused on both paths (ADR 0049)', () => {
    const a = freshActor()
    const text = addTextLayer(a)
    expect(refusal(call(a, 'update_layer_params', { layer_id: text, patch: { kind: 'Text', scale_linked: false } }))).toMatch(/ADR 0049/)
    expect(refusal(call(a, 'update_layer_params', { layer_id: text, patch: { kind: 'Text', scale_x: 2 } }))).toMatch(/ADR 0049/)
    expect(refusal(call(a, 'set_param_track', { layer_id: text, param_key: 'scale_x', track: { mode: 'Static', value: 2 } }))).toMatch(/ADR 0049/)
    expect(call(a, 'set_param_track', { layer_id: text, param_key: 'scale_x', track: { mode: 'Static', value: 1 } }).ok).toBe(true)
    expect(call(a, 'set_keyframe', { layer_id: text, param_key: 'scale_x', t_us: 0, value: 1.2 }).ok).toBe(true) // scale animates
  })

  it('scale_linked rides the layer params view agents read', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    for (const t of root(a.snapshot()).tracks) {
      const l = t.layers.find((x) => x.id === id)
      if (!l) continue
      const view = layerParamsView(l.params, {}) as { scale_linked?: boolean }
      expect(view.scale_linked).toBe(true)
    }
  })
})
