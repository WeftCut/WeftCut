import { admitExport } from './exportAdmission';
import type { ExportPlanRequest } from '../shared/export-resources';
import { tryExportPlan, waitForResourceChange, releaseResourceId, decoderResourceMiB } from './resources';
import { app, BrowserWindow, ipcMain } from 'electron';
import { resourceAllocation } from '../shared/resource-policy';
import type { ResourceStatus } from '../shared/resource-policy';
import { reserveResources, reserveExportFinalization, createMemoryPressure, MEMORY_SAMPLE_TTL_MS, resourceSnapshot, setResourceActivity, processTreeMemory, type ResourceMemorySample } from './resources';

const finalizationOwners = new Map<number, Map<string, number>>();
/** Only main translates an owner-scoped token to a native reservation. */
export function resolveExportFinalization(senderId: number, token: unknown): number | undefined {
  if (token === undefined) return undefined;
  const id = typeof token === 'string' ? finalizationOwners.get(senderId)?.get(token) : undefined;
  if (id === undefined) throw new Error('Export finalization reservation expired');
  return id;
}

/** Owner-scoped renderer leases. Reload/renderer death returns every outstanding
 * lease. A sender cannot release another window's allocation. */
export function installResourceIpc(onDiagnostic?: (snapshot: { status: ResourceStatus; allocation: ReturnType<typeof resourceAllocation> }) => void, exportResources?: { prepare(sender: Electron.WebContents): void; retire(sender: Electron.WebContents, id: number): void }) {
  const owners = new Map<number, { releases: Map<string, () => void>; pending: Map<string, AbortController>; playing: boolean }>();
  const pressure = createMemoryPressure();
  let quitting = false;
  let status: ResourceStatus = { memory_mib: null, memory_scope: 'unavailable', pressure: 'normal',
    active: 0, waiting: 0, reserved_mib: 0, cpu_threads: 0 };
  const publish = () => {
    if (quitting) return;
    setResourceActivity([...owners.values()].some(owner => owner.playing), status.pressure === 'constrained', pressure.critical());
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) {
      const contents = win.webContents;
      // WebContents destruction precedes BrowserWindow destruction on quit.
      if (!contents.isDestroyed()) contents.send('evt:resources:changed', { renderers: Math.max(1, owners.size), pressure: status.pressure });
    }
  };
  const ownerFor = (sender: Electron.WebContents) => {
    let owner = owners.get(sender.id);
    if (owner) return owner;
    owner = { releases: new Map(), pending: new Map(), playing: false };
    owners.set(sender.id, owner);
    const clear = () => {
      const old = owners.get(sender.id);
      if (!old) return;
      owners.delete(sender.id);
      finalizationOwners.delete(sender.id);
      sender.removeListener('destroyed', clear);
      sender.removeListener('render-process-gone', clear);
      sender.removeListener('did-start-navigation', navigation);
      for (const pending of old.pending.values()) pending.abort();
      for (const release of old.releases.values()) release();
      publish();
    };
    sender.once('destroyed', clear);
    sender.once('render-process-gone', clear);
    const navigation = (d: { isMainFrame: boolean; isSameDocument: boolean }) => { if (d.isMainFrame && !d.isSameDocument) clear(); };
    sender.on('did-start-navigation', navigation);
    publish();
    return owner;
  };
  ipcMain.handle('resources:estimate-decoder', (_event, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('Invalid decoder path');
    return decoderResourceMiB(path);
  });
  ipcMain.handle('resources:plan-export', async (event, request: ExportPlanRequest) => {
    const owner = ownerFor(event.sender);
    if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 128
      || owner.releases.has(request.id) || owner.pending.has(request.id)
      || typeof request.nativeEncoder !== 'boolean' || !Array.isArray(request.options)
      || !request.options.length || request.options.length > 8
      || request.options.some(n => !Number.isSafeInteger(n) || n < 64 || n > 0xffff_ffff)) throw new Error('Invalid export resource plans');
    if (owner.pending.size >= 32) throw new Error('resource-capacity-exceeded: Too many queued exports');
    exportResources?.prepare(event.sender);
    const controller = new AbortController();
    owner.pending.set(request.id, controller);
    try {
      const admitted = await admitExport(request, {
        tryPlan: tryExportPlan, wait: waitForResourceChange, release: releaseResourceId,
        waiting: block => { if (!event.sender.isDestroyed()) event.sender.send('resources:export-waiting', { id: request.id, ...block }); },
      }, controller.signal);
      if (controller.signal.aborted) { releaseResourceId(admitted.id); controller.signal.throwIfAborted(); }
      const tokens = finalizationOwners.get(event.sender.id) ?? new Map<string, number>();
      tokens.set(request.id, admitted.id); finalizationOwners.set(event.sender.id, tokens);
      owner.releases.set(request.id, () => { exportResources?.retire(event.sender, admitted.id); releaseResourceId(admitted.id); });
      return admitted.index;
    } finally { owner.pending.delete(request.id); }
  });
  ipcMain.handle('resources:acquire', (event, request: { id: string; memoryMiB: number; threads: number; finalizationToken?: string }) => {
    const owner = ownerFor(event.sender);
    if (!request || typeof request.id !== 'string' || request.id.length > 128 || owner.releases.has(request.id) || owner.pending.has(request.id)
      || !Number.isSafeInteger(request.memoryMiB) || request.memoryMiB < 1 || request.memoryMiB > 0xffff_ffff
      || !Number.isSafeInteger(request.threads) || request.threads < 0 || request.threads > 1024) throw new Error('Invalid resource request');
    owner.releases.set(request.id, reserveResources(request.threads, request.memoryMiB, resolveExportFinalization(event.sender.id, request.finalizationToken)));
  });
  ipcMain.handle('resources:reserve-export-finalization', (event, id: string) => {
    const owner = ownerFor(event.sender);
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || owner.releases.has(id) || owner.pending.has(id)) throw new Error('Invalid resource request');
    const reservation = reserveExportFinalization();
    const tokens = finalizationOwners.get(event.sender.id) ?? new Map<string, number>();
    tokens.set(id, reservation.nativeId);
    finalizationOwners.set(event.sender.id, tokens);
    owner.releases.set(id, reservation.release);
  });
  ipcMain.on('resources:release', (event, id: string) => {
    const owner = owners.get(event.sender.id);
    owner?.pending.get(id)?.abort();
    finalizationOwners.get(event.sender.id)?.delete(id);
    owner?.releases.get(id)?.(); owner?.releases.delete(id);
  });
  ipcMain.on('resources:playing', (event, playing: boolean) => {
    ownerFor(event.sender).playing = playing === true; publish();
  });
  const currentStatus = () => ({ ...status, waiting: status.waiting + [...owners.values()].reduce((sum, owner) => sum + owner.pending.size, 0) });
  ipcMain.handle('resources:status', event => { ownerFor(event.sender); return currentStatus(); });
  let sampling = false;
  let lastDiagnostic = 0;
  const publishMemory = (memory?: ResourceMemorySample) => {
    const constrained = pressure.update(memory?.processMib ?? null, resourceAllocation().memory_mib, memory?.availableMib);
    const readings = pressure.readings();
    status = { ...resourceSnapshot(), memory_mib: readings.processMib, available_memory_mib: readings.availableMib ?? undefined,
      memory_scope: readings.processMib === null ? 'unavailable' : 'process-tree', pressure: constrained ? 'constrained' : 'normal' };
    if (Date.now() - lastDiagnostic >= 10_000) {
      lastDiagnostic = Date.now();
      onDiagnostic?.({ status: currentStatus(), allocation: resourceAllocation() });
    }
    publish();
  };
  const sample = async () => {
    if (quitting) return;
    let ownsQuery = false;
    try {
      // Age telemetry even while a native query is pending. A failed/hung query
      // must not retain yesterday's pressure or display it as current usage.
      publishMemory();
      if (sampling) return;
      sampling = true;
      ownsQuery = true;
      const startedAt = performance.now();
      const memory = await processTreeMemory();
      if (quitting || performance.now() - startedAt >= MEMORY_SAMPLE_TTL_MS) return;
      publishMemory(memory);
    } catch { /* The heartbeat expires old readings without manufacturing zero. */ }
    finally { if (ownsQuery) sampling = false; }
  };
  const timer = setInterval(sample, 1000); timer.unref(); sample();
  app.once('before-quit', () => { quitting = true; clearInterval(timer); });
}
