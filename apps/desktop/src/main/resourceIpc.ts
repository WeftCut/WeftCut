import { app, BrowserWindow, ipcMain } from 'electron';
import { resourceAllocation } from '../shared/resource-policy';
import type { ResourceStatus } from '../shared/resource-policy';
import { reserveResources, reserveExportFinalization, createMemoryPressure, resourceSnapshot, setResourceActivity, processTreeMemory } from './resources';

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
export function installResourceIpc(onDiagnostic?: (snapshot: { status: ResourceStatus; allocation: ReturnType<typeof resourceAllocation> }) => void) {
  const owners = new Map<number, { releases: Map<string, () => void>; playing: boolean }>();
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
    owner = { releases: new Map(), playing: false };
    owners.set(sender.id, owner);
    const clear = () => {
      const old = owners.get(sender.id);
      if (!old) return;
      owners.delete(sender.id);
      finalizationOwners.delete(sender.id);
      sender.removeListener('destroyed', clear);
      sender.removeListener('render-process-gone', clear);
      sender.removeListener('did-start-navigation', navigation);
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
  ipcMain.handle('resources:acquire', (event, request: { id: string; memoryMiB: number; threads: number; finalizationToken?: string }) => {
    const owner = ownerFor(event.sender);
    if (!request || typeof request.id !== 'string' || request.id.length > 128 || owner.releases.has(request.id)
      || !Number.isSafeInteger(request.memoryMiB) || request.memoryMiB < 1 || request.memoryMiB > 0xffff_ffff
      || !Number.isSafeInteger(request.threads) || request.threads < 0 || request.threads > 1024) throw new Error('Invalid resource request');
    owner.releases.set(request.id, reserveResources(request.threads, request.memoryMiB, resolveExportFinalization(event.sender.id, request.finalizationToken)));
  });
  ipcMain.handle('resources:reserve-export-finalization', (event, id: string) => {
    const owner = ownerFor(event.sender);
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || owner.releases.has(id)) throw new Error('Invalid resource request');
    const reservation = reserveExportFinalization();
    const tokens = finalizationOwners.get(event.sender.id) ?? new Map<string, number>();
    tokens.set(id, reservation.nativeId);
    finalizationOwners.set(event.sender.id, tokens);
    owner.releases.set(id, reservation.release);
  });
  ipcMain.on('resources:release', (event, id: string) => {
    const owner = owners.get(event.sender.id);
    finalizationOwners.get(event.sender.id)?.delete(id);
    owner?.releases.get(id)?.(); owner?.releases.delete(id);
  });
  ipcMain.on('resources:playing', (event, playing: boolean) => {
    ownerFor(event.sender).playing = playing === true; publish();
  });
  ipcMain.handle('resources:status', event => { ownerFor(event.sender); return status; });
  let sampling = false;
  let lastDiagnostic = 0;
  const sample = async () => {
    if (sampling || quitting) return;
    sampling = true;
    try {
      const memory = await processTreeMemory();
      if (quitting) return;
      status = { ...resourceSnapshot(), memory_mib: memory.processMib, available_memory_mib: memory.availableMib, memory_scope: 'process-tree',
        pressure: pressure.update(memory.processMib, resourceAllocation().memory_mib, memory.availableMib) ? 'constrained' : 'normal' };
      if (Date.now() - lastDiagnostic >= 10_000) {
        lastDiagnostic = Date.now();
        onDiagnostic?.({ status, allocation: resourceAllocation() });
      }
      publish();
    } catch { /* Preserve pressure on a failed sample. */ }
    finally { sampling = false; }
  };
  const timer = setInterval(sample, 1000); timer.unref(); sample();
  app.once('before-quit', () => { quitting = true; clearInterval(timer); });
}
