import { EventEmitter } from 'node:events';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handles: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  quit: [] as (() => void)[], reserve: vi.fn(), activity: vi.fn(), memory: vi.fn(), windows: vi.fn(() => [] as any[]),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: any) => mocks.handles.set(name, fn), on: (name: string, fn: any) => mocks.listeners.set(name, fn) },
  BrowserWindow: { getAllWindows: mocks.windows }, app: { once: (_: string, fn: () => void) => mocks.quit.push(fn) },
}));
vi.mock('./resources', async importOriginal => ({
  ...await importOriginal<object>(), reserveResources: mocks.reserve, setResourceActivity: mocks.activity,
  processTreeMemory: mocks.memory, resourceSnapshot: () => ({ active: 0, waiting: 0, reserved_mib: 0, cpu_threads: 0 }),
}));
import { installResourceIpc } from './resourceIpc';

const sender = (id: number) => Object.assign(new EventEmitter(), { id });
const acquire = (owner: EventEmitter, id = 'lease') => mocks.handles.get('resources:acquire')!({ sender: owner }, { id, memoryMiB: 64, threads: 0 });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.windows.mockReturnValue([]);
  mocks.memory.mockResolvedValue({ processMib: 100, availableMib: 2048 });
  mocks.reserve.mockImplementation(() => vi.fn());
  installResourceIpc();
});
afterEach(() => { mocks.quit.splice(0).forEach(fn => fn()); vi.useRealTimers(); });

it('cannot release another window allocation, and releases each lease once on crash', () => {
  const a = sender(1), b = sender(2);
  acquire(a); acquire(b);
  const [releaseA, releaseB] = mocks.reserve.mock.results.map(result => result.value);
  mocks.listeners.get('resources:release')!({ sender: b }, 'unknown');
  expect(releaseA).not.toHaveBeenCalled();
  b.emit('render-process-gone'); b.emit('destroyed');
  expect(releaseB).toHaveBeenCalledOnce(); expect(releaseA).not.toHaveBeenCalled();
  a.emit('destroyed'); expect(releaseA).toHaveBeenCalledOnce();
});
it('full navigation returns allocations and removes listeners before re-registering', () => {
  const owner = sender(3);
  acquire(owner);
  const release = mocks.reserve.mock.results[0].value;
  owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  expect(release).not.toHaveBeenCalled();
  owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(release).toHaveBeenCalledOnce();
  expect(owner.listenerCount('destroyed')).toBe(0);
  expect(owner.listenerCount('did-start-navigation')).toBe(0);
  acquire(owner); expect(owner.listenerCount('destroyed')).toBe(1);
  owner.emit('destroyed');
});
it('rejects duplicate or malformed requests before allocating again', () => {
  const owner = sender(4); acquire(owner);
  expect(() => acquire(owner)).toThrow('Invalid resource request');
  expect(() => mocks.handles.get('resources:acquire')!({ sender: owner }, { id: 'bad', memoryMiB: Infinity, threads: 0 })).toThrow();
  expect(mocks.reserve).toHaveBeenCalledOnce(); owner.emit('destroyed');
});
it('rejects memory values that would wrap at the native uint32 boundary', () => {
  const owner = sender(9);
  for (const memoryMiB of [2 ** 32, 2 ** 32 + 64, Number.MAX_SAFE_INTEGER]) {
    expect(() => mocks.handles.get('resources:acquire')!({ sender: owner }, { id: 'overflow', memoryMiB, threads: 0 })).toThrow('Invalid resource request');
  }
  expect(mocks.reserve).not.toHaveBeenCalled(); owner.emit('destroyed');
});
it('combines playback across windows and drops playback state when the owner dies', () => {
  const a = sender(5), b = sender(6), playing = mocks.listeners.get('resources:playing')!;
  playing({ sender: a }, true); playing({ sender: b }, false);
  expect(mocks.activity).toHaveBeenLastCalledWith(true, false);
  a.emit('destroyed'); expect(mocks.activity).toHaveBeenLastCalledWith(false, false);
  b.emit('destroyed');
});
it('does not publish into destroyed contents or after quit starts', async () => {
  const send = vi.fn(() => { throw new Error('Object has been destroyed'); });
  mocks.windows.mockReturnValue([{ isDestroyed: () => false, webContents: { isDestroyed: () => true, send } }]);
  const owner = sender(7); acquire(owner); owner.emit('destroyed');
  expect(send).not.toHaveBeenCalled();
  mocks.quit.forEach(fn => fn()); mocks.activity.mockClear();
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.activity).not.toHaveBeenCalled();
});
it('keeps admission open when host memory is reclaimable despite few free pages', async () => {
  // macOS CI: ~510 MiB RSS against a 2304 MiB target, 127 MiB free.
  // A native sample must carry available RAM (including reclaimable pages).
  const free = vi.spyOn(os, 'freemem').mockReturnValue(127 * 1048576);
  mocks.memory.mockResolvedValue({ processMib: 510, availableMib: 2048 });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.activity).toHaveBeenLastCalledWith(false, false);
    expect(mocks.handles.get('resources:status')!({ sender: sender(8) })).toMatchObject({
      memory_mib: 510, available_memory_mib: 2048, pressure: 'normal',
    });
  } finally { free.mockRestore(); }
});
it('closes admission for real host pressure and only reopens after recovery', async () => {
  mocks.memory.mockResolvedValue({ processMib: 510, availableMib: 200 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.activity).toHaveBeenLastCalledWith(false, true);
  mocks.memory.mockRejectedValue(new Error('sample unavailable'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.activity).toHaveBeenLastCalledWith(false, true);
  mocks.memory.mockResolvedValue({ processMib: 510, availableMib: 400 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.activity).toHaveBeenLastCalledWith(false, true);
  mocks.memory.mockResolvedValue({ processMib: 510, availableMib: 2048 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.activity).toHaveBeenLastCalledWith(false, false);
});
