import { describe, expect, it, vi } from 'vitest';
import { MotifBakeCoordinator, type MotifBakeCoordinatorDeps } from './baking';
import type { MotifBakeContent, MotifBakePause, MotifBakePlan } from '../../shared/motifs/baking';

const content = (key: string, frames = 90): MotifBakeContent => ({
  cacheKey: key, hash: key, contentFrames: frames, ranges: [{ start: 0, end: frames }],
  capture: { motifId: key, contentHash: key, propsJson: '{}', width: 2, height: 2, settleRafs: null, fpsNum: 30, fpsDen: 1 },
});
const plan = (contents: MotifBakeContent[], generation = 1): MotifBakePlan => ({ generation, contents, live: contents, collect: true });
function fixture(extra: Partial<MotifBakeCoordinatorDeps> = {}) {
  let time = 0;
  const timers: { run: () => void; at: number; cancelled: boolean }[] = [];
  const writes: string[] = [];
  const deps: MotifBakeCoordinatorDeps = {
    inventory: vi.fn(async () => []),
    persist: vi.fn(async (c, f) => { writes.push(`${c.cacheKey}:${f}`); }),
    pause: () => undefined, publish: vi.fn(), now: () => time,
    schedule: (run, delay) => { const timer = { run, at: time + delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    ...extra,
  };
  const coordinator = new MotifBakeCoordinator(deps);
  coordinator.reset(1);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const tick = async () => {
    await flush();
    let timer = timers.shift();
    while (timer?.cancelled) timer = timers.shift();
    if (!timer) return false;
    time = Math.max(time, timer.at); timer.run(); await flush(); return true;
  };
  const drain = async (limit = 20000) => {
    for (let i = 0; i < limit; i++) if (!await tick()) return;
    throw new Error('Coordinator did not become idle');
  };
  return { coordinator, deps, writes, tick, drain, flush, advance: (ms: number) => { time += ms; } };
}

describe('main-owned Motif bake demand', () => {
  it('finishes each clip in declared order across 61 contents', async () => {
    const h = fixture();
    const contents = Array.from({ length: 61 }, (_, i) => content(`c${i}`, 60));
    await h.coordinator.reconcile(plan(contents));
    await h.drain();
    expect(h.writes).toHaveLength(3660);
    expect(h.writes.slice(0, 60)).toEqual(Array.from({ length: 60 }, (_, f) => `c0:${f}`));
    expect(h.writes[60]).toBe('c1:0');
    expect(h.writes[3600]).toBe('c60:0');
    expect(Object.values(h.coordinator.snapshot().statuses).every(s => s.phase === 'ready')).toBe(true);
    expect(h.deps.inventory).toHaveBeenCalledTimes(61);
  });

  it('does not rotate unfinished clips on elapsed time or ordinary reconciliation', async () => {
    const h = fixture();
    await h.coordinator.reconcile(plan([content('a'), content('b')]));
    await h.tick(); h.advance(1001);
    await h.coordinator.reconcile(plan([content('a'), content('b')]));
    await h.tick();
    expect(h.writes).toEqual(['a:0', 'a:1']);
    h.coordinator.dispose();
  });

  it('keeps expensive content loaded until its clip finishes', async () => {
    let loaded = '';
    const captured: string[] = [];
    const h = fixture({ persist: async c => {
      captured.push(c.cacheKey);
      h.advance(loaded === c.cacheKey ? 140 : 500);
      loaded = c.cacheKey;
    } });
    await h.coordinator.reconcile(plan([content('a', 30), content('b', 30)]));
    for (let i = 0; i < 10; i++) await h.tick();
    expect(captured).toEqual(Array(10).fill('a'));
    await h.drain();
    expect(h.coordinator.snapshot().statuses.b.phase).toBe('ready');
  });

  it('reports only the in-flight content as baking and completes its predecessor', async () => {
    let finish!: () => void;
    const h = fixture({ persist: async c => {
      if (c.cacheKey === 'b') await new Promise<void>(resolve => { finish = resolve; });
    } });
    await h.coordinator.reconcile(plan([content('a', 31), content('b', 2)]));
    for (let i = 0; i < 31; i++) await h.tick();
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'ready', done: 31 });
    await h.tick();
    expect(h.coordinator.snapshot().statuses).toMatchObject({ a: { phase: 'ready' }, b: { phase: 'baking' } });
    finish(); await h.flush();
    expect(h.coordinator.snapshot().statuses.b).toMatchObject({ phase: 'queued', done: 1 });
    h.coordinator.dispose();
  });

  it('finishes each occurrence before later ranges of shared content', async () => {
    const h = fixture();
    const a = { ...content('a', 6), ranges: [{ start: 0, end: 2 }, { start: 4, end: 6 }] };
    await h.coordinator.reconcile({ ...plan([a, content('b', 2)]), sequence: [
      { cacheKey: 'a', ranges: [{ start: 0, end: 2 }] },
      { cacheKey: 'b', ranges: [{ start: 0, end: 2 }] },
      { cacheKey: 'a', ranges: [{ start: 4, end: 6 }] },
    ] });
    await h.drain();
    expect(h.writes).toEqual(['a:0', 'a:1', 'b:0', 'b:1', 'a:4', 'a:5']);
    h.coordinator.frameChanged('a', 1, false); await h.drain();
    expect(h.writes.at(-1)).toBe('a:1');
    expect(h.writes).toHaveLength(7);
  });

  it('preempts at a frame boundary, keeps latest promotion first, then resumes saved progress', async () => {
    const h = fixture();
    const p = plan([content('a', 3), content('b', 2), content('c', 2)]);
    await h.coordinator.reconcile(p); await h.tick();
    await h.coordinator.reconcile({ ...p, promoteKeys: ['c'] }); await h.tick();
    await h.coordinator.reconcile({ ...p, promoteKeys: ['b'] });
    await h.coordinator.reconcile(p); // Ordinary updates cannot undo user priority.
    await h.drain();
    expect(h.writes).toEqual(['a:0', 'c:0', 'b:0', 'b:1', 'c:1', 'a:1', 'a:2']);
  });

  it('allows ordered group promotion without duplicating completed frames', async () => {
    const h = fixture({ inventory: async c => c.cacheKey === 'c' ? [0] : [] });
    const p = plan([content('a', 2), content('b', 2), content('c', 2)]);
    await h.coordinator.reconcile({ ...p, promoteKeys: ['c', 'b', 'c'] }); await h.drain();
    expect(h.writes).toEqual(['c:1', 'b:0', 'b:1', 'a:0', 'a:1']);
  });

  it('resumes only holes and reports exact coverage even when automatic baking is off', async () => {
    const h = fixture({ inventory: vi.fn(async () => [0, 2, 3, 30]) });
    const c = content('a', 5); c.ranges = [{ start: 1, end: 3 }, { start: 2, end: 5 }];
    await h.coordinator.reconcile({ ...plan([]), live: [c] });
    expect(h.coordinator.snapshot()).toMatchObject({ statuses: {}, coverage: { a: [0, 2, 3, 30] } });
    await h.coordinator.reconcile(plan([c])); await h.drain();
    expect(h.writes).toEqual(['a:1', 'a:4']);
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'ready', done: 4, total: 4 });
    expect(h.deps.inventory).toHaveBeenCalledTimes(1);
  });

  it('finishes inventory and collection before admitting capture', async () => {
    let release!: () => void;
    const h = fixture({ collect: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) });
    const pending = h.coordinator.reconcile(plan([content('a', 1)]));
    await h.flush(); await h.tick();
    expect(h.writes).toEqual([]);
    release(); await pending; await h.drain();
    expect(h.writes).toEqual(['a:0']);
  });

  it('coalesces overlapping discoveries to the latest demand', async () => {
    let release!: (frames: number[]) => void;
    const inventory = vi.fn(async () => [] as number[]).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const h = fixture({ inventory });
    const first = h.coordinator.reconcile(plan([content('old', 1)]));
    await h.flush();
    const second = h.coordinator.reconcile(plan([content('new', 1)]));
    release([0]); await Promise.all([first, second]); await h.drain();
    expect(h.writes).toEqual(['new:0']);
    expect(h.coordinator.snapshot().coverage).toEqual({ new: [0] });
  });

  it('rejects stale plans and never publishes late completion into a reopened workspace', async () => {
    let release!: () => void;
    let current!: () => boolean;
    const h = fixture({ persist: vi.fn(async (_c, _f, valid) => { current = valid; await new Promise<void>(resolve => { release = resolve; }); }) });
    await h.coordinator.reconcile(plan([content('a', 1)])); await h.tick();
    expect(current()).toBe(true);
    h.coordinator.reset(2);
    expect(current()).toBe(false);
    await h.coordinator.reconcile(plan([content('stale', 1)]));
    release(); await h.drain();
    expect(h.coordinator.snapshot()).toEqual({ generation: 2, statuses: {}, coverage: {} });
  });

  it('shows policy pauses, resumes on wake, and does not spend failures on capacity', async () => {
    let pause: MotifBakePause | undefined = 'playback';
    const persist = vi.fn(async () => {}).mockRejectedValueOnce(new Error('resource-capacity-exceeded'));
    const h = fixture({ pause: () => pause, persist });
    await h.coordinator.reconcile(plan([content('a', 1)])); await h.tick();
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'paused', reason: 'playback' });
    pause = undefined; h.coordinator.wake(); await h.tick();
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'paused', reason: 'capacity' });
    await h.drain();
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'ready', done: 1 });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('recovers transient failures but isolates a persistently broken content after finite retries', async () => {
    const calls = new Map<string, number>();
    const h = fixture({ persist: vi.fn(async c => {
      const n = (calls.get(c.cacheKey) ?? 0) + 1; calls.set(c.cacheKey, n);
      if (c.cacheKey === 'bad' || n === 1) throw new Error('temporary host failure');
    }) });
    await h.coordinator.reconcile(plan([content('bad', 1), content('good', 1)]));
    await h.drain();
    expect(h.coordinator.snapshot().statuses.bad).toMatchObject({ phase: 'error', done: 0 });
    expect(h.coordinator.snapshot().statuses.good).toMatchObject({ phase: 'ready', done: 1 });
    expect(calls.get('bad')).toBe(3);
    await h.coordinator.reconcile(plan([content('bad', 1), content('good', 1)])); await h.drain();
    expect(calls.get('bad')).toBe(3);
  });

  it('protects an in-flight hash during removal and allows current collection to see new demand', async () => {
    let finish!: () => void;
    const kept: string[][] = [];
    const h = fixture({ persist: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), collect: async hashes => { kept.push([...hashes]); } });
    await h.coordinator.reconcile(plan([content('old', 1)])); await h.tick();
    await h.coordinator.reconcile(plan([]));
    expect(kept.at(-1)).toContain('old');
    finish(); await h.drain();
    expect(h.coordinator.snapshot().coverage).toEqual({});
  });

  it('adopts external writes and reopens exact holes discovered by reads', async () => {
    const h = fixture({ inventory: async () => [0, 1, 2] });
    await h.coordinator.reconcile(plan([content('a', 3)]));
    h.coordinator.frameChanged('a', 1, false);
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'queued', done: 2 });
    h.coordinator.frameChanged('a', 1, true);
    await h.drain();
    expect(h.writes).toEqual([]);
    expect(h.coordinator.snapshot().statuses.a.phase).toBe('ready');
    h.coordinator.frameChanged('a', 2, false); await h.drain();
    expect(h.writes).toEqual(['a:2']);
  });

  it('keeps disk capacity waits recoverable and supports explicit retry of terminal errors', async () => {
    let problem = 'motif-disk-capacity';
    const h = fixture({ persist: async () => { if (problem) throw new Error(problem); }, isContentFailure: e => String(e).includes('bad script') });
    await h.coordinator.reconcile(plan([content('a', 1)]));
    for (let i = 0; i < 8; i++) await h.tick();
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'paused', reason: 'disk' });
    problem = 'bad script'; await h.tick(); await h.tick();
    expect(h.coordinator.snapshot().statuses.a.phase).toBe('error');
    problem = ''; h.coordinator.retry('a'); await h.drain();
    expect(h.coordinator.snapshot().statuses.a.phase).toBe('ready');
  });

  it('retries failed discovery without baking disabled contents', async () => {
    const inventory = vi.fn(async () => [5]).mockRejectedValueOnce(new Error('temporary read failure'));
    const h = fixture({ inventory });
    await h.coordinator.reconcile({ ...plan([]), live: [content('a')] });
    await h.drain();
    expect(h.coordinator.snapshot().coverage).toEqual({ a: [5] });
    expect(h.writes).toEqual([]);
  });

  it('retains explicit full demand across renderer replacement and retries only requested failures', async () => {
    let failed = true;
    const h = fixture({ persist: async () => { if (failed) throw new Error('content failed'); }, isContentFailure: () => true });
    const c = { ...content('a', 3), explicit: true };
    await h.coordinator.reconcile(plan([c])); await h.drain();
    expect(h.coordinator.snapshot().statuses.a.phase).toBe('error');
    await h.coordinator.reconcile({ ...plan([]), live: [c] });
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'error', total: 3 });
    failed = false;
    const automatic = { ...content('a', 3), ranges: [{ start: 0, end: 1 }] };
    await h.coordinator.reconcile({ ...plan([automatic]), retryKeys: ['a'] }); await h.drain();
    expect(h.coordinator.snapshot().statuses.a).toMatchObject({ phase: 'ready', done: 3, total: 3 });
    await h.coordinator.reconcile(plan([]));
    expect(h.coordinator.snapshot().coverage).toEqual({});
  });
});
