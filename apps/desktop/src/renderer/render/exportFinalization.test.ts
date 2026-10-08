import { expect, it, vi } from 'vitest';
import { createExportFinalization } from './exportFinalization';

it('retains files across repeated failures, ignores double clicks, and cleans once on success', async () => {
  let fail!: (error: Error) => void;
  const mux = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
  const cleanup = vi.fn(async () => {}), onComplete = vi.fn(), onFailure = vi.fn();
  const job = createExportFinalization({ mux, cleanup, onRunning: vi.fn(), onComplete, onFailure });
  const first = job.retry();
  await job.retry();
  expect(mux).toHaveBeenCalledOnce();
  fail(new Error('disk full'));
  await first;
  expect(cleanup).not.toHaveBeenCalled();
  mux.mockRejectedValueOnce(new Error('still full'));
  await job.retry();
  expect(onFailure).toHaveBeenCalledTimes(2);
  expect(cleanup).not.toHaveBeenCalled();
  mux.mockResolvedValueOnce();
  await job.retry();
  await job.retry();
  await job.discard();
  expect(onComplete).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(mux).toHaveBeenCalledTimes(3);
});

it('defers disposal until an in-flight mux settles and never reports completion after discard', async () => {
  let finish!: () => void;
  const cleanup = vi.fn(async () => {}), onComplete = vi.fn(), onFailure = vi.fn();
  const job = createExportFinalization({ mux: () => new Promise<void>(resolve => { finish = resolve; }), cleanup, onRunning: vi.fn(), onComplete, onFailure });
  const pending = job.retry();
  await job.discard();
  expect(cleanup).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(onComplete).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});
