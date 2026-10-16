// Internal to rangePlayback: the values that can affect a layer's covered
// interval. Animation compares intersecting interpolation segments, including
// their boundary keys; it never samples on a frame or half-frame grid.
import type { Animated, Keyframe, Layer } from '../state/model'
import { keyTimeUs } from '../../shared/keyframe'
import { keyTimeExact } from '../../renderer/layerTiming'
import { approximateTime, exactTime, subtractTime } from '../../renderer/timeMapping'
import { resolveAnimated, resolveAnimatedColor } from '../../renderer/render/animated'

function keyAt(k: Keyframe<unknown>, offset: number): number {
  return approximateTime(subtractTime(keyTimeExact(k), exactTime(offset)))
}

function segment(a: Keyframe<unknown>, b: Keyframe<unknown>, offset: number): unknown {
  if (a.segment.kind === 'Hold') return { start: keyAt(a, offset), end: keyAt(b, offset), constant: a.value }
  const base = { start: keyAt(a, offset), end: keyAt(b, offset), from: a.value, to: b.value, kind: a.segment }
  return a.segment.kind === 'Spline'
    ? { ...base, out: { x: a.out.x, y: a.out.y }, in: { x: b.in.x, y: b.in.y } }
    : base
}

/** Keep the interpolation dependencies, not whole key records (ids, edit
 *  modes and unused handles don't play). Non-hold extrapolation can read
 *  distant keys: keep its curve when the interval reaches it, so a loop or
 *  continuation never hides a relevant change. */
function animation(a: Animated<unknown>, offset: number, duration: number): unknown {
  if (a.mode === 'Static') return { constant: a.value }
  const keys = a.value
  if (keys.length <= 1) return { constant: keys[0]?.value }
  if (duration === 0) {
    const value = typeof keys[0]!.value === 'number'
      ? resolveAnimated(a as Animated<number>, offset, 0)
      : resolveAnimatedColor(a as Parameters<typeof resolveAnimatedColor>[0], offset, { r: 0, g: 0, b: 0, a: 0 })
    return { constant: value }
  }
  const first = keys[0]!, last = keys.at(-1)!, end = offset + duration
  const before = offset < keyTimeUs(first), after = end > keyTimeUs(last)
  if ((before && a.extrapolate.before !== 'Hold') || (after && a.extrapolate.after !== 'Hold')) {
    return { segments: keys.slice(1).map((b, i) => segment(keys[i]!, b, offset)),
      before: before ? a.extrapolate.before : null, after: after ? a.extrapolate.after : null }
  }
  if (end <= keyTimeUs(first)) return { constant: first.value }
  if (offset >= keyTimeUs(last)) return { constant: last.value }
  const parts: unknown[] = []
  if (before) parts.push({ until: keyAt(first, offset), constant: first.value })
  for (let i = 0; i + 1 < keys.length; i++) {
    const left = keys[i]!, right = keys[i + 1]!
    if (keyTimeUs(left) >= end || keyTimeUs(right) <= offset) continue
    parts.push(segment(left, right, offset))
  }
  if (after) parts.push({ from: keyAt(last, offset), constant: last.value })
  return parts
}

function values(value: unknown, offset: number, duration: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => values(v, offset, duration))
  const record = value as Record<string, unknown>
  if ((record.mode === 'Static' || record.mode === 'Keyframed') && 'value' in record)
    return animation(value as Animated<unknown>, offset, duration)
  return Object.fromEntries(Object.entries(record).map(([key, v]) =>
    [key, key === 'props' ? v : values(v, offset, duration)]))
}

/** Fade curves are anchored to the layer's ends, not its source window.
 *  A tail trim changes a fade inside the range even when its duration field
 *  is untouched. No fade dependency where the factor is identically one. */
function fades(l: Layer, offset: number, duration: number): unknown {
  const p = l.params
  if (!('fade_in_us' in p)) return null
  const phase = p.fade_phase
  const fi = p.fade_in_us + (phase ? phase.in.num / phase.in.den : 0)
  const fo = p.fade_out_us + (phase ? phase.out.num / phase.out.den : 0)
  const span = l.t_end_us - l.t_start_us
  const inRamp = fi > 0 && offset < fi ? { start: -offset, duration: fi } : null
  const outRamp = fo > 0 && (duration === 0 ? offset > span - fo : offset + duration > span - fo)
    ? { end: span - offset, duration: fo } : null
  return { inRamp, outRamp }
}

export function playbackValues(l: Layer, offset: number, duration: number): unknown {
  const params = { ...l.params } as Record<string, unknown>
  for (const key of ['src_in_us', 'src_out_us', 'content_window', 'source_phase', 'fade_in_us', 'fade_out_us', 'fade_phase']) delete params[key]
  return { enabled: l.enabled, metadata: l.metadata, params: values(params, offset, duration),
    effects: values(l.effects, offset, duration), fades: fades(l, offset, duration) }
}
