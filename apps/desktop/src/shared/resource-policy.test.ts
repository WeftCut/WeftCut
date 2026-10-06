import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_POLICY, patchResourcePolicy, readResourcePolicy, resolveResourcePolicy } from './resource-policy';

describe('application resource intent', () => {
  it('scales processing and memory independently on small and large machines', () => {
    const small = resolveResourcePolicy(DEFAULT_RESOURCE_POLICY, 4096, 2);
    const large = resolveResourcePolicy(DEFAULT_RESOURCE_POLICY, 65536, 32);
    expect(small.memory_mib).toBeLessThan(large.memory_mib);
    expect(small.cpu_threads).toBeLessThan(large.cpu_threads);
    const changed = resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, processing: 'low', memory_mib: 4096 }, 65536, 32);
    expect(changed.memory_mib).toBe(4096);
    expect(changed.cpu_threads).toBeLessThan(large.cpu_threads);
    expect(changed.cache_mib + changed.work_mib).toBeLessThan(changed.memory_mib);
  });
  it('rejects invalid edits atomically and recovers malformed disk fields', () => {
    expect(() => patchResourcePolicy(DEFAULT_RESOURCE_POLICY, { memory_mib: 2048, processing: 'turbo' })).toThrow();
    expect(() => patchResourcePolicy(DEFAULT_RESOURCE_POLICY, { cpu_threads: 999 })).toThrow();
    expect(() => patchResourcePolicy(DEFAULT_RESOURCE_POLICY, { processing: ['low'] })).toThrow();
    expect(readResourcePolicy({ memory_mib: -1, processing: 'high', disk_cache_mib: '2' })).toEqual({
      ...DEFAULT_RESOURCE_POLICY, processing: 'high',
    });
  });
  it('restores automatic machine defaults without accepting internal allocation fields', () => {
    expect(patchResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, memory_mib: 8192 }, null)).toEqual(DEFAULT_RESOURCE_POLICY);
    expect(resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, memory_mib: 6144 }, 8192, 4).memory_mib).toBe(6144);
  });
});
