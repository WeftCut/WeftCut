import { expect, it } from 'vitest';
import { createMemoryPressure } from './resources';
it('does not oscillate around the target or clear pressure on missing telemetry', () => {
  const pressure = createMemoryPressure();
  expect(pressure.update(1100, 1024, 2048)).toBe(true);
  expect(pressure.update(null, 1024, 2048)).toBe(true);
  expect(pressure.update(1000, 1024, 2048)).toBe(true);
  expect(pressure.update(700, 1024, 2048)).toBe(false);
  expect(pressure.update(700, 1024, 200)).toBe(true);
});

it('distinguishes RSS hysteresis from critical host pressure without clearing stale telemetry', () => {
  const pressure = createMemoryPressure();
  expect(pressure.update(2500, 2304, 24000)).toBe(true);
  expect(pressure.update(1880, 2304, 24000)).toBe(true);
  expect(pressure.critical()).toBe(false);
  pressure.update(1880, 2304, 200);
  expect(pressure.critical()).toBe(true);
  pressure.update(null, 2304, 24000);
  expect(pressure.critical()).toBe(true);
  pressure.update(1880, 2304, 400);
  expect(pressure.critical()).toBe(true);
  expect(pressure.update(1880, 2304, 24000)).toBe(true);
  expect(pressure.critical()).toBe(false);
});
