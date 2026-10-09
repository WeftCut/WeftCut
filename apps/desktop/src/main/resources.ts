import { createRequire } from 'node:module';
import type { ResourceAllocation, ResourceStatus } from '../shared/resource-policy';
import { resourceAllocation, RESOURCE_CAPACITY_EXCEEDED } from '../shared/resource-policy';

export interface ResourceMemorySample { processMib: number; availableMib?: number | null }
interface NativeResources {
  resourcesConfigure(json: string): void;
  resourcesPlanExport(options: string, nativeEncoder: boolean): string;
  resourcesWaitForChange(revision: number): Promise<void>;
  resourcesReserve(threads: number, memoryMiB: number, finalizationId?: number): number;
  resourcesRelease(id: number): void;
  resourcesReserveFinalization(): number;
  resourcesActivity(playing: boolean, pressured: boolean, critical: boolean): void;
  resourcesSnapshot(): string;
  resourcesMemory(): Promise<ResourceMemorySample>;
  resourcesCacheWritten(immediate: boolean): Promise<void>;
  resourcesRetainRaster(paths: string[]): void;
}
let native: NativeResources | undefined;
const getNative = () => native ??= createRequire(import.meta.url)('@weftcut/core') as NativeResources;

/** The native authority is also used by native background jobs. No per-window
 * semaphore can manufacture additional compute or working-memory capacity. */
export function configureResources(allocation: ResourceAllocation): void {
  getNative().resourcesConfigure(JSON.stringify(allocation));
  void getNative().resourcesCacheWritten(true).catch(error => console.warn('Cache maintenance could not start', error));
}
export function decoderResourceMiB(path: string): number {
  return (createRequire(import.meta.url)('@weftcut/native-decode') as { decodeMemoryMib(path: string): number }).decodeMemoryMib(path);
}
export function tryExportPlan(options: number[], nativeEncoder: boolean): import('../shared/export-resources').ExportAdmission {
  return JSON.parse(getNative().resourcesPlanExport(JSON.stringify(options), nativeEncoder));
}
export function waitForResourceChange(revision: number): Promise<void> { return getNative().resourcesWaitForChange(revision); }
export function releaseResourceId(id: number): void { getNative().resourcesRelease(id); }
export function reserveDecoderResources(path: string, finalizationId?: number): () => void {
  if (!native) return () => {}; // isolated managers/tests; app bootstrap installs the authority
  const decode = createRequire(import.meta.url)('@weftcut/native-decode') as {
    configureDecodeThreads(threads: number): void; decodeMemoryMib(path: string): number;
  };
  const threads = resourceAllocation().task_threads;
  decode.configureDecodeThreads(threads);
  // Resident decoders retain memory, not an exclusive background execution
  // slot. Per-session thread caps still follow processing effort.
  return reserveResources(0, decode.decodeMemoryMib(path), finalizationId);
}
export function reserveResources(threads: number, memoryMiB: number, finalizationId?: number): () => void {
  if (!native) return () => {};
  const owner = getNative();
  let id: number;
  try { id = owner.resourcesReserve(threads, Math.ceil(memoryMiB), finalizationId); }
  catch (error) { throw new Error(`${RESOURCE_CAPACITY_EXCEEDED}: ${String(error)}`); }
  let live = true;
  return () => { if (live) { live = false; owner.resourcesRelease(id); } };
}
export function reserveExportFinalization(): { nativeId: number; release: () => void } {
  const owner = getNative();
  const nativeId = owner.resourcesReserveFinalization();
  return { nativeId, release: () => owner.resourcesRelease(nativeId) };
}
export function setResourceActivity(playing: boolean, pressured: boolean, critical = pressured): void {
  getNative().resourcesActivity(playing, pressured, critical);
  backgroundPause = pressured ? 'memory' : playing && !resourceAllocation().background_playback ? 'playback' : undefined;
  for (const notify of resourceObservers) notify();
}
let backgroundPause: 'memory' | 'playback' | undefined;
const resourceObservers = new Set<() => void>();
export function backgroundResourcePause(): 'memory' | 'playback' | undefined { return backgroundPause; }
export function onBackgroundResourceChange(notify: () => void): () => void {
  resourceObservers.add(notify); return () => { resourceObservers.delete(notify); };
}
export function retainRasterDirectories(paths: string[]): void { getNative().resourcesRetainRaster(paths); }
export function resourceSnapshot(): Pick<ResourceStatus, 'active' | 'waiting' | 'reserved_mib' | 'cpu_threads'> {
  return JSON.parse(getNative().resourcesSnapshot());
}
export function processTreeMemory(): Promise<ResourceMemorySample> { return getNative().resourcesMemory(); }
export function notifyResourceCacheWrite(): void {
  void native?.resourcesCacheWritten(false).catch(error => console.warn('Cache maintenance could not start', error));
}

/** Keep brief telemetry gaps from toggling admission, but expire each signal
 * before the 15-second interactive deadline. Reservations still limit work
 * when OS telemetry is unavailable. Zero is valid; missing/invalid is not. */
export const MEMORY_SAMPLE_TTL_MS = 10_000;
export function createMemoryPressure(now: () => number = () => performance.now()) {
  type Reading = { value: number; at: number };
  let process: Reading | null = null;
  let host: Reading | null = null;
  let appPressure = false;
  let critical = false;
  const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return {
    critical: () => critical,
    readings: () => ({ processMib: process?.value ?? null, availableMib: host?.value ?? null }),
    update(usedMiB: number | null, targetMiB: number, availableMiB: number | null | undefined) {
      const at = now();
      if (valid(usedMiB)) process = { value: usedMiB, at };
      if (valid(availableMiB)) host = { value: availableMiB, at };
      if (process && at - process.at >= MEMORY_SAMPLE_TTL_MS) process = null;
      if (host && at - host.at >= MEMORY_SAMPLE_TTL_MS) host = null;
      if (!process) appPressure = false;
      else if (process.value > targetMiB) appPressure = true;
      else if (process.value < targetMiB * .8) appPressure = false;
      if (!host) critical = false;
      else if (host.value < 256) critical = true;
      else if (host.value > 512) critical = false;
      return appPressure || critical;
    },
  };
}
