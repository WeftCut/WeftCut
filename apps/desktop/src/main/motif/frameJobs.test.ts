import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { NativeImage, OffscreenSharedTexture, WebContents } from 'electron';
import type { MotifOsrFrame } from './offscreenFrames';
import type { CaptureOptions, CaptureRun } from './captureQueue';
import type { FrameWriter, MotifFrameStore } from './frameStore';
import { MotifFrameJobs, type FrameJobSession } from './frameJobs';
import { MotifFrameWriteQueue } from './frameWriteQueue';
import type { MotifFramePriority } from '../../shared/motifs/frameTransport';
import { MotifError, motifSuperseded } from '../../shared/motifs/errors';

const resources = vi.hoisted(() => ({
  pause: undefined as 'memory' | 'playback' | undefined,
  reserved: [] as (number | undefined)[],
  /** Release calls, double ones included. */
  released: 0,
  refuse: false,
}));
vi.mock('../resources', async original => ({
  ...await original<typeof import('../resources')>(),
  backgroundResourcePause: () => resources.pause,
  reserveResources: (_threads: number, _mib: number, finalizationId?: number) => {
    if (resources.refuse) throw new Error('resource-capacity-exceeded: synthetic');
    resources.reserved.push(finalizationId);
    return () => { resources.released++; };
  },
}));
afterEach(() => { resources.pause = undefined; resources.reserved.length = 0; resources.released = 0; resources.refuse = false; });

const address = { hash: 'a'.repeat(32), frame: 3 };
const args = { motifId: 'synthetic', tSec: 0.1, propsJson: '{}', width: 2, height: 2, contentHash: 'v1' };
const textureFrame = { kind: 'texture' as const, texture: {} as OffscreenSharedTexture, width: 2, height: 2 };
const bitmapFrame = { kind: 'bitmap' as const, image: {} as NativeImage, width: 2, height: 2 };
const RGBA = Buffer.from('straight rgba 16');
const owner = (id: number) => ({ id }) as WebContents;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One capture the test leases or fails by hand. */
interface FakeCapture {
  options: CaptureOptions;
  ticket: { setPriority: Mock<(priority: MotifFramePriority) => void>; cancel: Mock<() => void> };
  /** The host starts rendering: a cancel no longer stops the capture. */
  start(): void;
  lease(frame?: MotifOsrFrame): Promise<void>;
  fail(error: unknown): void;
}

function harness({ texture = true } = {}) {
  let textures = texture;
  const captures: FakeCapture[] = [];
  const writer = { encoded: vi.fn(async (_bytes: Uint8Array) => {}) };
  const store = {
    has: vi.fn(async (_hash: string, _frame: number) => false),
    hasRoom: vi.fn((_hash: string, _frame: number) => true),
    prepareWrite: vi.fn(async (_hash: string, _frame: number): Promise<FrameWriter | null> => writer),
  };
  const readBack = vi.fn(async (_frame: MotifOsrFrame, _rgba?: Buffer) => {});
  const session = {
    capture: vi.fn((_args: unknown, consume: (frame: MotifOsrFrame) => Promise<any>, options: CaptureOptions): CaptureRun<any> => {
      const result = deferred<any>();
      let started = false;
      const capture: FakeCapture = {
        options,
        ticket: { setPriority: vi.fn(), cancel: vi.fn(() => { if (!started) { started = true; result.reject(motifSuperseded()); } }) },
        start: () => { started = true; },
        lease: async (frame = textures ? textureFrame : bitmapFrame) => {
          started = true;
          if (options.isCurrent && !options.isCurrent()) { result.reject(motifSuperseded()); return; }
          try { result.resolve(await consume(frame)); } catch (error) { result.reject(error); }
        },
        fail: error => { started = true; result.reject(error); },
      };
      captures.push(capture);
      return { result: result.promise, ticket: capture.ticket };
    }),
    textures: () => textures,
    useBitmaps: vi.fn(() => { textures = false; }),
    copy: vi.fn(async (o: WebContents, _frame: unknown, _finalizationId?: number) => ({ kind: 'texture' as const, key: `copy-${o.id}`, token: 't' })),
    straighten: vi.fn(async () => RGBA),
    read: vi.fn((frame: MotifOsrFrame, _args: unknown, w: FrameWriter, rgba?: Buffer) => async () => {
      await readBack(frame, rgba);
      return () => w.encoded(new Uint8Array(4));
    }),
    writes: new MotifFrameWriteQueue(2),
    liveWriteFailed: vi.fn(),
  } satisfies FrameJobSession;
  const jobs = new MotifFrameJobs(store as unknown as MotifFrameStore, session);
  const display = (o: number, options: { priority?: MotifFramePriority; afterMiss?: boolean; keep?: boolean; finalizationId?: number; isCurrent?: () => boolean; at?: typeof address | undefined } = {}) =>
    jobs.display('at' in options ? options.at : address, args, {
      owner: owner(o), priority: options.priority ?? 'current', isCurrent: options.isCurrent ?? (() => true),
      keep: options.keep ?? false, finalizationId: options.finalizationId,
    }, options.afterMiss ?? false);
  const persist = (options: { priority?: MotifFramePriority; isCurrent?: () => boolean } = {}) =>
    jobs.persist(address, args, { priority: options.priority ?? 'background', isCurrent: options.isCurrent ?? (() => true) });
  /** Resolves once `n` captures have been queued. */
  const queued = (n: number) => vi.waitFor(() => expect(captures).toHaveLength(n));
  return { jobs, store, writer, session, captures, readBack, display, persist, queued };
}

describe('MotifFrameJobs: one capture per address', () => {
  it('two displays share one capture, each with its own GPU copy and finalization', async () => {
    const h = harness();
    const a = h.display(1, { finalizationId: 7 }), b = h.display(2);
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(a.result).resolves.toEqual({ kind: 'texture', key: 'copy-1', token: 't', persisted: false });
    await expect(b.result).resolves.toEqual({ kind: 'texture', key: 'copy-2', token: 't', persisted: false });
    expect(h.session.copy.mock.calls.map(([o, , id]) => [o.id, id])).toEqual([[1, 7], [2, undefined]]);
    expect(h.store.has).toHaveBeenCalledOnce();
    // The job's reservation, then the live write's.
    expect(resources.reserved).toEqual([7, undefined]);
    // One live write for the address.
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledOnce());
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it('on a bitmap host straightens once and gives every display the same picture', async () => {
    const h = harness({ texture: false });
    const a = h.display(1), b = h.display(2, { afterMiss: true });
    await h.queued(1);
    await h.captures[0]!.lease();
    for (const reply of [await a.result, await b.result]) {
      expect(reply).toMatchObject({ kind: 'pixels', width: 2, height: 2, persisted: false });
      expect(Buffer.from((reply as { bytes: Uint8Array }).bytes)).toEqual(RGBA);
    }
    expect(h.session.straighten).toHaveBeenCalledOnce();
    expect(h.session.copy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.readBack).toHaveBeenCalledExactlyOnceWith(bitmapFrame, RGBA));
  });

  it('persistence joins a queued display: the display gets pixels at the lease without waiting for the write', async () => {
    const h = harness(); const write = deferred();
    h.writer.encoded.mockReturnValueOnce(write.promise);
    const display = h.display(1);
    await h.queued(1);
    const persisted = h.persist();
    let stored = false;
    void persisted.result.then(() => { stored = true; });
    await h.captures[0]!.lease();
    await expect(display.result).resolves.toMatchObject({ kind: 'texture', persisted: false });
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledOnce());
    expect(stored).toBe(false);
    write.resolve();
    await persisted.result;
    expect(h.session.capture).toHaveBeenCalledOnce();
    expect(h.session.read).toHaveBeenCalledOnce();
  });

  it('a display joins queued persistence: the ticket is promoted and the display gets pixels', async () => {
    const h = harness();
    const persisted = h.persist();
    await h.queued(1);
    expect(h.captures[0]!.options.priority).toBe('background');
    const display = h.display(1, { priority: 'current' });
    expect(h.captures[0]!.ticket.setPriority).toHaveBeenLastCalledWith('current');
    await h.captures[0]!.lease();
    await expect(display.result).resolves.toMatchObject({ kind: 'texture', key: 'copy-1' });
    await persisted.result;
    expect(h.store.has).not.toHaveBeenCalled();
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it('a kept display waits for the write and reports it', async () => {
    const h = harness(); const write = deferred();
    h.writer.encoded.mockReturnValueOnce(write.promise);
    const kept = h.display(1, { keep: true });
    let settled = false;
    void kept.result.then(() => { settled = true; });
    await h.queued(1);
    await h.captures[0]!.lease();
    await settle();
    expect(settled).toBe(false);
    write.resolve();
    await expect(kept.result).resolves.toMatchObject({ kind: 'texture', persisted: true });
  });

  it('a request after the lease waits for the write, then is answered `stored`', async () => {
    const h = harness(); const write = deferred();
    h.writer.encoded.mockReturnValueOnce(write.promise);
    const first = h.display(1);
    await h.queued(1);
    await h.captures[0]!.lease();
    await first.result;
    const late = h.display(2), lateBake = h.persist();
    write.resolve();
    await expect(late.result).resolves.toEqual({ kind: 'stored', persisted: true });
    await expect(lateBake.result).resolves.toBeUndefined();
    expect(h.session.capture).toHaveBeenCalledOnce();
    expect(h.store.has).toHaveBeenCalledOnce();
  });

  it('a request after the lease captures again when that write fails', async () => {
    const h = harness(); const write = deferred();
    h.writer.encoded.mockReturnValueOnce(write.promise);
    const bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    const late = h.display(2);
    write.reject(new MotifError('disk', 'disk full'));
    await expect(bake.result).rejects.toMatchObject({ code: 'disk' });
    await h.queued(2);
    await h.captures[1]!.lease();
    await expect(late.result).resolves.toMatchObject({ kind: 'texture', key: 'copy-2' });
  });

  it('a request after a lease that stored nothing captures again', async () => {
    const h = harness(); h.store.hasRoom.mockReturnValue(false);
    const first = h.display(1);
    await h.queued(1);
    const lease = h.captures[0]!.lease();
    const late = h.display(2);
    await lease; await first.result;
    await h.queued(2);
    expect(h.writer.encoded).not.toHaveBeenCalled();
    await h.captures[1]!.lease();
    await expect(late.result).resolves.toMatchObject({ kind: 'texture' });
  });

  it('unaddressed captures are never shared, stored or answered `stored`', async () => {
    const h = harness();
    const a = h.display(1, { at: undefined }), b = h.display(1, { at: undefined });
    await h.queued(2);
    await Promise.all(h.captures.map(capture => capture.lease()));
    await expect(a.result).resolves.toMatchObject({ kind: 'texture', persisted: false });
    await expect(b.result).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.store.has).not.toHaveBeenCalled();
    expect(h.store.prepareWrite).not.toHaveBeenCalled();
  });
});

describe('MotifFrameJobs: the store check', () => {
  it('a display finds the frame stored without a capture', async () => {
    const h = harness(); h.store.has.mockResolvedValue(true);
    await expect(h.display(1).result).resolves.toEqual({ kind: 'stored', persisted: true });
    expect(h.store.has).toHaveBeenCalledExactlyOnceWith(address.hash, address.frame);
    expect(h.session.capture).not.toHaveBeenCalled();
  });

  it('a stat failure captures', async () => {
    const h = harness(); h.store.has.mockRejectedValue(new Error('EACCES'));
    const display = h.display(1);
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(display.result).resolves.toMatchObject({ kind: 'texture' });
  });

  it('answers only displays; persistence and an afterMiss display that joined the check go on to capture', async () => {
    const h = harness(); const stat = deferred<boolean>();
    h.store.has.mockReturnValueOnce(stat.promise);
    const display = h.display(1), afterMiss = h.display(2, { afterMiss: true }), bake = h.persist();
    stat.resolve(true);
    await expect(display.result).resolves.toEqual({ kind: 'stored', persisted: true });
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(afterMiss.result).resolves.toMatchObject({ kind: 'texture', key: 'copy-2' });
    await bake.result;
    expect(h.writer.encoded).toHaveBeenCalledOnce();
  });

  it('after a read miss, the file is checked first and only a request `afterMiss` captures it', async () => {
    // A stale miss: the renderer's first request after it finds the file.
    const h = harness(); h.store.has.mockResolvedValue(true);
    await expect(h.display(1).result).resolves.toEqual({ kind: 'stored', persisted: true });
    expect(h.session.capture).not.toHaveBeenCalled();
    // A corrupt file misses again: the request after that captures.
    const recapture = h.display(1, { afterMiss: true });
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(recapture.result).resolves.toMatchObject({ kind: 'texture', key: 'copy-1' });
    expect(h.store.has).toHaveBeenCalledOnce();
  });

  it('persistence never stats', async () => {
    const h = harness();
    const bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    await bake.result;
    expect(h.store.has).not.toHaveBeenCalled();
  });

  it('an afterMiss display never stats, still writes, and is never answered `stored`, even after a write', async () => {
    const h = harness(); h.store.has.mockResolvedValue(true);
    const write = deferred();
    h.writer.encoded.mockReturnValueOnce(write.promise);
    const first = h.display(1, { afterMiss: true });
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(first.result).resolves.toMatchObject({ kind: 'texture' });
    expect(h.store.has).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledOnce());
    const late = h.display(2, { afterMiss: true });
    write.resolve();
    await h.queued(2);
    await h.captures[1]!.lease();
    await expect(late.result).resolves.toMatchObject({ kind: 'texture', key: 'copy-2' });
    expect(h.store.has).not.toHaveBeenCalled();
  });
});

describe('MotifFrameJobs: cancellation', () => {
  it('the last request leaving a queued job cancels its capture; the next request starts a new job', async () => {
    const h = harness();
    const a = h.persist(), b = h.persist();
    await h.queued(1);
    a.handle.cancel();
    expect(h.captures[0]!.ticket.cancel).not.toHaveBeenCalled();
    b.handle.cancel();
    expect(h.captures[0]!.ticket.cancel).toHaveBeenCalledOnce();
    await expect(a.result).rejects.toMatchObject({ code: 'superseded' });
    await expect(b.result).rejects.toMatchObject({ code: 'superseded' });
    h.persist();
    await h.queued(2);
  });

  it('a request leaving lowers the ticket to the highest priority left', async () => {
    const h = harness();
    h.persist();
    await h.queued(1);
    const display = h.display(1, { priority: 'current' });
    display.handle.cancel();
    await expect(display.result).rejects.toMatchObject({ code: 'superseded' });
    expect(h.captures[0]!.ticket.setPriority.mock.calls).toEqual([['current'], ['background']]);
  });

  it('a priority change reaches a queued ticket', async () => {
    const h = harness();
    const bake = h.persist({ priority: 'ahead' });
    await h.queued(1);
    bake.handle.setPriority('background');
    expect(h.captures[0]!.ticket.setPriority).toHaveBeenLastCalledWith('background');
  });

  it('nobody current at the lease: no copy, no write', async () => {
    const h = harness(); let current = true;
    const display = h.display(1, { isCurrent: () => current, keep: true });
    await h.queued(1);
    current = false;
    await h.captures[0]!.lease();
    await expect(display.result).rejects.toMatchObject({ code: 'superseded' });
    expect(h.session.copy).not.toHaveBeenCalled();
    expect(h.session.read).not.toHaveBeenCalled();
  });

  it('a request that stops being current before the lease is dropped; the rest are served', async () => {
    const h = harness(); let current = true;
    const stale = h.display(1, { isCurrent: () => current }), live = h.display(2);
    await h.queued(1);
    current = false;
    await h.captures[0]!.lease();
    await expect(stale.result).rejects.toMatchObject({ code: 'superseded' });
    await expect(live.result).resolves.toMatchObject({ key: 'copy-2' });
    expect(h.session.copy).toHaveBeenCalledOnce();
  });

  it('a request waiting for a write rejects at once when cancelled', async () => {
    const h = harness(); const write = deferred();
    h.writer.encoded.mockReturnValueOnce(write.promise);
    h.display(1);
    await h.queued(1);
    await h.captures[0]!.lease();
    const late = h.display(2);
    late.handle.cancel();
    await expect(late.result).rejects.toMatchObject({ code: 'superseded' });
    write.resolve();
  });

  it('a request cancelled after the host started rendering gets no copy and no write', async () => {
    const h = harness();
    const display = h.display(1, { keep: true }), bake = h.persist();
    await h.queued(1);
    h.captures[0]!.start();
    display.handle.cancel(); bake.handle.cancel();
    expect(h.captures[0]!.ticket.cancel).toHaveBeenCalledOnce();
    await expect(display.result).rejects.toMatchObject({ code: 'superseded' });
    await expect(bake.result).rejects.toMatchObject({ code: 'superseded' });
    // The render finishes anyway; nobody is left to serve.
    await h.captures[0]!.lease();
    expect(h.session.copy).not.toHaveBeenCalled();
    expect(h.session.read).not.toHaveBeenCalled();
    expect(h.writer.encoded).not.toHaveBeenCalled();
    expect(resources.released).toBe(1);
  });

  it('a request cancelled during the check is not captured', async () => {
    const h = harness(); const stat = deferred<boolean>();
    h.store.has.mockReturnValueOnce(stat.promise);
    const display = h.display(1);
    display.handle.cancel();
    stat.resolve(false);
    await expect(display.result).rejects.toMatchObject({ code: 'superseded' });
    await settle();
    expect(h.session.capture).not.toHaveBeenCalled();
  });
});

describe('MotifFrameJobs: failures', () => {
  it('a capture failure with its own code rejects every request, without a bitmap retry', async () => {
    const h = harness();
    const display = h.display(1), bake = h.persist();
    await h.queued(1);
    h.captures[0]!.fail(new MotifError('content', 'broken Motif'));
    await expect(display.result).rejects.toMatchObject({ code: 'content' });
    await expect(bake.result).rejects.toMatchObject({ code: 'content' });
    expect(h.session.useBitmaps).not.toHaveBeenCalled();
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it.each([new MotifError('device', 'OSR lost'), new Error('uncoded')])('a shared-texture failure (%s) before the lease captures again as a bitmap for everyone', async failure => {
    const h = harness();
    const display = h.display(1), bake = h.persist();
    await h.queued(1);
    h.captures[0]!.fail(failure);
    await h.queued(2);
    expect(h.session.useBitmaps).toHaveBeenCalledExactlyOnceWith(failure);
    await h.captures[1]!.lease();
    await expect(display.result).resolves.toMatchObject({ kind: 'pixels' });
    await bake.result;
    expect(resources.reserved).toHaveLength(1);
  });

  it('a disk failure rejects persistence with its code; displays keep their pixels and a kept one learns it was not stored', async () => {
    const h = harness(); h.writer.encoded.mockRejectedValue(new MotifError('disk', 'disk full'));
    const display = h.display(1), kept = h.display(2, { keep: true }), bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(display.result).resolves.toMatchObject({ kind: 'texture', persisted: false });
    await expect(kept.result).resolves.toMatchObject({ kind: 'texture', persisted: false });
    await expect(bake.result).rejects.toMatchObject({ code: 'disk' });
    expect(h.session.useBitmaps).not.toHaveBeenCalled();
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it('a failed texture readback captures persistence again as a bitmap; a kept display keeps its texture', async () => {
    // The readback does not switch the session itself: the jobs must, or
    // the recapture is a texture that fails the same way, without end.
    const h = harness(); const failure = new MotifError('device', 'readback lost');
    h.readBack.mockImplementation(async frame => { if (frame.kind === 'texture') throw failure; });
    const kept = h.display(1, { keep: true }), bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(kept.result).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.session.useBitmaps).toHaveBeenCalledExactlyOnceWith(failure);
    await h.queued(2);
    await h.captures[1]!.lease();
    await bake.result;
    expect(h.readBack).toHaveBeenLastCalledWith(bitmapFrame, undefined);
    expect(h.session.capture).toHaveBeenCalledTimes(2);
  });

  it('a texture-output failure the session does not switch on fails persistence instead of capturing again', async () => {
    const h = harness(); const failure = new MotifError('device', 'readback lost');
    h.session.useBitmaps.mockImplementation(() => {});
    h.readBack.mockRejectedValue(failure);
    const bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(bake.result).rejects.toBe(failure);
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it('a readback failure with its own code fails persistence without a retry', async () => {
    const h = harness();
    h.readBack.mockRejectedValueOnce(new MotifError('transient', 'mutex held'));
    const bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(bake.result).rejects.toMatchObject({ code: 'transient' });
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it('a GPU copy failure sends that display to the write; the others keep their copies', async () => {
    const h = harness();
    h.session.copy.mockImplementationOnce(async () => { throw new MotifError('device', 'copy failed'); });
    const failed = h.display(1), other = h.display(2);
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(other.result).resolves.toMatchObject({ kind: 'texture', key: 'copy-2' });
    expect(h.session.useBitmaps).toHaveBeenCalledOnce();
    await expect(failed.result).resolves.toEqual({ kind: 'stored', persisted: true });
    expect(h.session.capture).toHaveBeenCalledOnce();
  });

  it('a GPU copy failure with nothing stored captures that display again as a bitmap', async () => {
    const h = harness(); h.store.hasRoom.mockReturnValue(false);
    h.session.copy.mockImplementationOnce(async () => { throw new MotifError('device', 'copy failed'); });
    const failed = h.display(1);
    await h.queued(1);
    await h.captures[0]!.lease();
    await h.queued(2);
    await h.captures[1]!.lease();
    await expect(failed.result).resolves.toMatchObject({ kind: 'pixels' });
  });

  it('a workspace that closed rejects persistence `closed`', async () => {
    const h = harness(); h.store.prepareWrite.mockResolvedValue(null);
    const bake = h.persist();
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(bake.result).rejects.toMatchObject({ code: 'closed' });
  });

  it('a capture that throws before it returns fails the job like one that rejects', async () => {
    const h = harness(); const failure = new MotifError('content', 'synchronous');
    h.session.capture.mockImplementationOnce(() => { throw failure; });
    const display = h.display(1, { afterMiss: true });
    await expect(display.result).rejects.toBe(failure);
    expect(resources.released).toBe(1);
    // The job left the table: the next request captures.
    h.persist();
    await h.queued(1);
  });

  it('a capacity refusal fails every request `capacity` and releases nothing', async () => {
    const h = harness(); resources.refuse = true;
    const display = h.display(1, { afterMiss: true }), bake = h.persist();
    await expect(display.result).rejects.toMatchObject({ code: 'capacity' });
    await expect(bake.result).rejects.toMatchObject({ code: 'capacity' });
    expect(h.session.capture).not.toHaveBeenCalled();
    expect(resources.released).toBe(0);
  });

  it('a job releases its reservation once, though a live write releases it at the lease', async () => {
    const h = harness();
    const display = h.display(1);
    await h.queued(1);
    await h.captures[0]!.lease();
    await display.result;
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledOnce());
    await settle();
    // The job's reservation and the live write's.
    expect(resources.reserved).toHaveLength(2);
    expect(resources.released).toBe(2);
  });

  it('a live write failure reaches neither the display nor a later request', async () => {
    const h = harness(); const failure = new MotifError('disk', 'disk full');
    h.writer.encoded.mockRejectedValueOnce(failure);
    const display = h.display(1);
    await h.queued(1);
    await h.captures[0]!.lease();
    await expect(display.result).resolves.toMatchObject({ kind: 'texture' });
    await vi.waitFor(() => expect(h.session.liveWriteFailed).toHaveBeenCalledExactlyOnceWith(failure));
  });
});
