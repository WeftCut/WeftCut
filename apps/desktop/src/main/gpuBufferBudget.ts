import { MIB, performanceSettings } from '../shared/performance-settings';
import { reserveResources } from './resources';

export type GpuBufferKind = 'preview' | 'motif';
export interface GpuBufferLease { readonly kind: GpuBufferKind; readonly bytes: number }

/** Includes pending allocations and retired textures still held by Chromium.
 * Lowering a limit refuses new allocations without revoking live resources. */
export function createGpuBufferBudget(limitBytes: () => number) {
  const leases = new Set<GpuBufferLease>();
  const releases = new Map<GpuBufferLease, () => void>();
  let usedBytes = 0;
  return {
    reserve(kind: GpuBufferKind, bytes: number): GpuBufferLease | null {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || usedBytes + bytes > limitBytes()) return null;
      const release = reserveResources(0, bytes / MIB);
      const lease = Object.freeze({ kind, bytes });
      releases.set(lease, release);
      leases.add(lease); usedBytes += bytes;
      return lease;
    },
    release(lease: GpuBufferLease | null | undefined) {
      if (!lease || !leases.delete(lease)) return;
      releases.get(lease)?.(); releases.delete(lease);
      usedBytes -= lease.bytes;
    },
    snapshot() {
      let preview = 0, motif = 0;
      for (const lease of leases) {
        if (lease.kind === 'preview') preview += lease.bytes;
        else motif += lease.bytes;
      }
      return { used_bytes: usedBytes, limit_bytes: limitBytes(), preview_bytes: preview, motif_bytes: motif };
    },
  };
}

export type GpuBufferBudget = ReturnType<typeof createGpuBufferBudget>;
/** A pool keeps its byte credits until both retirement and every imported
 * texture's final-reference callback. Each callback is idempotent. */
export function retainGpuBufferLease(budget: GpuBufferBudget, lease: GpuBufferLease) {
  let references = 0, retired = false;
  const release = () => { if (retired && references === 0) budget.release(lease); };
  return {
    reference() {
      if (retired) throw new Error('Cannot import a retired GPU buffer');
      references++;
      let alive = true;
      return () => { if (!alive) return; alive = false; references--; release(); };
    },
    retire() { retired = true; release(); },
  };
}
export const gpuBufferBudget = createGpuBufferBudget(() => performanceSettings().gpu_buffer_mib * MIB);
