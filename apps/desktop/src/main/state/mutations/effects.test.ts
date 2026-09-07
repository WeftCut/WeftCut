import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { audioParams, videoClipParams } from './media'
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
  it('merges params key-by-key (insert + overwrite)', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(8), sigma: sp(2) } })
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(12) } }) // overwrite radius, keep sigma
    expect(effectsOf(p, layerId)[0].params).toEqual({ radius: sp(12), sigma: sp(2) })
  })
  // A `null` VALUE inside `params` is the one null that is not "don't touch":
  // absent IS a param's unset state (the catalog default stands in), and a
  // sample region has no default to stand in — so "back to unset" has to be
  // expressible, and this is the only command that can express it.
  it('a null param value removes the key', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(8), sigma: sp(2) } })
    applyUpdateEffect(p, layerId, eid, { params: { radius: null } })
    expect(effectsOf(p, layerId)[0].params).toEqual({ sigma: sp(2) })
  })

  it('removing an absent key is a no-op, not a failure — a reset is idempotent', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { radius: null } })
    expect(effectsOf(p, layerId)[0].params).toEqual({})
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(8) } })
    applyUpdateEffect(p, layerId, eid, { params: { radius: null } })
    applyUpdateEffect(p, layerId, eid, { params: { radius: null } })
    expect(effectsOf(p, layerId)[0].params).toEqual({})
  })

  // The shape reset-parameters sends: every non-region param back to its
  // default and the region pair unset, in ONE patch so it is one undo.
  it('a mixed patch sets and removes in the same call', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { strength: sp(30), in_us: sp(200_000), out_us: sp(1_800_000) } })
    applyUpdateEffect(p, layerId, eid, { params: { strength: sp(12), in_us: null, out_us: null } })
    expect(effectsOf(p, layerId)[0].params).toEqual({ strength: sp(12) })
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
      feather: { mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [
        { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 0.98765, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } },
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

// ── The audio namespace + static-only rules (ADR 0063) ───────────────────────
// `audio.*` and Audio layers are the same set, and audio effect params are
// static. Both rules live at the command layer because MCP and the UI reach the
// same code site, and both refusals are pre-write: the project has to come out
// byte-identical.
describe('audio effect rules', () => {
  const MID = '00000000-0000-0000-0000-0000000000aa'
  const kfTrack = () => ({ mode: 'Keyframed' as const, extrapolate: { before: 'Hold' as const, after: 'Hold' as const }, value: [
    { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 12, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' as const }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' as const }, continuity: 'Broken' as const, segment: { kind: 'Linear' as const } },
  ] })
  /** One Audio layer and one VideoClip layer, on the two blank tracks. */
  function avProject(): { p: Project; gen: IdGen; audioId: string; videoId: string } {
    const gen = seededGen()
    const p = blankProject(gen, 'av')
    const audioId = applyAddLayer(p, gen, root(p).tracks[0].id, audioParams(MID, 0, 3_000_000), 0, 3_000_000)
    const videoId = applyAddLayer(p, gen, root(p).tracks[1].id, videoClipParams(MID, 0, 3_000_000), 0, 3_000_000)
    return { p, gen, audioId, videoId }
  }

  it('an Audio layer takes audio.* and refuses a visual kind', () => {
    const { p, gen, audioId } = avProject()
    const eid = applyAddEffect(p, gen, audioId, 'audio.denoise')
    expect(effectsOf(p, audioId)).toEqual([{ id: eid, kind: 'audio.denoise', enabled: true, params: {} }])
    expectCmd(() => applyAddEffect(p, gen, audioId, 'blur'), 'EffectKindNotApplicable')
    expect(effectsOf(p, audioId)).toHaveLength(1)
  })

  it('a non-Audio layer refuses audio.* — catalogued or not', () => {
    const { p, gen, videoId } = avProject()
    expectCmd(() => applyAddEffect(p, gen, videoId, 'audio.denoise'), 'EffectKindNotApplicable')
    // The rule is the NAMESPACE, not catalog membership: an audio kind this
    // build has never heard of is still refused on a visual layer.
    expectCmd(() => applyAddEffect(p, gen, videoId, 'audio.future'), 'EffectKindNotApplicable')
    expect(effectsOf(p, videoId)).toEqual([])
  })

  // ADR 0027: main cannot read the pixi-dependent visual registry, so an
  // unknown non-audio kind is accepted and resolved at render.
  it('an unknown NON-audio kind still lands on a visual layer', () => {
    const { p, gen, videoId } = avProject()
    const eid = applyAddEffect(p, gen, videoId, 'some.unknown')
    expect(effectsOf(p, videoId)).toEqual([{ id: eid, kind: 'some.unknown', enabled: true, params: {} }])
  })

  it('reports the layer kind that was found, and still burns the id', () => {
    const { p, gen, videoId } = avProject()
    try {
      applyAddEffect(p, gen, videoId, 'audio.denoise')
      throw new Error('expected EffectKindNotApplicable')
    } catch (e) {
      expect(isCommandFailure(e) && e.err).toEqual({ error: 'EffectKindNotApplicable', kind: 'audio.denoise', layer_kind: 'VideoClip' })
    }
    // Same id contract as every other add_effect refusal.
    expect(applyAddEffect(p, gen, videoId, 'blur')).toBe('00000000-0000-0000-0000-000000000008')
  })

  it('LayerNotFound still precedes the namespace rule', () => {
    const { p, gen } = avProject()
    expectCmd(() => applyAddEffect(p, gen, 'ghost', 'audio.denoise'), 'LayerNotFound')
  })

  it('applyUpdateEffect refuses a Keyframed track on an audio.* param', () => {
    const { p, gen, audioId } = avProject()
    const eid = applyAddEffect(p, gen, audioId, 'audio.denoise')
    applyUpdateEffect(p, audioId, eid, { params: { strength: sp(20) } })
    try {
      applyUpdateEffect(p, audioId, eid, { enabled: false, params: { strength: kfTrack() } })
      throw new Error('expected AudioEffectParamStatic')
    } catch (e) {
      expect(isCommandFailure(e) && e.err).toEqual({ error: 'AudioEffectParamStatic', effect: eid, param: 'strength' })
    }
    // Nothing applied — not the track, and not the `enabled` that rode along.
    expect(effectsOf(p, audioId)[0]).toEqual({ id: eid, kind: 'audio.denoise', enabled: true, params: { strength: sp(20) } })
  })

  // The static-only rule judges a TRACK. A removal carries none, so unsetting
  // an audio param is always allowed — which is what lets the denoise card's
  // reset put its sample region back to "needs a region".
  it('unsetting an audio.* param is allowed and keeps the rest of the patch', () => {
    const { p, gen, audioId } = avProject()
    const eid = applyAddEffect(p, gen, audioId, 'audio.denoise')
    applyUpdateEffect(p, audioId, eid, { params: {
      strength: sp(20), profile_in_us: sp(200_000), profile_out_us: sp(1_800_000),
    } })
    applyUpdateEffect(p, audioId, eid, { params: {
      strength: sp(12), margin: sp(8), profile_in_us: null, profile_out_us: null,
    } })
    expect(effectsOf(p, audioId)[0].params).toEqual({ strength: sp(12), margin: sp(8) })
  })

  it('applyUpdateEffect refuses a Keyframed track ANYWHERE in the patch', () => {
    const { p, gen, audioId } = avProject()
    const eid = applyAddEffect(p, gen, audioId, 'audio.denoise')
    expectCmd(() => applyUpdateEffect(p, audioId, eid, { params: { strength: sp(20), margin: kfTrack() } }), 'AudioEffectParamStatic')
    expect(effectsOf(p, audioId)[0].params).toEqual({})
  })

  it('a visual effect keeps its keyframed params', () => {
    const { p, gen, videoId } = avProject()
    const eid = applyAddEffect(p, gen, videoId, 'blur')
    applyUpdateEffect(p, videoId, eid, { params: { strength: kfTrack() } })
    expect(effectsOf(p, videoId)[0].params.strength.mode).toBe('Keyframed')
  })
})
