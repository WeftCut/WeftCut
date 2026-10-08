import { isResourceCapacityError, resourceAllocation, setRendererResourceShare } from '../../shared/resource-policy';

/** Test/standalone renderers have no bridge. Production always installs it. */
let workerAcquire: ((memoryMiB: number, threads: number) => Promise<() => void>) | null = null;
export function installWorkerResourceClient(acquire: (memoryMiB: number, threads: number) => Promise<() => void>): void { workerAcquire = acquire; }
export async function acquireRenderResources(memoryMiB: number, threads = 0, finalizationToken?: string): Promise<() => void> {
  if (workerAcquire) return workerAcquire(Math.max(1, Math.ceil(memoryMiB)), threads);
  if (typeof window === 'undefined' || !window.api?.resources) return () => {};
  const id = crypto.randomUUID();
  await window.api.resources.acquire({ id, memoryMiB: Math.max(1, Math.ceil(memoryMiB)), threads, ...(finalizationToken ? { finalizationToken } : {}) });
  let live = true;
  return () => { if (live) { live = false; window.api.resources.release(id); } };
}

/** Export can race finite background work for memory, just as the native
 * encoder races it for CPU. Wait without holding another lease or changing
 * the authority's limits. Preview admission keeps its fail-fast behavior. */
export async function acquireExportResources(memoryMiB: number, threads = 0, finalizationToken?: string, signal?: AbortSignal): Promise<() => void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const release = await acquireRenderResources(memoryMiB, threads, finalizationToken);
      if (signal?.aborted) { release(); signal.throwIfAborted(); }
      return release;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isResourceCapacityError(error) || remaining <= 0 || Math.ceil(memoryMiB) > resourceAllocation().work_mib) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal!.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.min(100, remaining));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }
}
let constrained = false;
let playing = false;
const changed = new Set<() => void>();
export function setResourcePlayback(value: boolean): void { playing = value; for (const notify of changed) notify(); }
export function notifyResourceSettingsChanged(): void { for (const notify of changed) notify(); }
export function backgroundResourcesAvailable(): boolean { return !constrained && (!playing || resourceAllocation().background_playback); }
export function onResourceChange(notify: () => void): () => void { changed.add(notify); return () => { changed.delete(notify); }; }
export function resourcePressure(): boolean { return constrained; }
export function updateRendererResources(value: { renderers: number; pressure: string }): void {
  setRendererResourceShare(value.renderers); constrained = value.pressure === 'constrained';
  for (const notify of changed) notify();
}
export const exportBufferBytes = () => resourceAllocation().export_mib * 1048576;

/** Reserve the small stream-copy tail before encoding. It owns no CPU slot
 * until mux starts and remains owned by this renderer until success/discard. */
export async function reserveExportFinalization(): Promise<{ token?: string; release: () => void }> {
  if (typeof window === 'undefined' || !window.api?.resources) return { release: () => {} };
  const token = crypto.randomUUID();
  await window.api.resources.reserveExportFinalization(token);
  let live = true;
  return { token, release: () => {
    if (live) { live = false; window.api.resources.release(token); }
  } };
}
