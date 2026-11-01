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
 * the authority's limits. Preview admission keeps its fail-fast behavior.
 * The 15 s retry is for claims that borrow from an admitted plan
 * (`finalizationToken`): they fit by construction and wait only for a sibling
 * child's teardown. An export's own working set is admitted without a
 * deadline (`admitExportResources`, `admitExportMetadata`). */
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

/** Register the wait observer before IPC so an immediate rejection is visible.
 * Admission waits until it is admitted or `signal` aborts; it has no deadline. */
export async function admitExportResources(plans: import('../../shared/export-resources').ExportResourcePlan[], nativeEncoder: boolean,
  signal: AbortSignal, waiting: (block: import('../../shared/export-resources').ExportResourceBlock) => void) {
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const off = window.api.resources.onExportWaiting(({ id, ...block }) => { if (id === token) waiting(block); });
  const cancel = () => window.api.resources.release(token);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const index = await window.api.resources.planExport({ id: token, options: plans.map(p => p.memoryMiB), nativeEncoder });
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    let live = true;
    return { token, plan: plans[index]!, release: () => { if (live) { live = false; cancel(); } } };
  } finally { off(); signal.removeEventListener('abort', cancel); }
}

/** The metadata preflight's admission: sources are read before the export's
 * working set can be sized, so this reads them under its own smallest plan
 * (64 MiB, the plan floor), queued like the export's and with no deadline. */
export async function admitExportMetadata(signal: AbortSignal, waiting: (block: import('../../shared/export-resources').ExportResourceBlock) => void): Promise<() => void> {
  if (typeof window === 'undefined' || !window.api?.resources) return () => {};
  const reservation = await admitExportResources([{ memoryMiB: 64, workerMiB: 0, motifBufferBytes: 0, frameWindows: {} }], false, signal, waiting);
  return reservation.release;
}
