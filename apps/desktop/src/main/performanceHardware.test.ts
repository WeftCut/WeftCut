import { expect, it } from 'vitest';
import { describePerformanceGraphics } from './performanceHardware';

it('reports the active Apple Silicon adapter and unified memory without inventing capacity', () => {
  expect(describePerformanceGraphics({ gpuDevice: [
    { active: false, deviceString: 'Inactive adapter' },
    { active: true, vendorId: 0x106b, deviceString: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M-test, Version 26.0)' },
  ] }, 'darwin', 'arm64')).toEqual({ name: 'Apple M-test', memory_kind: 'unified' });
});

it('keeps unmeasured memory unknown on other adapters and software rendering', () => {
  const info = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceString: 'Example GPU' }] };
  for (const platform of ['win32', 'linux', 'darwin']) {
    expect(describePerformanceGraphics(info, platform, 'arm64')).toEqual({ name: 'Example GPU', memory_kind: 'unknown' });
  }
  expect(describePerformanceGraphics({ gpuDevice: [{ active: true, vendorId: 0xffff, deviceString: 'SwiftShader' }] }, 'darwin', 'arm64').memory_kind).toBe('unknown');
});

it('preserves unknown identity when telemetry is incomplete', () => {
  expect(describePerformanceGraphics(null, 'darwin', 'arm64')).toEqual({ name: null, memory_kind: 'unknown' });
  expect(describePerformanceGraphics({ gpuDevice: [{ active: true, vendorId: 0x106b }] }, 'darwin', 'arm64')).toEqual({ name: null, memory_kind: 'unified' });
});
