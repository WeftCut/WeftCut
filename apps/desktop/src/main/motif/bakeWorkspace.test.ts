import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MotifBakeWorkspace, validateBakePlan } from './bakeWorkspace';
import type { MotifCaptureService } from './captureService';
import type { MotifFrameStore } from './frameStore';
import { hashCacheKey } from '../../shared/motifs/cacheKey';
import type { MotifBakeContent, MotifBakePlan, MotifBakeSnapshot } from '../../shared/motifs/baking';

const roots: string[] = [];
const workspaces: MotifBakeWorkspace[] = [];
function frameBytes(width = 2, height = 2) {
  const bytes = Buffer.alloc(52 + width * height * 4);
  bytes.write('WCMFRM01'); bytes.writeUInt32LE(width, 8); bytes.writeUInt32LE(height, 12);
  return bytes;
}
const content = (key: string, width = 2): MotifBakeContent => ({ cacheKey: key, hash: hashCacheKey(key), contentFrames: 1,
  ranges: [{ start: 0, end: 1 }],
  capture: { motifId: key, contentHash: key, propsJson: '{}', width, height: 2, fpsNum: 30, fpsDen: 1, settleRafs: null } });
const plan = (contents: MotifBakeContent[], generation = 1): MotifBakePlan => ({ generation, contents, live: contents, collect: true });
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for bake state');
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motif-workspace-test-')); roots.push(root);
  let session: { root: string; generation: number } | null = { root, generation: 1 };
  let budget = 1_000_000;
  const snapshots: MotifBakeSnapshot[] = [];
  const retain = vi.fn();
  const persist = vi.fn(async (request: { width: number; height: number; bake?: { hash: string; frame: number } }, current: () => boolean, store?: MotifFrameStore) => {
    if (!current()) throw new Error('superseded');
    const address = request.bake!;
    await (await store!.prepareWrite(address.hash, address.frame))!.encoded(frameBytes(request.width, request.height));
  });
  const workspace = new MotifBakeWorkspace({
    session: () => session, capture: { persist } as unknown as MotifCaptureService,
    codec: { motifEncodePng: async () => frameBytes(), motifReadFrame: async file => {
      await fs.readFile(file); return { width: 2, height: 2, rgba: new Uint8Array(16) };
    } }, pause: () => undefined, diskBytes: () => budget, retain,
    publish: snapshot => snapshots.push(snapshot),
  });
  workspaces.push(workspace);
  return { root, workspace, retain, persist, snapshots, setSession: (next: typeof session) => { session = next; }, setBudget: (next: number) => { budget = next; } };
}
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('Motif workspace ownership', () => {
  it('retains content before discovery and persists without a renderer owner', async () => {
    const h = await fixture(); const c = content('synthetic');
    await h.workspace.reconcile(plan([c]));
    expect(h.retain).toHaveBeenLastCalledWith([path.join(h.root, 'Cache', 'raster', c.hash)]);
    await until(() => h.workspace.snapshot().statuses.synthetic?.phase === 'ready');
    expect(h.persist).toHaveBeenCalledOnce();
    expect(await h.workspace.store().inventory(c.hash)).toEqual([{ frame: 0, bytes: 68 }]);
    const before = h.snapshots.length;
    h.workspace.sync(); expect(h.snapshots).toHaveLength(before);
  });

  it('restores a complete cache and keeps discovery active with automatic baking disabled', async () => {
    const h = await fixture(); const c = content('retained');
    await (await h.workspace.store().prepareWrite(c.hash, 0))!.encoded(frameBytes());
    const snapshot = await h.workspace.reconcile({ ...plan([]), live: [c] });
    expect(snapshot.coverage.retained).toEqual([0]);
    expect(h.persist).not.toHaveBeenCalled();
    await h.workspace.reconcile(plan([c]));
    expect(h.workspace.snapshot().statuses.retained.phase).toBe('ready');
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('ends a same-root reopened session and ignores its late completion', async () => {
    const h = await fixture(); const c = content('old');
    let finish!: () => void; let valid!: () => boolean;
    h.persist.mockImplementationOnce(async (_request, current, store) => {
      valid = current;
      const writer = await store!.prepareWrite(c.hash, 0);
      await new Promise<void>(resolve => { finish = resolve; });
      await writer!.encoded(frameBytes());
    });
    await h.workspace.reconcile(plan([c])); await until(() => !!finish);
    h.setSession({ root: h.root, generation: 2 }); h.workspace.sync();
    expect(valid()).toBe(false);
    finish();
    await until(() => h.workspace.snapshot().generation === 2);
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(h.workspace.snapshot().coverage).toEqual({});
    await expect(h.workspace.reconcile(plan([c], 1))).rejects.toThrow('superseded');
    await h.workspace.reconcile(plan([c], 2));
    await until(() => h.workspace.snapshot().statuses.old.phase === 'ready');
  });

  it('does not continuously reset an already closed workspace', async () => {
    const h = await fixture(); h.workspace.sync();
    h.setSession(null); h.workspace.sync();
    const before = h.snapshots.length;
    expect(h.workspace.snapshot().generation).toBe(-1);
    h.workspace.snapshot(); h.workspace.sync();
    expect(h.snapshots).toHaveLength(before);
    expect(h.retain).toHaveBeenLastCalledWith([]);
  });

  it('waits for quota per content while letting smaller work finish, then resumes', async () => {
    const h = await fixture(); h.setBudget(150);
    await h.workspace.reconcile(plan([content('large', 100), content('small')]));
    await until(() => h.workspace.snapshot().statuses.small?.phase === 'ready');
    expect(h.workspace.snapshot().statuses.large).toMatchObject({ phase: 'paused', reason: 'disk' });
    h.setBudget(5000); h.workspace.wake();
    await until(() => h.workspace.snapshot().statuses.large?.phase === 'ready');
    expect(h.persist).toHaveBeenCalledTimes(2);
  });

  it('aborts collection before deleting a hash made live by a newer plan', async () => {
    const h = await fixture(); const keep = content('new');
    const store = h.workspace.store();
    await (await store.prepareWrite(keep.hash, 0))!.encoded(frameBytes());
    const original = store.collect.bind(store);
    let proceed!: () => void;
    vi.spyOn(store, 'collect').mockImplementationOnce(async (live, current) => {
      await new Promise<void>(resolve => { proceed = resolve; });
      await original(live, current);
    });
    const oldPlan = h.workspace.reconcile(plan([]));
    await until(() => !!proceed);
    const newPlan = h.workspace.reconcile(plan([keep]));
    proceed(); await Promise.all([oldPlan, newPlan]);
    expect(h.workspace.snapshot().statuses.new.phase).toBe('ready');
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('keeps foreground writes that arrive during inventory in coverage and quota accounting', async () => {
    const h = await fixture(); h.setBudget(150);
    const a = content('a'), b = content('b');
    const store = h.workspace.store();
    let finish!: () => void;
    vi.spyOn(store, 'inventory').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return [];
    });
    const pending = h.workspace.reconcile({ ...plan([b]), live: [a, b] });
    await until(() => !!finish);
    await (await store.prepareWrite(a.hash, 0))!.encoded(frameBytes());
    finish(); await pending;
    await until(() => h.workspace.snapshot().statuses.b?.phase === 'paused');
    expect(h.workspace.snapshot().coverage.a).toEqual([0]);
    expect(h.workspace.snapshot().statuses.b.reason).toBe('disk');
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('rejects malformed ranges, addresses and capture inputs before scheduling', () => {
    const good = plan([content('example')]);
    expect(() => validateBakePlan(good)).not.toThrow();
    for (const mutate of [
      (p: MotifBakePlan) => { p.contents[0]!.hash = 'bad'; },
      (p: MotifBakePlan) => { p.contents[0]!.capture.width = 9000; },
      (p: MotifBakePlan) => { p.contents[0]!.capture.propsJson = 'null'; },
      (p: MotifBakePlan) => { p.contents[0]!.ranges[0]!.end = 2; },
      (p: MotifBakePlan) => { p.sequence = [{ cacheKey: p.contents[0]!.cacheKey, ranges: [{ start: 0, end: 2 }] }]; },
      (p: MotifBakePlan) => { p.contents[0]!.capture.settleRafs = -1; },
      (p: MotifBakePlan) => { p.live.push(null as never); },
    ]) {
      const malformed = structuredClone(good); mutate(malformed);
      expect(() => validateBakePlan(malformed)).toThrow('Invalid Motif bake plan');
    }
  });

  it('pins the whole incoming raster root until current complete discovery can narrow retention', async () => {
    const h = await fixture(); const c = content('ready');
    const store = h.workspace.store();
    const rootPin = path.join(h.root, 'Cache', 'raster');
    expect(h.retain).toHaveBeenLastCalledWith([rootPin]);
    let finish!: () => void;
    vi.spyOn(store, 'inventory').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return [];
    });
    const pending = h.workspace.reconcile({ ...plan([]), live: [c] });
    await until(() => !!finish);
    expect(h.retain).toHaveBeenLastCalledWith([rootPin]);
    finish(); await pending;
    expect(h.retain).toHaveBeenLastCalledWith([path.join(rootPin, c.hash)]);
    await h.workspace.reconcile({ ...plan([]), live: [c], collect: false });
    expect(h.retain).toHaveBeenLastCalledWith([rootPin]);
  });

  it('retains bootstrap protection after failed inventory and never lets an old plan narrow it', async () => {
    const h = await fixture(); const c = content('unreadable');
    const store = h.workspace.store();
    vi.spyOn(store, 'inventory').mockRejectedValueOnce(new Error('read failed'));
    await h.workspace.reconcile({ ...plan([]), live: [c] });
    expect(h.retain).toHaveBeenLastCalledWith([path.join(h.root, 'Cache', 'raster')]);
    h.workspace.dispose();
  });

  it('checks actual encoded growth for optional writers and permits no-growth replacement above target', async () => {
    const h = await fixture(); const c = content('cached');
    h.setBudget(100);
    await h.workspace.reconcile({ ...plan([]), live: [c] });
    const store = h.workspace.store();
    await (await store.prepareWrite(c.hash, 0))!.encoded(frameBytes());
    await expect((await store.prepareWrite(c.hash, 1))!.encoded(frameBytes())).rejects.toThrow('motif-disk-capacity');
    expect(await store.has(c.hash, 1)).toBe(false);
    h.setBudget(10);
    await expect((await store.prepareWrite(c.hash, 0))!.encoded(frameBytes())).resolves.toBeUndefined();
    expect(h.workspace.snapshot().coverage.cached).toEqual([0]);
  });

  it('serializes concurrent encoded writes so only one can spend the remaining quota', async () => {
    const h = await fixture(); const c = content('concurrent'); h.setBudget(100);
    await h.workspace.reconcile({ ...plan([]), live: [c] });
    const store = h.workspace.store();
    const one = (await store.prepareWrite(c.hash, 0))!, two = (await store.prepareWrite(c.hash, 1))!;
    const results = await Promise.allSettled([one.encoded(frameBytes()), two.encoded(frameBytes())]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await store.inventory(c.hash)).toEqual([{ frame: 0, bytes: 68 }]);
  });
});
