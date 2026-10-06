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
