// The authored-precision policy the mutation layer enforces, re-exported here
// for the same reason `snap.ts` re-exports the frame grid: BOTH sides need it —
// the mutations to quantize a write, the inspector to format the readout — and a
// copy on each side would be exactly the drift one seam prevents. Main-process
// code imports from here rather than reaching into the renderer tree at every
// call site.
//
// The table lives beside `ParamDescriptor` (renderer/keyframe/descriptors.ts)
// because it is keyed by the same param keys and read by the same inspector; see
// that file for why `d` is a decimal place count and not `step`.
export {
  BOX_PRECISION,
  EFFECT_PARAM_DECIMALS,
  PARAM_PRECISION,
  paramDecimals,
  paramRange,
  quantize,
  quantizeParam,
  type ParamPrecision,
} from '../../renderer/keyframe/descriptors'

import { BOX_PRECISION, EFFECT_PARAM_DECIMALS, paramRange, quantize, quantizeParam } from '../../renderer/keyframe/descriptors'
import { CommandFailure } from './errors'
import type { Animated, Keyframe } from './model'

/** One authored scalar, ready to store: quantized to `paramKey`'s precision,
 *  then range-checked.
 *
 *  THAT ORDER IS LOAD-BEARING. Quantizing first means an `opacity` of 1.0004 —
 *  which an agent computing `1 - 1e-4 * 4` arrives at honestly — becomes 1.0 and
 *  passes, instead of being refused for overshooting a bound by less than the
 *  field can even record. Checking first would refuse values that were never
 *  out of range at the precision they are stored at.
 *
 *  Refuses rather than clamps: precision is a property of the field (so
 *  narrowing it is silent, exactly as the time lattice has been since ADR 0037),
 *  while range is the user's intent (so violating it is theirs to fix — the
 *  no-silent-clamping red line, ADR 0048). */
export function authoredValue(paramKey: string, v: number): number {
  // Non-finite is refused for EVERY key, ranged or not. An unbounded param is
  // unbounded in magnitude, not in kind: a NaN `x` is not a distant layer, it is
  // a vanished one — the same failure mode the Text arm's enum checks exist to
  // prevent, arriving through a number instead of a string.
  if (!Number.isFinite(v)) {
    throw new CommandFailure({
      error: 'InvalidArgument',
      field: paramKey,
      detail: `${paramKey} must be a finite number (got ${v})`,
    })
  }
  const q = quantizeParam(paramKey, v)
  const range = paramRange(paramKey)
  if (range && (q < range[0] || q > range[1])) {
    throw new CommandFailure({
      error: 'InvalidArgument',
      field: paramKey,
      detail: `${paramKey} must be between ${range[0]} and ${range[1]} — got ${v}, which records as ${q}. Values are not clamped; send one in range.`,
    })
  }
  return q
}

/** `track` rewritten in place with every authored value put through
 *  `authoredValue`. Static tracks carry one; a Keyframed track carries one per
 *  key, and EVERY key is checked — a range violation anywhere refuses the whole
 *  write, because a track that renders legally for part of its span and
 *  illegally for the rest is not a partial success.
 *
 *  Interpolated values are NOT quantized, here or anywhere: they are evaluated,
 *  not authored, and forcing a lattice on them would put the render path in
 *  permanent violation of an invariant it cannot honour between two keys. */
export function quantizeTrack(paramKey: string, track: Animated<number>): void {
  if (track.mode === 'Static') {
    track.value = authoredValue(paramKey, track.value)
    return
  }
  for (const k of track.value as Keyframe<number>[]) {
    k.value = authoredValue(paramKey, k.value)
  }
}

/** An EFFECT param track, quantized at the effect precision unconditionally.
 *
 *  Separate from `quantizeTrack` and not merely a call to it with the param name,
 *  because effect params are named in their own namespace: an effect is free to
 *  call a param `opacity` or `pan`, and going through the param-key table would
 *  silently hand it a range that belongs to the layer param of the same name.
 *  There is no collision in the catalog today; this keeps there from being one. */
export function quantizeEffectTrack(track: Animated<number>): void {
  const q = (v: number): number => quantize(v, EFFECT_PARAM_DECIMALS)
  if (track.mode === 'Static') {
    track.value = q(track.value)
    return
  }
  for (const k of track.value as Keyframe<number>[]) k.value = q(k.value)
}

/** A plain authored pixel extent at `d` places — the text box pair, which is a
 *  scalar rather than a track (ADR 0049) and so has no param key to look up. */
export function quantizeBoxPx(v: number): number {
  return quantize(v, BOX_PRECISION.d)
}
