/** User intent is deliberately smaller than the runtime allocation contract.
 * All sizes are MiB. Targets are cooperative, never OS memory/CPU hard caps. */
export const RESOURCE_CAPACITY_EXCEEDED = 'resource-capacity-exceeded';
export const isResourceCapacityError = (error: unknown): boolean => String(error).includes(RESOURCE_CAPACITY_EXCEEDED);

export interface ResourcePolicy {
  version: 2;
  memory_mib: number | null;
  processing: 'low' | 'balanced' | 'high';
  /** null follows the size of the Workspace's disk (ADR 0150). */
  disk_cache_mib: number | null;
  background_playback: boolean;
}
export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = Object.freeze({
  version: 2, memory_mib: null, processing: 'balanced', disk_cache_mib: null, background_playback: false,
});
export type ResourcePolicyPatch = Partial<Omit<ResourcePolicy, 'version'>>;
export const RESOURCE_MEMORY_RANGE = { min: 1024, max: 262144 } as const;
export const RESOURCE_DISK_RANGE = { min: 256, max: 1048576 } as const;
/** Automatic temporary cache space: a tenth of the disk's total size, within 4–64 GiB. */
export const AUTOMATIC_DISK_RANGE = { min: 4096, max: 65536 } as const;
// Version 1 wrote its fixed 2 GiB default into every saved policy, so that
// value cannot be told apart from a user's choice; it becomes automatic.
const LEGACY_DISK_DEFAULT_MIB = 2048;
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
export function readResourcePolicy(value: unknown): ResourcePolicy {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ResourcePolicy> : {};
  const disk = integer(p.disk_cache_mib, RESOURCE_DISK_RANGE.min, RESOURCE_DISK_RANGE.max) ? p.disk_cache_mib : null;
  return { version: 2,
    memory_mib: integer(p.memory_mib, RESOURCE_MEMORY_RANGE.min, RESOURCE_MEMORY_RANGE.max) ? p.memory_mib : null,
    processing: p.processing === 'low' || p.processing === 'high' ? p.processing : 'balanced',
    disk_cache_mib: p.version !== 2 && disk === LEGACY_DISK_DEFAULT_MIB ? null : disk,
    background_playback: typeof p.background_playback === 'boolean' ? p.background_playback : false,
  };
}
export function patchResourcePolicy(current: ResourcePolicy, patch: unknown): ResourcePolicy {
  if (patch === null) return { ...DEFAULT_RESOURCE_POLICY };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid resource settings');
  const p = patch as Record<string, unknown>;
  for (const [key, value] of Object.entries(p)) {
    const valid = key === 'memory_mib' ? value === null || integer(value, RESOURCE_MEMORY_RANGE.min, RESOURCE_MEMORY_RANGE.max)
      : key === 'disk_cache_mib' ? value === null || integer(value, RESOURCE_DISK_RANGE.min, RESOURCE_DISK_RANGE.max)
      : key === 'processing' ? typeof value === 'string' && ['low', 'balanced', 'high'].includes(value)
      : key === 'background_playback' && typeof value === 'boolean';
    if (!valid) throw new Error(`Invalid resource setting: ${key}`);
  }
  return readResourcePolicy({ ...current, ...p, version: 2 });
}
/** Internal projection. Never presented as independently editable preferences. */
export interface ResourceAllocation {
  memory_mib: number;
  cache_mib: number;
  work_mib: number;
  export_mib: number;
  cpu_threads: number;
  task_threads: number;
  background_jobs: number;
  disk_cache_mib: number;
  background_playback: boolean;
}
/** An unknown disk size resolves to the automatic floor. */
export function automaticDiskCacheMiB(diskMiB?: number): number {
  if (diskMiB === undefined || !Number.isFinite(diskMiB)) return AUTOMATIC_DISK_RANGE.min;
  return Math.max(AUTOMATIC_DISK_RANGE.min, Math.min(AUTOMATIC_DISK_RANGE.max, Math.floor(diskMiB * .1 / 256) * 256));
}
export function resolveResourcePolicy(policy: ResourcePolicy, memoryMiB = 8192, cores = 4, diskMiB?: number): ResourceAllocation {
  const memory = policy.memory_mib ?? Math.max(1024, Math.min(32768, Math.floor(memoryMiB * .35 / 256) * 256));
  // Maximum processing uses the runtime's entire available CPU allocation,
  // including both sockets. The caller supplies affinity/cgroup-aware capacity;
  // never substitute a fixed desktop-sized thread count.
  const fraction = { low: .25, balanced: .5, high: 1 }[policy.processing];
  const cpu = Math.max(1, Math.floor(Math.max(1, cores) * fraction));
  return Object.freeze({ memory_mib: memory, cache_mib: Math.floor(memory * .25), work_mib: Math.floor(memory * .4),
    export_mib: Math.max(64, Math.floor(memory * .125)),
    cpu_threads: cpu, task_threads: policy.processing === 'high' ? cpu : Math.max(1, Math.floor(cpu / 2)),
    background_jobs: Math.max(1, Math.min(8, Math.floor(cpu / 2))),
    disk_cache_mib: policy.disk_cache_mib ?? automaticDiskCacheMiB(diskMiB), background_playback: policy.background_playback });
}
let allocation = resolveResourcePolicy(DEFAULT_RESOURCE_POLICY);
let managed = false;
export function resourceManagementEnabled(): boolean { return managed; }
let rendererShare = 1;
export function resourceAllocation(): ResourceAllocation { return allocation; }
export function hydrateResourceAllocation(value?: ResourceAllocation): void { managed = !!value; if (value) allocation = Object.freeze({ ...value }); }
export function setRendererResourceShare(count: number): void { rendererShare = Math.max(1, count); }
export function rendererResourceShare(): number { return rendererShare; }

export interface ResourceStatus {
  memory_mib: number | null;
  /** Host RAM available for use, including reclaimable pages. */
  available_memory_mib?: number;
  memory_scope: 'electron' | 'process-tree' | 'unavailable';
  pressure: 'normal' | 'constrained';
  active: number;
  waiting: number;
  reserved_mib: number;
  cpu_threads: number;
}
