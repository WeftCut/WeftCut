import type { ContentTiming, ExactTime, TimingFields, TimeRatio } from '../shared/timeMapping';
import type { Keyframe } from '../shared/keyframe';
import { TimeMappingError } from '../shared/timeMapping';
import { addTime, affineTimeMap, approximateTime, contentTiming, divideTime, exactTime, floorTime, multiplyTime, readExactTime, readTimeMap, subtractTime, UNIT_RATE, ZERO_TIME } from './timeMapping';

export interface TimedParams extends TimingFields {
  kind?: string;
  src_in_us?: number;
  src_out_us?: number;
}
export interface TimedLayer { params: TimedParams; t_start_us: number; t_end_us: number }

export function layerRate(params: TimingFields | { kind: string }): TimeRatio {
  return "time_map" in params && params.time_map ? readTimeMap(params.time_map).rate : UNIT_RATE;
}
export function layerRateNumber(params: TimingFields | { kind: string }): number { return approximateTime(layerRate(params)); }
export function sourceIn(params: TimedParams): ExactTime {
  return addTime(exactTime(params.content_window?.in_us ?? params.src_in_us ?? 0), params.source_phase?.in ?? ZERO_TIME);
}
export function sourceOut(layer: TimedLayer): ExactTime {
  const out = layer.params.content_window?.out_us ?? layer.params.src_out_us;
  return out === undefined ? contentAt(layer.params, exactTime(layer.t_end_us - layer.t_start_us))
    : addTime(exactTime(out), layer.params.source_phase?.out ?? ZERO_TIME);
}
export function contentAt(params: TimedParams, local: ExactTime): ExactTime {
  return addTime(sourceIn(params), multiplyTime(local, layerRate(params)));
}
export function contentAtUs(params: TimedParams, localUs: number): number {
  // Render consumers can query a fractional composition clock. Preserve it
  // through nesting; authored integer/rational edits use contentAt directly.
  return approximateTime(sourceIn(params)) + localUs * layerRateNumber(params);
}
export function localAtContent(params: TimedParams, content: ExactTime): ExactTime {
  return divideTime(subtractTime(content, sourceIn(params)), layerRate(params));
}
export function layerContentTiming(layer: TimedLayer): ContentTiming {
  return contentTiming(sourceIn(layer.params), sourceOut(layer), layerRate(layer.params));
}
export function splitExact(value: ExactTime): { whole: number; fraction: ExactTime } {
  const whole = floorTime(value);
  return { whole, fraction: subtractTime(value, exactTime(whole)) };
}
export function writeSourceWindow(params: TimedParams, start: ExactTime, end: ExactTime): void {
  const a = splitExact(start), b = splitExact(end);
  if (params.kind === 'VideoClip' || params.kind === 'Audio' || params.kind === 'CompositionRef') {
    params.src_in_us = a.whole; params.src_out_us = b.whole;
  } else {
    params.content_window = { in_us: a.whole, out_us: b.whole };
    if (params.kind === 'Motif') params.src_in_us = a.whole;
  }
  if (a.fraction.num || b.fraction.num) params.source_phase = { in: a.fraction, out: b.fraction };
  else delete params.source_phase;
}
export function writeLayerTiming(layer: TimedLayer, timing: ContentTiming): void {
  writeSourceWindow(layer.params, timing.content_in, timing.content_out);
  layer.params.time_map = affineTimeMap(timing.time_map.rate);
}
export function trimContentWindow(layer: TimedLayer, localStart: number, localEnd: number): void {
  const start = contentAt(layer.params, exactTime(localStart));
  const end = contentAt(layer.params, exactTime(localEnd));
  writeSourceWindow(layer.params, start, end);
}
export function keyTimeExact(key: Pick<Keyframe<unknown>, 't_us' | 'time_fraction'>): ExactTime {
  return addTime(exactTime(key.t_us), key.time_fraction ?? ZERO_TIME);
}
export function writeKeyTime(key: Pick<Keyframe<unknown>, 't_us' | 'time_fraction'>, time: ExactTime): void {
  const split = splitExact(time);
  key.t_us = split.whole;
  key.time_fraction = split.fraction;
}
export function validateTimeFraction(value: ExactTime): void {
  const v = readExactTime(value);
  if (v.num < 0 || v.num >= v.den) throw new TimeMappingError('NonCanonical');
}
export function identityTimingFields(): TimingFields {
  return { time_map: affineTimeMap(), frame_interpolation: { kind: 'FrameSampling' } };
}
