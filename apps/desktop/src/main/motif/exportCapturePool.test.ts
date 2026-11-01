import { describe, expect, it, vi } from 'vitest';
import { ExportCapturePool } from './exportCapturePool';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve!: (v: string) => void; const promise = new Promise<string>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(capacity = 3) {
  let live = 0, serial = 0;
  const closed: number[] = [];
  const create = vi.fn((size: number) => {
    if (live >= capacity) throw new Error('capacity');
    live++; return { id: ++serial, size };
  });
  const pool = new ExportCapturePool({ create, close: (v: { id: number; size: number }) => { closed.push(v.id); live--; }, capacity: (e: unknown) => String(e).includes('capacity') });
  return { pool, create, closed };
}

describe('bounded export capture pages', () => {
  it('overlaps independent pages, serializes the same clock, and retains three warm affinities', async () => {
    const h = fixture(), a = deferred(), b = deferred();
    const hosts: number[] = [];
    const first = h.pool.capture('plate', 64, 'a', () => true, host => { hosts.push(host.id); return a.promise; });
    const same = h.pool.capture('plate', 64, 'a2', () => true, async host => { hosts.push(host.id); return 'a2'; });
    const second = h.pool.capture('title', 64, 'b', () => true, host => { hosts.push(host.id); return b.promise; });
    const third = h.pool.capture('illustration', 64, 'c', () => true, async host => { hosts.push(host.id); return 'c'; });
    await tick();
    expect(hosts).toEqual([1, 2]);
    expect(h.pool.diagnostics).toEqual({ hosts: 2, running: 2, queued: 2 });
    a.resolve('a'); await first; await same; await third;
    expect(hosts).toEqual([1, 2, 1, 3]);
    b.resolve('b'); await second; await tick();
    expect(h.create).toHaveBeenCalledTimes(3);
    for (const [affinity, id] of [['plate', 1], ['title', 2], ['illustration', 3]] as const)
      expect(await h.pool.capture(affinity, 64, undefined, () => true, async host => host.id)).toBe(id);
    await tick(); h.pool.retire(); expect(h.closed.sort()).toEqual([1, 2, 3]);
  });

  it('falls back to one page when the native authority refuses a second resident', async () => {
    const h = fixture(1), a = deferred();
    const first = h.pool.capture('a', 64, undefined, () => true, () => a.promise);
    const next = h.pool.capture('b', 64, undefined, () => true, async host => host.id);
    await tick(); expect(h.pool.diagnostics.running).toBe(1);
    a.resolve('a'); await first;
    expect(await next).toBe(1);
    await tick(); h.pool.retire(); expect(h.closed).toEqual([1]);
  });

  it('rejects capacity failure before any page exists rather than hanging', async () => {
    const h = fixture(0);
    await expect(h.pool.capture('a', 64, undefined, () => true, async () => 'a')).rejects.toThrow('capacity');
    expect(h.pool.diagnostics.running).toBe(0);
  });

  it('cancels queued work without interrupting an active page and keeps its lease until drained', async () => {
    const h = fixture(), a = deferred(), queuedRun = vi.fn(async () => 'stale');
    const first = h.pool.capture('a', 64, 'active', () => true, () => a.promise);
    const queued = expect(h.pool.capture('a', 64, 'queued', () => true, queuedRun)).rejects.toThrow('superseded');
    h.pool.cancel('queued'); await queued;
    h.pool.retire(); expect(h.closed).toEqual([]);
    // A running result still has an owner; the capture service fences stale
    // delivery. The pool must not lose it or free the page before it settles.
    a.resolve('a'); await expect(first).resolves.toBe('a');
    await tick(); expect(h.closed).toEqual([1]); expect(queuedRun).not.toHaveBeenCalled();
    await expect(h.pool.capture('a', 64, undefined, () => true, queuedRun)).rejects.toThrow('superseded');
  });

  it('does not close a running page during retirement and releases it once, after failure', async () => {
    const h = fixture(), a = deferred();
    const first = h.pool.capture('a', 64, undefined, () => true, () => a.promise.then(() => { throw new Error('render failed'); }));
    await tick(); h.pool.retire(); expect(h.closed).toEqual([]);
    a.resolve('a'); await expect(first).rejects.toThrow('render failed');
    await tick(); h.pool.retire(); expect(h.closed).toEqual([1]);
  });

  it('closes a small idle page before admitting a larger replacement', async () => {
    const h = fixture(1);
    await h.pool.capture('a', 64, undefined, () => true, async () => 'a'); await tick();
    expect(await h.pool.capture('b', 128, undefined, () => true, async host => host.size)).toBe(128);
    expect(h.closed).toEqual([1]); await tick(); h.pool.retire(); expect(h.closed).toEqual([1, 2]);
  });

  it('does not swallow arbitrary host construction errors or strand the following job', async () => {
    const h = fixture(); h.create.mockImplementationOnce(() => { throw new Error('broken host'); });
    await expect(h.pool.capture('a', 64, undefined, () => true, async () => 'a')).rejects.toThrow('broken host');
    expect(await h.pool.capture('b', 64, undefined, () => true, async () => 'b')).toBe('b');
    await tick(); h.pool.retire();
  });
});
