import { expect, it } from 'vitest';
import { createMemoryPressure, MEMORY_SAMPLE_TTL_MS } from './resources';
it('does not oscillate around the target or clear pressure on missing telemetry', () => {
  const pressure = createMemoryPressure();
  expect(pressure.update(1100, 1024, 2048)).toBe(true);
  expect(pressure.update(null, 1024, 2048)).toBe(true);
  expect(pressure.update(1000, 1024, 2048)).toBe(true);
  expect(pressure.update(700, 1024, 2048)).toBe(false);
  expect(pressure.update(700, 1024, 200)).toBe(true);
});

it('updates host pressure independently when process telemetry is missing', () => {
  const pressure = createMemoryPressure();
  expect(pressure.update(2500, 2304, 24000)).toBe(true);
  expect(pressure.update(1880, 2304, 24000)).toBe(true);
  expect(pressure.critical()).toBe(false);
  pressure.update(1880, 2304, 200);
  expect(pressure.critical()).toBe(true);
  pressure.update(null, 2304, 24000);
  expect(pressure.critical()).toBe(false);
  pressure.update(1880, 2304, 200);
  pressure.update(1880, 2304, 400);
  expect(pressure.critical()).toBe(true);
  expect(pressure.update(1880, 2304, 24000)).toBe(true);
  expect(pressure.critical()).toBe(false);
});

it('holds pressure through a brief gap and expires it before interactive admission times out', () => {
  let at = 0;
  const pressure = createMemoryPressure(() => at);
  expect(pressure.update(2500, 2304, 0)).toBe(true);
  expect(pressure.critical()).toBe(true);
  at = MEMORY_SAMPLE_TTL_MS - 1;
  expect(pressure.update(null, 2304, null)).toBe(true);
  at++;
  expect(pressure.update(null, 2304, null)).toBe(false);
  expect(pressure.critical()).toBe(false);
  expect(pressure.readings()).toEqual({ processMib: null, availableMib: null });
  expect(pressure.update(510, 2304, 200)).toBe(true);
});

it('expires missing host telemetry while continuing to enforce fresh app usage', () => {
  let at = 0;
  const pressure = createMemoryPressure(() => at);
  pressure.update(2500, 2304, 200);
  at = MEMORY_SAMPLE_TTL_MS;
  expect(pressure.update(2500, 2304, null)).toBe(true);
  expect(pressure.critical()).toBe(false);
  expect(pressure.readings()).toEqual({ processMib: 2500, availableMib: null });
  expect(pressure.update(510, 2304, null)).toBe(false);
});

it('expires missing app telemetry while continuing to enforce fresh host pressure', () => {
  let at = 0;
  const pressure = createMemoryPressure(() => at);
  pressure.update(2500, 2304, 200);
  at = MEMORY_SAMPLE_TTL_MS;
  expect(pressure.update(null, 2304, 200)).toBe(true);
  expect(pressure.critical()).toBe(true);
  expect(pressure.readings()).toEqual({ processMib: null, availableMib: 200 });
  expect(pressure.update(null, 2304, 2048)).toBe(false);
});

it.each([NaN, Infinity, -1, undefined, null])('does not convert invalid host telemetry (%s) into pressure', available => {
  const pressure = createMemoryPressure();
  expect(pressure.update(510, 2304, available)).toBe(false);
  expect(pressure.critical()).toBe(false);
  expect(pressure.readings().availableMib).toBeNull();
});

it('does not refresh old pressure with invalid samples and keeps real zero valid', () => {
  let at = 0;
  const pressure = createMemoryPressure(() => at);
  expect(pressure.update(510, 2304, 0)).toBe(true);
  at = MEMORY_SAMPLE_TTL_MS - 1;
  expect(pressure.update(NaN, 2304, Infinity)).toBe(true);
  at++;
  expect(pressure.update(-1, 2304, -1)).toBe(false);
  expect(pressure.readings()).toEqual({ processMib: null, availableMib: null });
});

it('re-evaluates fresh app usage against a changed memory target', () => {
  const pressure = createMemoryPressure();
  expect(pressure.update(2500, 2304, 2048)).toBe(true);
  expect(pressure.update(null, 4096, null)).toBe(false);
});
