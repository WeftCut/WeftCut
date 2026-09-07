import type { Animated, Effect, Project, Uuid } from '../model'
import { requireLayer } from './helpers'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { quantizeEffectTrack } from '../quantize'
import { isAudioKind } from '../../../shared/audioEffects/catalog'

/** Diverges from Rust's `EffectPatch` (`native/src/state/effect.rs`): a `null`
 *  param value removes the key, which the Rust shape cannot express. An
 *  absent/null FIELD is "don't touch"; `params` merges key-by-key, and a `null`
 *  VALUE inside it removes that key.
 *
 *  Removal exists because absent IS a param's unset state — the catalog default
 *  stands in for a missing key (`staticParams`), and a sample region has no
 *  default to stand in, so "back to unset" is not expressible as a value. This
 *  is the only command that can unset an effect param: the
 *  `effects[..].params[..]` param-track path lazily CREATES a slot and never
 *  drops one. */
export interface EffectPatch {
  enabled?: boolean | null
  params?: Record<string, Animated<number> | null> | null
}

/** Locate the layer's effect chain or throw LayerNotFound. */
function effectsOrThrow(p: Project, layerId: Uuid): Effect[] {
  return requireLayer(p, layerId).layer.effects
}

/** Refuse a `Keyframed` track on an `audio.*` effect param: an audio effect is
 *  an offline whole-clip bake, so its params are static by construction (see
 *  ADR 0063). BOTH effect-param write entries call this — `applyUpdateEffect`
 *  and `applyUpdateLayerParamTrack`'s `effects[..].params[..]` path, which is
 *  also where `set_keyframe` lands — because a rule enforced at one of them is
 *  a rule an agent bypasses by reaching for the other command.
 *
 *  A missing effect is not this function's refusal: each caller already answers
 *  its own EffectNotFound / UnknownKeyframeParam for that. */
export function checkAudioEffectParamStatic(effect: Effect | undefined, paramKey: string, track: { mode: string }): void {
  if (!effect || track.mode !== 'Keyframed' || !isAudioKind(effect.kind)) return
  throw new CommandFailure({ error: 'AudioEffectParamStatic', effect: effect.id, param: paramKey })
}

/** The effect id is minted UNCONDITIONALLY, BEFORE the layer lookup — so a
 *  LayerNotFound still burns the id. This is the OPPOSITE of add.ts
 *  applyAddLayer, which mints after the track check. Mints here, not in the
 *  dispatch arm, so the actor's commit pipeline stays uniform.
 *
 *  The namespace rule (ADR 0063): `audio.*` kinds land on Audio layers and only
 *  on Audio layers, and a visual kind never lands on one — the two lifecycles
 *  share the `Effect` struct and nothing else, so a misplaced kind would render
 *  as silence or as nothing at all. Unknown NON-audio kinds stay permissive
 *  (ADR 0027): the visual catalog lives in the renderer and main cannot read
 *  it. Refused AFTER the layer lookup, so LayerNotFound still wins. */
export function applyAddEffect(p: Project, idGen: IdGen, layerId: Uuid, kind: string): Uuid {
  const id = idGen() // unconditional — burned even on LayerNotFound
  const { layer } = requireLayer(p, layerId)
  const layerKind = layer.params.kind
  if (isAudioKind(kind) !== (layerKind === 'Audio')) {
    throw new CommandFailure({ error: 'EffectKindNotApplicable', kind, layer_kind: layerKind })
  }
  const effect: Effect = { id, kind, enabled: true, params: {} }
  layer.effects.push(effect)
  return id
}

/** Replace `enabled` when present; merge `params` key-by-key when present, a
 *  `null` value removing its key. LayerNotFound → EffectNotFound →
 *  AudioEffectParamStatic. */
export function applyUpdateEffect(p: Project, layerId: Uuid, effectId: Uuid, patch: EffectPatch): void {
  const e = effectsOrThrow(p, layerId).find((x) => x.id === effectId)
  if (!e) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  if (patch.params && typeof patch.params === 'object') {
    // Whole patch checked before ANY of it is written, and before `enabled`:
    // a refusal has to leave the project byte-identical, so the static-only
    // rule cannot run interleaved with the merge below. A removal carries no
    // track to judge, so unsetting an `audio.*` param is always allowed.
    for (const [k, v] of Object.entries(patch.params)) {
      if (v !== null) checkAudioEffectParamStatic(e, k, v)
    }
  }
  if (typeof patch.enabled === 'boolean') e.enabled = patch.enabled
  if (patch.params && typeof patch.params === 'object') {
    // The SECOND effect-param write entry, alongside applyUpdateLayerParamTrack's
    // `effects[..].params[..]` path — so quantization has to happen at both or the
    // stored precision would depend on which command an agent happened to use.
    for (const [k, v] of Object.entries(patch.params)) {
      // Deleting an absent key is a no-op, never a failure: a reset then says
      // "these params are unset" without having to know which of them were
      // written, and is idempotent.
      if (v === null) {
        delete e.params[k]
        continue
      }
      quantizeEffectTrack(v)
      e.params[k] = v
    }
  }
}

/** Reorder within the chain (0 = first). Rejection order:
 *  LayerNotFound → EffectNotFound → EffectIndexOutOfRange (>= len). */
export function applyMoveEffect(p: Project, layerId: Uuid, effectId: Uuid, newIndex: number): void {
  const effects = effectsOrThrow(p, layerId)
  const from = effects.findIndex((e) => e.id === effectId)
  if (from < 0) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  const len = effects.length
  if (newIndex >= len) throw new CommandFailure({ error: 'EffectIndexOutOfRange', index: newIndex, len })
  const [e] = effects.splice(from, 1)
  effects.splice(newIndex, 0, e)
}

/** Remove by id. LayerNotFound → EffectNotFound. */
export function applyRemoveEffect(p: Project, layerId: Uuid, effectId: Uuid): void {
  const effects = effectsOrThrow(p, layerId)
  const at = effects.findIndex((e) => e.id === effectId)
  if (at < 0) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  effects.splice(at, 1)
}
