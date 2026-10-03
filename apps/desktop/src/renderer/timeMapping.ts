// Public timing seam for renderer and TS actor. Only this module knows the
// Affine variant; consumers ask for content time, rate, projection or a slice.
// Exact arithmetic delegates to the native/Wasm leaf, as frame snapping does.
import {
  TimeMappingError,
  type ContentTiming,
  type ExactRange,
  type ExactTime,
  type TimeMap,
  type TimeRatio,
} from '../shared/timeMapping';
import { calculateExact } from './eval';

export const ZERO_TIME: ExactTime = Object.freeze({ num: 0, den: 1 });
export const UNIT_RATE: TimeRatio = Object.freeze({ num: 1, den: 1 });

export function exactTime(num: number, den = 1): ExactTime {
  return calculateExact(8, { num, den });
}

/** Loading is strict; construction is allowed to reduce. Unknown variants and
 * malformed fractions must not become normal speed as a side effect of load. */
export function readExactTime(value: unknown): ExactTime {
  if (!value || typeof value !== 'object') throw new TimeMappingError('InvalidNumber');
  const v = value as Record<string, unknown>;
  if (typeof v.num !== 'number' || typeof v.den !== 'number') throw new TimeMappingError('InvalidNumber');
  const result = exactTime(v.num, v.den);
  if (result.num !== v.num || result.den !== v.den) throw new TimeMappingError('NonCanonical');
  return result;
}

export function addTime(a: ExactTime, b: ExactTime): ExactTime { return calculateExact(0, a, b); }
export function subtractTime(a: ExactTime, b: ExactTime): ExactTime { return calculateExact(1, a, b); }
export function multiplyTime(a: ExactTime, b: ExactTime): ExactTime { return calculateExact(2, a, b); }
export function divideTime(a: ExactTime, b: ExactTime): ExactTime { return calculateExact(3, a, b); }
export function compareTime(a: ExactTime, b: ExactTime): number { return calculateExact(4, a, b).num; }
export function roundTime(a: ExactTime): number { return calculateExact(5, a).num; }
export function floorTime(a: ExactTime): number { return calculateExact(6, a).num; }
export function ceilTime(a: ExactTime): number { return calculateExact(7, a).num; }

/** UI/display and decoder boundaries only. Never feed this back into timing. */
export function approximateTime(a: ExactTime): number { return a.num / a.den; }

export function affineTimeMap(rate: TimeRatio = UNIT_RATE): TimeMap {
  const canonical = readExactTime(rate);
  if (canonical.num <= 0) throw new TimeMappingError('NonPositiveRate');
  return { kind: 'Affine', rate: canonical };
}

export function readTimeMap(value: unknown): TimeMap {
  if (!value || typeof value !== 'object') throw new TimeMappingError('UnknownTimeMap');
  const v = value as Record<string, unknown>;
  if (v.kind !== 'Affine') throw new TimeMappingError('UnknownTimeMap');
  return affineTimeMap(readExactTime(v.rate));
}

export function contentTiming(contentIn: ExactTime, contentOut: ExactTime, rate: TimeRatio = UNIT_RATE): ContentTiming {
  const start = readExactTime(contentIn);
  const end = readExactTime(contentOut);
  if (compareTime(start, end) >= 0) throw new TimeMappingError('InvalidRange');
  return { time_map: affineTimeMap(rate), content_in: start, content_out: end };
}

export function readContentTiming(value: unknown): ContentTiming {
  if (!value || typeof value !== 'object') throw new TimeMappingError('InvalidRange');
  const v = value as Record<string, unknown>;
  return contentTiming(readExactTime(v.content_in), readExactTime(v.content_out), readTimeMap(v.time_map).rate);
}

/** Finite queries outside the visible range are permitted, without clamping. */
export function mapContentTime(timing: ContentTiming, localTime: ExactTime): ExactTime {
  return addTime(timing.content_in, multiplyTime(localTime, contentRateAt(timing, localTime)));
}

export function contentRateAt(timing: ContentTiming, localTime: ExactTime): TimeRatio {
  // Keep the local coordinate in the interface for future piecewise maps.
  readExactTime(localTime);
  return readTimeMap(timing.time_map).rate;
}

export function timingDuration(timing: ContentTiming): ExactTime {
  return divideTime(subtractTime(timing.content_out, timing.content_in), contentRateAt(timing, ZERO_TIME));
}

/** Returns candidate LOCAL half-open intervals; never a promised unique inverse.
 * By default intersects the selected content window. Borrowed-handle callers
 * explicitly request extension instead of changing everyone's boundary policy. */
export function projectContentRange(timing: ContentTiming, range: ExactRange, extend = false): ExactRange[] {
  if (compareTime(range.start, range.end) > 0) throw new TimeMappingError('InvalidRange');
  const start = !extend && compareTime(range.start, timing.content_in) < 0 ? timing.content_in : range.start;
  const end = !extend && compareTime(range.end, timing.content_out) > 0 ? timing.content_out : range.end;
  if (compareTime(start, end) >= 0) return [];
  const rate = contentRateAt(timing, ZERO_TIME);
  return [{ start: divideTime(subtractTime(start, timing.content_in), rate), end: divideTime(subtractTime(end, timing.content_in), rate) }];
}

/** Trim/split: preserve rate and rebase the local origin, without quantizing.
 * Extension is allowed: content availability is the editor's separate check. */
export function sliceTiming(timing: ContentTiming, localRange: ExactRange): ContentTiming {
  if (compareTime(localRange.start, localRange.end) >= 0) throw new TimeMappingError('InvalidRange');
  return contentTiming(mapContentTime(timing, localRange.start), mapContentTime(timing, localRange.end), contentRateAt(timing, localRange.start));
}

/** `outer` maps an intermediate composition to content; `inner` maps this
 * clip's local clock to that intermediate composition. No grid snap here. */
export function composeTiming(outer: ContentTiming, inner: ContentTiming): ContentTiming {
  return contentTiming(
    mapContentTime(outer, inner.content_in),
    mapContentTime(outer, inner.content_out),
    multiplyTime(contentRateAt(outer, inner.content_in), contentRateAt(inner, ZERO_TIME)),
  );
}

/** Retime only after the editor has snapped actualDuration to its own grid. */
export function retimeTiming(timing: ContentTiming, actualDuration: ExactTime): ContentTiming {
  if (compareTime(actualDuration, ZERO_TIME) <= 0) throw new TimeMappingError('InvalidRange');
  return contentTiming(timing.content_in, timing.content_out,
    divideTime(subtractTime(timing.content_out, timing.content_in), actualDuration));
}

/** The same operation scales a key time or fade duration. Out-of-range key
 * times (including negative ones) are retained, never clamped to the clip. */
export function retimeAnimationTime(time: ExactTime, oldDuration: ExactTime, newDuration: ExactTime): ExactTime {
  if (compareTime(oldDuration, ZERO_TIME) <= 0 || compareTime(newDuration, ZERO_TIME) <= 0) throw new TimeMappingError('InvalidRange');
  return multiplyTime(time, divideTime(newDuration, oldDuration));
}
