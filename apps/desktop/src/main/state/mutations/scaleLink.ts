import type { Animated, Extrapolation, Keyframe, Layer, Project, Transform, Uuid } from '../model'
import type { IdGen } from '../ids'
import { cloneExtrapolation, cloneKeyframeShape, extrapolationEq, keyframeShapeEqExact } from '../../../shared/keyframe'
import { CommandFailure } from '../errors'
import { checkTrackLock, locateLayer } from './helpers'

/** The transform of a layer whose kind carries one, else null (Color/Audio). */
export function transformOf(layer: Layer): Transform | null {
  const p = layer.params
  return p.kind === 'Color' || p.kind === 'Audio' ? null : p.transform
}

/** Structural twin test for the two scale tracks. Keyframe `id`s are per-track
 *  identities and legitimately differ between twins, so they are IGNORED here —
 *  comparing them would misread every honest twin pair as diverged (and the
 *  load-time backfill in serialize.ts would then unlink every layer it loads).
 *  Defensive against wire shapes: a malformed entry compares as diverged rather
 *  than throwing, because the backfill runs before validate gets to reject. */
export function scaleTracksTwins(a: Animated<number>, b: Animated<number>): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (a.mode !== b.mode) return false
  if (a.mode === 'Static') return a.value === (b as { value: number }).value
  const ka = a.value
  const kb = (b as { value: Keyframe<number>[] }).value
  if (!Array.isArray(ka) || !Array.isArray(kb) || ka.length !== kb.length) return false
  const ea = a.extrapolate as Extrapolation | undefined
  const eb = (b as { extrapolate?: Extrapolation }).extrapolate
  if (!isWireObject(ea) || !isWireObject(eb) || !extrapolationEq(ea, eb)) return false
  return ka.every((k, i) => {
    const o = kb[i]
    return isWireKey(k) && isWireKey(o) && keyframeShapeEqExact(k, o)
  })
}
const isWireObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
/** The fields `keyframeShapeEqExact` dereferences must be present, or a malformed
 *  wire key would throw here instead of reading as diverged. */
const isWireKey = (k: unknown): k is Keyframe<number> =>
  isWireObject(k) && isWireObject(k.in) && isWireObject(k.out) && isWireObject(k.segment)

/** Structural copy of a scale track for the OTHER axis: fresh keyframe ids
 *  (per-track identities — see scaleTracksTwins), no shared mutable state
 *  (tangents, segment and extrapolation re-created via the shared clone
 *  helpers, not aliased). The renderer's fan-out twin (keyframe/fanOut.ts
 *  twinTrackCopy) is the same shape with crypto ids — a change here usually
 *  needs the same change there. */
export function copyTrackFreshIds(track: Animated<number>, idGen: IdGen): Animated<number> {
  if (track.mode === 'Static') return { mode: 'Static', value: track.value }
  return {
    mode: 'Keyframed',
    value: track.value.map((k) => ({ id: idGen(), ...cloneKeyframeShape(k) })),
    extrapolate: cloneExtrapolation(track.extrapolate),
  }
}

/** The scale-link invariant: `scale_linked = true` ⇒ the two tracks are twins.
 *  Checked on RESULTS, not write paths — run it after any mutation that can
 *  touch a scale track and it self-heals by clearing the flag in the SAME
 *  commit. A write that leaves the tracks equal (e.g. one patch setting both
 *  axes to the same value) therefore never unlinks; only genuine divergence
 *  does. Runs at commit granularity, NOT per batch entry: a linked fan-out
 *  batch is mid-divergence between its scale_x and scale_y entries. */
export function enforceScaleLinkInvariant(p: Project, id: Uuid): void {
  const loc = locateLayer(p, id)
  if (!loc) return
  const t = transformOf(loc.layer)
  if (!t || t.scale_linked !== true) return
  if (!scaleTracksTwins(t.scale_x, t.scale_y)) t.scale_linked = false
}

/** set_scale_linked (mutation half). Linking is the design's one destructive
 *  moment: `scale_y` becomes a fresh-id copy of `scale_x`, whole track,
 *  keyframes included — even a Keyframed Y under a Static X is overwritten
 *  (single rule, no special cases; undo is the safety net). Unlinking touches
 *  only the flag, so the tracks stay twins until the first divergent edit. */
export function applySetScaleLinked(p: Project, idGen: IdGen, id: Uuid, linked: boolean): void {
  const { layer } = checkTrackLock(p, id) // LayerNotFound / TrackLocked
  const t = transformOf(layer)
  if (!t) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: 'scale_linked' })
  if (linked) t.scale_y = copyTrackFreshIds(t.scale_x, idGen)
  t.scale_linked = linked
}
