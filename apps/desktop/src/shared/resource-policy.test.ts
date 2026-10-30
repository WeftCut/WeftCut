import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_POLICY, automaticDiskCacheMiB, patchResourcePolicy, readResourcePolicy, resolveResourcePolicy } from './resource-policy';

describe('application resource intent', () => {
  it('uses all available threads in maximum mode without an eight-core ceiling', () => {
    for (const cores of [2, 8, 36, 72, 128]) {
      const allocation = resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, processing: 'high' }, 65536, cores);
      expect(allocation.cpu_threads).toBe(cores);
      expect(allocation.task_threads).toBe(cores);
    }
    expect(resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, processing: 'low' }, 65536, 72).cpu_threads).toBe(18);
  });
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
  it('sizes automatic temporary cache space from the disk size within 4–64 GiB', () => {
    expect(automaticDiskCacheMiB(undefined)).toBe(4096);
    expect(automaticDiskCacheMiB(20 * 1024)).toBe(4096);
    expect(automaticDiskCacheMiB(100 * 1024)).toBe(10240);
    expect(automaticDiskCacheMiB(4 * 1024 * 1024)).toBe(65536);
    expect(resolveResourcePolicy(DEFAULT_RESOURCE_POLICY, 8192, 4, 100 * 1024).disk_cache_mib).toBe(10240);
    expect(resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, disk_cache_mib: 1024 }, 8192, 4, 100 * 1024).disk_cache_mib).toBe(1024);
  });
  it('treats the saved version-1 default as automatic but keeps explicit choices', () => {
    expect(readResourcePolicy({ version: 1, disk_cache_mib: 2048 }).disk_cache_mib).toBeNull();
    expect(readResourcePolicy({ version: 1, disk_cache_mib: 3072 }).disk_cache_mib).toBe(3072);
    expect(readResourcePolicy({ version: 2, disk_cache_mib: 2048 }).disk_cache_mib).toBe(2048);
    const chosen = patchResourcePolicy(readResourcePolicy({ version: 1, disk_cache_mib: 2048 }), { disk_cache_mib: 2048 });
    expect(readResourcePolicy(JSON.parse(JSON.stringify(chosen))).disk_cache_mib).toBe(2048);
    expect(patchResourcePolicy(chosen, { disk_cache_mib: null }).disk_cache_mib).toBeNull();
  });
  it('restores automatic machine defaults without accepting internal allocation fields', () => {
    expect(patchResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, memory_mib: 8192 }, null)).toEqual(DEFAULT_RESOURCE_POLICY);
    expect(resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, memory_mib: 6144 }, 8192, 4).memory_mib).toBe(6144);
  });
});
