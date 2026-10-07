import { createRequire } from 'node:module';
import type { ResourceAllocation, ResourceStatus } from '../shared/resource-policy';
import { resourceAllocation, RESOURCE_CAPACITY_EXCEEDED } from '../shared/resource-policy';

interface ResourceMemorySample { processMib: number; availableMib: number }
interface NativeResources {
  resourcesConfigure(json: string): void;
  resourcesReserve(threads: number, memoryMiB: number): number;
  resourcesRelease(id: number): void;
  resourcesActivity(playing: boolean, pressured: boolean): void;
  resourcesSnapshot(): string;
  resourcesMemory(): Promise<ResourceMemorySample>;
  resourcesCacheWritten(immediate: boolean): Promise<void>;
}
let native: NativeResources | undefined;
const getNative = () => native ??= createRequire(import.meta.url)('@weftcut/core') as NativeResources;

/** The native authority is also used by native background jobs. No per-window
 * semaphore can manufacture additional compute or working-memory capacity. */
export function configureResources(allocation: ResourceAllocation): void {
  getNative().resourcesConfigure(JSON.stringify(allocation));
  void getNative().resourcesCacheWritten(true).catch(error => console.warn('Cache maintenance could not start', error));
}
export function reserveDecoderResources(path: string): () => void {
  if (!native) return () => {}; // isolated managers/tests; app bootstrap installs the authority
  const decode = createRequire(import.meta.url)('@weftcut/native-decode') as {
    configureDecodeThreads(threads: number): void; decodeMemoryMib(path: string): number;
  };
  const threads = resourceAllocation().task_threads;
  decode.configureDecodeThreads(threads);
  // Resident decoders retain memory, not an exclusive background execution
  // slot. Per-session thread caps still follow processing effort.
  return reserveResources(0, decode.decodeMemoryMib(path));
}
export function reserveResources(threads: number, memoryMiB: number): () => void {
  if (!native) return () => {};
  const owner = getNative();
  let id: number;
  try { id = owner.resourcesReserve(threads, Math.ceil(memoryMiB)); }
  catch (error) { throw new Error(`${RESOURCE_CAPACITY_EXCEEDED}: ${String(error)}`); }
  let live = true;
  return () => { if (live) { live = false; owner.resourcesRelease(id); } };
}
export function setResourceActivity(playing: boolean, pressured: boolean): void {
  getNative().resourcesActivity(playing, pressured);
}
export function resourceSnapshot(): Pick<ResourceStatus, 'active' | 'waiting' | 'reserved_mib' | 'cpu_threads'> {
  return JSON.parse(getNative().resourcesSnapshot());
}
export function processTreeMemory(): Promise<ResourceMemorySample> { return getNative().resourcesMemory(); }
export function notifyResourceCacheWrite(): void {
  void native?.resourcesCacheWritten(false).catch(error => console.warn('Cache maintenance could not start', error));
}

/** Hysteresis is kept separate from sampling so missing telemetry never clears
 * a known pressure state or prevents settings from being saved. */
export function createMemoryPressure() {
  let pressured = false;
  return {
    update(usedMiB: number | null, targetMiB: number, availableMiB: number) {
      if (usedMiB !== null) {
        if (usedMiB > targetMiB || availableMiB < 256) pressured = true;
        else if (usedMiB < targetMiB * .8 && availableMiB > 512) pressured = false;
      }
      return pressured;
    },
  };
}
