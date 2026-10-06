import { MIB, performanceSettings, sharedResourceAllocationEnabled } from '../../shared/performance-settings';
import { resourceAllocation, rendererResourceShare, resourceManagementEnabled } from '../../shared/resource-policy';
import { resourcePressure } from './resourceClient';

export type CacheKind = 'frame_ring_mib' | 'motif_cache_mib' | 'filmstrip_cache_mib' | 'waveform_cache_mib';
const kinds: CacheKind[] = ['frame_ring_mib', 'motif_cache_mib', 'filmstrip_cache_mib', 'waveform_cache_mib'];

/** Soft retention budget: unused shares can be borrowed, then reclaimed when
 * another cache needs them. Owners alone decide which pictures are safe to free.
 * Playback floors and pinned pictures may exceed the target temporarily. */
export function createCacheBudget(base: () => Record<CacheKind, number>, enabled: () => boolean) {
  const owners = new Map<object, { kind: CacheKind; bytes: number; trim?: () => void }>();
  let trimming = false;
  const usage = () => {
    const result: Record<CacheKind, number> = { frame_ring_mib: 0, motif_cache_mib: 0, filmstrip_cache_mib: 0, waveform_cache_mib: 0 };
    for (const entry of owners.values()) result[entry.kind] += entry.bytes;
    return result;
  };
  const allowance = (kind: CacheKind) => {
    const shares = base();
    if (!enabled()) return shares[kind];
    const used = usage();
    const total = kinds.reduce((sum, key) => sum + shares[key], 0);
    const others = kinds.reduce((sum, key) => sum + (key === kind ? 0 : used[key]), 0);
    return Math.max(shares[kind], total - others);
  };
  const maintain = () => {
    if (trimming || !enabled()) return;
    const used = usage(), shares = base();
    if (kinds.reduce((sum, key) => sum + used[key], 0) <= kinds.reduce((sum, key) => sum + shares[key], 0)) return;
    trimming = true;
    try {
      // Reclaim borrowed cache first. Frame rings retain their existing forward
      // floors and drain naturally; they never expose an unsafe forced eviction.
      const ordered = [...owners.values()].sort((a, b) => (used[b.kind] - shares[b.kind]) - (used[a.kind] - shares[a.kind]));
      for (const entry of ordered) entry.trim?.();
    } finally { trimming = false; }
  };
  return {
    allowance,
    ownerAllowance(kind: CacheKind, owner: object) {
      if (!enabled()) return base()[kind];
      const count = [...owners.entries()].filter(([key, e]) => e.kind === kind && (e.bytes > 0 || key === owner)).length;
      return allowance(kind) / Math.max(1, count);
    },
    update(owner: object, kind: CacheKind, bytes: number, trim?: () => void) {
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid cache accounting');
      if (bytes === 0) owners.delete(owner);
      else owners.set(owner, { kind, bytes, ...(trim ? { trim } : {}) });
      maintain();
    },
    release(owner: object) { owners.delete(owner); },
    maintain,
    snapshot() {
      const used = usage();
      return { used, total: kinds.reduce((sum, key) => sum + used[key], 0),
        limit: kinds.reduce((sum, key) => sum + base()[key], 0), shared: enabled() };
    },
  };
}

export const cacheBudget = createCacheBudget(() => {
  const settings = performanceSettings();
  const requested = kinds.reduce((sum, kind) => sum + settings[kind], 0);
  const available = resourceAllocation().cache_mib / rendererResourceShare() * (resourcePressure() ? .5 : 1);
  const scale = resourceManagementEnabled() ? Math.min(1, available / requested) : 1;
  return Object.fromEntries(kinds.map(kind => [kind, settings[kind] * MIB * scale])) as Record<CacheKind, number>;
}, () => resourceManagementEnabled() || sharedResourceAllocationEnabled());
