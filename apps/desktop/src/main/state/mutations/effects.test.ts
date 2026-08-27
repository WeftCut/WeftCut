import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyAddEffect, applyUpdateEffect, applyMoveEffect, applyRemoveEffect } from './effects'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const sp = (v: number) => ({ mode: 'Static' as const, value: v })

/** Fresh project with one color layer on @A. `gen` is returned so tests can
 *  assert id-allocation order. */
function withLayer(): { p: Project; gen: IdGen; layerId: string } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // ids #1 (A) #2 (B) #3 (project)
  const layerId = applyAddLayer(p, gen, root(p).tracks[0].id, colorParams(RED, 1920, 1080), 0, 1_000_000) // #4
  return { p, gen, layerId }
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function effectsOf(p: Project, layerId: string) {
  for (const t of root(p).tracks) { const l = t.layers.find((x) => x.id === layerId); if (l) return l.effects }
  throw new Error('layer not found')
}

describe('applyAddEffect', () => {
  it('appends an effect with enabled:true and empty params; returns its id', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur') // #5
    expect(eid).toBe('00000000-0000-0000-0000-000000000006')
    const fx = effectsOf(p, layerId)
    expect(fx).toHaveLength(1)
    expect(fx[0]).toEqual({ id: eid, kind: 'blur', enabled: true, params: {} })
  })
  it('preserves append order across multiple adds', () => {
    const { p, gen, layerId } = withLayer()
    const e1 = applyAddEffect(p, gen, layerId, 'blur')
    const e2 = applyAddEffect(p, gen, layerId, 'brightness')
    expect(effectsOf(p, layerId).map((e) => e.id)).toEqual([e1, e2])
  })
  // ★ KEYSTONE: the id is minted BEFORE the layer lookup, so a LayerNotFound
  //   still burns it (unlike applyAddLayer, which mints after the track check).
  it('mints (burns) the effect id even when the layer is missing', () => {
    const { p, gen } = withLayer() // next idGen() would be #5
    expectCmd(() => applyAddEffect(p, gen, 'ghost', 'blur'), 'LayerNotFound')
    // #5 was burned by the failed add_effect; the next mint is #6.
    expect(applyAddTrack(p, gen, 'x')).toBe('00000000-0000-0000-0000-000000000007')
  })
})

describe('applyUpdateEffect', () => {
  it('replaces enabled when present', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { enabled: false })
    expect(effectsOf(p, layerId)[0].enabled).toBe(false)
  })
  it('merges params key-by-key (insert + overwrite, no deletion)', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(8), sigma: sp(2) } })
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(12) } }) // overwrite radius, keep sigma
    expect(effectsOf(p, layerId)[0].params).toEqual({ radius: sp(12), sigma: sp(2) })
  })
  it('null/absent fields are "do not touch"', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { enabled: null, params: null })
    expect(effectsOf(p, layerId)[0]).toEqual({ id: eid, kind: 'blur', enabled: true, params: {} })
  })
  // This is the SECOND effect-param write entry — applyUpdateLayerParamTrack's
  // `effects[..].params[..]` path is the other — so quantizing only there would
  // make the stored precision depend on which command an agent reached for.
  it('quantizes merged param values, static and keyframed alike', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: {
      strength: sp(8.123456789),
      feather: { mode: 'Keyframed', value: [
        { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 0.98765, interp: { kind: 'Linear' } },
      ] },
    } })
    const params = effectsOf(p, layerId)[0].params
    expect(params.strength).toEqual(sp(8.123))
    expect((params.feather.value as { value: number }[])[0].value).toBe(0.988)
  })
  it('never lets an effect param name borrow a layer param range', () => {
    // Effect params live in their own namespace, so a `[0, 100]` param called
    // `opacity` must not be refused against the layer param's `[0, 1]`.
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { opacity: sp(55.5555) } })
    expect(effectsOf(p, layerId)[0].params.opacity).toEqual(sp(55.556))
  })
  it('throws LayerNotFound / EffectNotFound', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    expectCmd(() => applyUpdateEffect(p, 'ghost', eid, { enabled: false }), 'LayerNotFound')
    expectCmd(() => applyUpdateEffect(p, layerId, 'ghost', { enabled: false }), 'EffectNotFound')
  })
})

describe('applyMoveEffect', () => {
  it('reorders an effect to a new index (0 = first)', () => {
    const { p, gen, layerId } = withLayer()
    const e1 = applyAddEffect(p, gen, layerId, 'blur')
    const e2 = applyAddEffect(p, gen, layerId, 'brightness')
    applyMoveEffect(p, layerId, e2, 0)
    expect(effectsOf(p, layerId).map((e) => e.id)).toEqual([e2, e1])
  })
  it('rejection order: EffectNotFound before EffectIndexOutOfRange', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    expectCmd(() => applyMoveEffect(p, layerId, 'ghost', 9), 'EffectNotFound')
    expectCmd(() => applyMoveEffect(p, layerId, eid, 9), 'EffectIndexOutOfRange')
    expectCmd(() => applyMoveEffect(p, 'ghost', eid, 0), 'LayerNotFound')
  })
})

describe('applyRemoveEffect', () => {
  it('removes an effect by id', () => {
    const { p, gen, layerId } = withLayer()
    const e1 = applyAddEffect(p, gen, layerId, 'blur')
    const e2 = applyAddEffect(p, gen, layerId, 'brightness')
    applyRemoveEffect(p, layerId, e1)
    expect(effectsOf(p, layerId).map((e) => e.id)).toEqual([e2])
  })
  it('throws LayerNotFound / EffectNotFound', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyRemoveEffect(p, layerId, eid)
    expectCmd(() => applyRemoveEffect(p, layerId, eid), 'EffectNotFound')
    expectCmd(() => applyRemoveEffect(p, 'ghost', eid), 'LayerNotFound')
  })
})

describe('effects inside a Group', () => {
  it('applyAddEffect / applyUpdateEffect find the layer in its Group', () => {
    const { p, idGen, groupId, innerId } = groupedProject()
    const rootBefore = structuredClone(root(p))
    const eid = applyAddEffect(p, idGen, innerId, 'blur')
    applyUpdateEffect(p, innerId, eid, { enabled: false })
    expect(group(p, groupId).tracks[0].layers[0].effects).toEqual([{ id: eid, kind: 'blur', enabled: false, params: {} }])
    expect(root(p)).toEqual(rootBefore)
  })
})
