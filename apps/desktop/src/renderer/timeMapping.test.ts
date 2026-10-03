import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fixture from '../../fixtures/time-remapping/exact.json';
import { TimeMappingError, type ExactTime } from '../shared/timeMapping';
import { calculateExact, timeUsAtFrame } from './eval';
import {
  ZERO_TIME, UNIT_RATE, addTime, affineTimeMap, compareTime, composeTiming,
  contentTiming, divideTime, exactTime, mapContentTime, multiplyTime,
  projectContentRange, readContentTiming, readExactTime, readTimeMap,
  retimeAnimationTime, retimeTiming, sliceTiming, subtractTime, timingDuration,
} from './timeMapping';

const x = (pair: number[]): ExactTime => exactTime(pair[0]!, pair[1]!);
const range = (start: ExactTime, end: ExactTime) => ({ start, end });

describe('native/Wasm exact-time contract', () => {
  it.each(fixture.arithmetic)('$name', ({ op, a, b, expect: output }) => {
    expect(calculateExact(op, x(a), x(b))).toEqual(x(output));
  });

  it.each(fixture.mapping)('$name', ({ origin, rate, local, content }) => {
    const timing = contentTiming(x(origin), addTime(x(origin), exactTime(10_000_000)), x(rate));
    expect(mapContentTime(timing, x(local))).toEqual(x(content));
  });

  it('constructs canonical fractions but rejects malformed or unknown wire values', () => {
    expect(exactTime(6, -8)).toEqual({ num: -3, den: 4 });
    expect(exactTime(0, -8)).toEqual(ZERO_TIME);
    for (const value of [null, {}, { num: 0.5, den: 1 }, { num: Infinity, den: 1 }, { num: 1, den: 0 }, { num: 2, den: 4 }, { num: 1, den: -2 }, { num: 0, den: 7 }]) {
      expect(() => readExactTime(value)).toThrow(TimeMappingError);
    }
    expect(() => readTimeMap({ kind: 'Piecewise', rate: UNIT_RATE })).toThrow('UnknownTimeMap');
    expect(() => affineTimeMap(ZERO_TIME)).toThrow('NonPositiveRate');
    expect(() => affineTimeMap(exactTime(-1))).toThrow('NonPositiveRate');
    expect(() => readContentTiming({ time_map: affineTimeMap(), content_in: exactTime(2), content_out: exactTime(1) })).toThrow('InvalidRange');
  });

  it('rejects overflow instead of rounding it or leaking a previous Wasm result', () => {
    const max = exactTime(Number.MAX_SAFE_INTEGER);
    expect(() => addTime(max, UNIT_RATE)).toThrow('Overflow');
    expect(() => exactTime(Number.MAX_SAFE_INTEGER + 1)).toThrow('InvalidNumber');
    expect(() => divideTime(UNIT_RATE, ZERO_TIME)).toThrow('ZeroDenominator');
    expect(divideTime(max, max)).toEqual(UNIT_RATE);
  });
});

describe('content time is independent of timeline placement and display grids', () => {
  const original = () => contentTiming(exactTime(7, 3), exactTime(10_000_007, 3), exactTime(7, 3));

  it('keeps source phase through repeated NTSC and audio-grid splits', () => {
    for (const fps of [30_000, 48_000]) {
      let right = original();
      let previous = 0;
      for (let i = 1; i <= 300; i++) {
        const at = timeUsAtFrame(i, fps, fps === 30_000 ? 1001 : 1);
        const delta = exactTime(at - previous);
        const left = sliceTiming(right, range(ZERO_TIME, delta));
        const next = sliceTiming(right, range(delta, addTime(delta, exactTime(1_000_000))));
        expect(left.content_out).toEqual(next.content_in);
        expect(next.content_in).toEqual(mapContentTime(original(), exactTime(at)));
        expect(mapContentTime(next, exactTime(13, 7))).toEqual(mapContentTime(original(), addTime(exactTime(at), exactTime(13, 7))));
        right = next;
        previous = at;
      }
    }
  });

  it('clips inverse ranges to the selected window unless handle extension is requested', () => {
    const timing = contentTiming(exactTime(10), exactTime(30), exactTime(2));
    expect(projectContentRange(timing, range(exactTime(0), exactTime(20)))).toEqual([range(exactTime(0), exactTime(5))]);
    expect(projectContentRange(timing, range(exactTime(0), exactTime(20)), true)).toEqual([range(exactTime(-5), exactTime(5))]);
    expect(projectContentRange(timing, range(exactTime(30), exactTime(40)))).toEqual([]);
    expect(() => projectContentRange(timing, range(exactTime(20), exactTime(10)))).toThrow('InvalidRange');
  });

  it('composes nested Group mappings without intermediate rounding', () => {
    const outer = contentTiming(exactTime(7, 3), exactTime(1000), exactTime(1001, 1000));
    const inner = contentTiming(exactTime(1, 7), exactTime(10), exactTime(3, 2));
    const combined = composeTiming(outer, inner);
    fc.assert(fc.property(fc.integer({ min: -1000, max: 1000 }), (n) => {
      const local = exactTime(n, 17);
      expect(mapContentTime(combined, local)).toEqual(mapContentTime(outer, mapContentTime(inner, local)));
    }));
  });

  it('preserves content and all key times after repeated retime round trips', () => {
    const before = original();
    const oldDuration = timingDuration(before);
    let timing = before;
    let duration = oldDuration;
    let keys = [exactTime(-100), exactTime(100), exactTime(101), exactTime(5_000_000)];
    const initial = keys;
    for (let i = 0; i < 100; i++) {
      const next = i % 2 ? oldDuration : exactTime(1000);
      keys = keys.map((t) => retimeAnimationTime(t, duration, next));
      timing = retimeTiming(timing, next);
      duration = next;
      expect(timing.content_in).toEqual(before.content_in);
      expect(timing.content_out).toEqual(before.content_out);
      expect(compareTime(keys[1]!, keys[2]!)).toBe(-1);
    }
    expect(timing).toEqual(before);
    expect(keys).toEqual(initial);
  });

  it('is exactly invertible across noninteger rates and negative local queries', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      (num, den, local) => {
        const rate = exactTime(num, den);
        const timing = contentTiming(exactTime(1, 7), exactTime(10_000_000), rate);
        const content = mapContentTime(timing, exactTime(local));
        expect(divideTime(subtractTime(content, timing.content_in), rate)).toEqual(exactTime(local));
        expect(multiplyTime(rate, divideTime(UNIT_RATE, rate))).toEqual(UNIT_RATE);
      },
    ));
  });
});
