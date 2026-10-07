import type { PerformanceGraphicsHardware } from '../shared/performance-budgets';

/** Adapter identity is portable; dedicated capacity remains a separate native
 * measurement. Apple Silicon graphics shares system RAM, not a second budget. */
export function describePerformanceGraphics(info: unknown, platform: string, arch: string): PerformanceGraphicsHardware {
  const value = info as { gpuDevice?: Array<{ active?: boolean; deviceString?: string; vendorId?: number }>; auxAttributes?: { glRenderer?: string } } | null;
  const devices = Array.isArray(value?.gpuDevice) ? value.gpuDevice : [];
  const device = devices.find(device => device?.active) ?? devices[0];
  const renderer = device?.deviceString ?? value?.auxAttributes?.glRenderer;
  const name = typeof renderer === 'string' && renderer.trim()
    ? (renderer.match(/ANGLE Metal Renderer:\s*(.*?), Version\b/)?.[1] ?? renderer).trim() : null;
  return { name, memory_kind: platform === 'darwin' && arch === 'arm64' && device?.vendorId === 0x106b ? 'unified' : 'unknown' };
}
