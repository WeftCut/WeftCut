import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireExportResources, acquireRenderResources } from './resourceClient';

const acquire = vi.fn();
const release = vi.fn();
const busy = new Error('resource-capacity-exceeded: Resource capacity is busy or the memory target is too small');

beforeEach(() => {
  vi.useFakeTimers();
  acquire.mockReset(); release.mockReset();
  vi.stubGlobal('window', { api: { resources: { acquire, release } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('waits for a transient claim to drain before admitting the decoder', async () => {
  acquire.mockRejectedValueOnce(busy).mockResolvedValue(undefined);
  const pending = acquireExportResources(381);
  const verdict = pending.then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(250);
  const result = await verdict;
  expect(result).not.toHaveProperty('error');
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(acquire.mock.calls[1]?.[0]).toMatchObject({ memoryMiB: 381, threads: 0 });
  if ('value' in result) { result.value(); result.value(); }
  expect(release).toHaveBeenCalledOnce();
});

it('keeps permanent capacity refusal bounded and preserves the original error', async () => {
  acquire.mockRejectedValue(busy);
  const verdict = acquireExportResources(381).catch(error => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await verdict).toBe(busy);
  expect(release).not.toHaveBeenCalled();
  const attempts = acquire.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(acquire).toHaveBeenCalledTimes(attempts);
});

it('does not retry a non-capacity error', async () => {
  const error = new Error('Export finalization reservation expired');
  acquire.mockRejectedValue(error);
  await expect(acquireExportResources(64, 0, 'expired')).rejects.toBe(error);
  expect(acquire).toHaveBeenCalledOnce();
});

it('keeps preview admission fail-fast', async () => {
  acquire.mockRejectedValue(busy);
  await expect(acquireRenderResources(381)).rejects.toBe(busy);
  expect(acquire).toHaveBeenCalledOnce();
});

it('cancels a waiting export without acquiring or leaking a lease', async () => {
  acquire.mockRejectedValue(busy);
  const controller = new AbortController();
  const verdict = acquireExportResources(381, 0, undefined, controller.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(50);
  controller.abort();
  expect(await verdict).toBe(controller.signal.reason);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(acquire).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
});

it('releases a successful IPC admission if cancellation raced its answer', async () => {
  const controller = new AbortController();
  acquire.mockImplementation(async () => { controller.abort(); });
  await expect(acquireExportResources(381, 0, undefined, controller.signal)).rejects.toBe(controller.signal.reason);
  expect(release).toHaveBeenCalledOnce();
});

it('does not wait for a claim larger than the entire allowance', async () => {
  acquire.mockRejectedValue(busy);
  await expect(acquireExportResources(0xffff_ffff)).rejects.toBe(busy);
  expect(acquire).toHaveBeenCalledOnce();
});
