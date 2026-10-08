import { resourceAllocation, setRendererResourceShare } from '../../shared/resource-policy';

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
