import type { ExactTime } from '../../shared/timeMapping';
import { addTime, subtractTime, multiplyTime, divideTime, exactTime, approximateTime, ZERO_TIME, UNIT_RATE } from '../timeMapping';
import { layerRate, sourceIn, type TimedLayer } from '../layerTiming';

/** root = origin + local / rate. Compose rationals before sampling a clock. */
export interface CompositionClock { origin: ExactTime; rate: ExactTime }
export const ROOT_CLOCK: CompositionClock = { origin: ZERO_TIME, rate: UNIT_RATE };
export function enterClock(parent: CompositionClock, ref: TimedLayer): CompositionClock {
  const rate = multiplyTime(parent.rate, layerRate(ref.params));
  const start = addTime(parent.origin, divideTime(exactTime(ref.t_start_us), parent.rate));
  return { origin: subtractTime(start, divideTime(sourceIn(ref.params), rate)), rate };
}
export function rootAt(clock: CompositionClock, localUs: number): number {
  return approximateTime(addTime(clock.origin, divideTime(exactTime(localUs), clock.rate)));
}
export function localAt(clock: CompositionClock, rootUs: number): number {
  if (Number.isSafeInteger(rootUs)) return approximateTime(multiplyTime(subtractTime(exactTime(rootUs), clock.origin), clock.rate));
  return (rootUs - approximateTime(clock.origin)) * approximateTime(clock.rate);
}
