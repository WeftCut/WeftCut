import { describe, expect, it, vi } from 'vitest';
import { MotifBakeClient, type MotifBakeClientDeps } from './bakeClient';
import type { MotifBakePlan, MotifBakeSnapshot, MotifBakeSession } from '../../../shared/motifs/baking';

const plan = (generation: number, key = 'key'): MotifBakePlan => ({ generation, contents: [], live: [{ cacheKey: key, hash: key }], collect: true });
const snapshot = (generation: number): MotifBakeSnapshot => ({ generation, coverage: {}, statuses: {} });
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup() {
  let emit!: (value: MotifBakeSnapshot) => void;
  let ready!: (value: MotifBakeSession) => void;
  const off = vi.fn(), offReady = vi.fn();
  const changed = vi.fn(), failed = vi.fn();
  const deps: MotifBakeClientDeps = {
    session: vi.fn(async () => ({ generation: 1, projectId: 'project' })),
    reconcile: vi.fn(async value => snapshot(value.generation)),
    snapshot: vi.fn(async () => snapshot(1)),
    listen: vi.fn(async callback => { emit = callback; return off; }),
    listenReady: vi.fn(async callback => { ready = callback; return offReady; }),
  };
  const client = new MotifBakeClient(changed, failed, deps);
  return { client, deps, changed, failed, off, offReady,
    emit: (value: MotifBakeSnapshot) => emit(value), ready: (value: MotifBakeSession) => ready(value) };
}

describe('main-owned Motif preparation client', () => {
  it('subscribes before discovery, deduplicates identical demand and detaches without clearing jobs', async () => {
    const h = setup();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    expect(h.deps.listen).toHaveBeenCalledOnce();
    expect(h.deps.listenReady).toHaveBeenCalledOnce();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
    h.client.dispose();
    await tick();
    expect(h.off).toHaveBeenCalledOnce();
    expect(h.offReady).toHaveBeenCalledOnce();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
  });

  it('coalesces changed plans and refuses a superseded completion', async () => {
    const h = setup();
    let finish!: (value: MotifBakeSnapshot) => void;
    vi.mocked(h.deps.reconcile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.client.reconcile('project', () => plan(1, 'a'));
    await tick();
    h.client.reconcile('project', () => plan(1, 'b'));
    h.client.reconcile('project', () => plan(1, 'c'));
    finish(snapshot(1));
    await tick();
    expect(vi.mocked(h.deps.reconcile).mock.calls.map(([value]) => value.live[0]?.cacheKey)).toEqual(['a', 'c']);
    expect(h.changed).toHaveBeenCalledOnce();
    h.client.dispose();
  });

  it('does not publish pre-inventory events while reconcile is discovering disk coverage', async () => {
    const h = setup();
    let finish!: (value: MotifBakeSnapshot) => void;
    vi.mocked(h.deps.reconcile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    h.emit(snapshot(1));
    expect(h.changed).not.toHaveBeenCalled();
    const hydrated = { ...snapshot(1), coverage: { key: [0, 1, 2] } };
    finish(hydrated);
    await tick();
    expect(h.changed).toHaveBeenCalledExactlyOnceWith(hydrated);
    h.client.dispose();
  });

  it('reopens the same project in a new session and rejects old-session events', async () => {
    const h = setup();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    vi.mocked(h.deps.session).mockResolvedValue({ generation: 2, projectId: 'project' });
    h.client.invalidate();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    h.changed.mockClear();
    h.emit(snapshot(1));
    expect(h.changed).not.toHaveBeenCalled();
    h.emit(snapshot(2));
    expect(h.changed).toHaveBeenCalledWith(snapshot(2));
    expect(h.deps.reconcile).toHaveBeenCalledTimes(2);
    h.client.dispose();
  });

  it('reports discovery failure and never submits a plan against another project', async () => {
    const h = setup();
    h.client.reconcile('different', () => plan(1));
    await tick();
    expect(h.failed).toHaveBeenCalledOnce();
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    h.client.dispose();
  });

  it('never deduplicates an explicit retry as an unchanged automatic plan', async () => {
    const h = setup();
    const retry = () => ({ ...plan(1), retryKeys: ['key'] });
    h.client.reconcile('project', retry);
    await tick();
    h.client.reconcile('project', retry);
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledTimes(2);
    h.client.dispose();
  });

  it('submits every move-to-front action even for an otherwise unchanged plan', async () => {
    const h = setup();
    const promote = () => ({ ...plan(1), promoteKeys: ['key'] });
    h.client.reconcile('project', promote); await tick();
    h.client.reconcile('project', promote); await tick();
    expect(h.deps.reconcile).toHaveBeenCalledTimes(2);
    h.client.dispose();
  });

  it('retries the retained intent when its first handshake ran before workspace readiness', async () => {
    const h = setup();
    vi.mocked(h.deps.session).mockRejectedValueOnce(new Error('Project is changing; retry after it opens'));
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    expect(h.failed).toHaveBeenCalledOnce();
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    h.ready({ generation: 1, projectId: 'project' });
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledExactlyOnceWith(plan(1));
    expect(h.changed).toHaveBeenCalledWith(snapshot(1));
    expect(h.failed).toHaveBeenCalledOnce();
    h.client.dispose();
  });

  it('redeclares unchanged demand after a failed workspace replacement restores the same generation', async () => {
    const h = setup();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
    h.emit(snapshot(-1)); // main suspended/reset during the attempted switch
    h.emit(snapshot(1)); // rollback reopened admission, with empty jobs
    h.ready({ generation: 1, projectId: 'project' });
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledTimes(2);
    expect(h.deps.snapshot).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.reconcile).mock.calls[1]?.[0].retryKeys).toBeUndefined();
    h.client.dispose();
  });

  it('waits for the matching project summary when readiness precedes renderer refresh', async () => {
    const h = setup();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    vi.mocked(h.deps.session).mockResolvedValue({ generation: 2, projectId: 'next-project' });
    h.ready({ generation: 2, projectId: 'next-project' });
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
    expect(h.failed).not.toHaveBeenCalled();
    h.client.reconcile('next-project', session => plan(session.generation, 'next-key'));
    await tick();
    expect(h.deps.reconcile).toHaveBeenLastCalledWith(plan(2, 'next-key'));
    h.client.dispose();
  });

  it('ignores readiness after disposal', async () => {
    const h = setup();
    h.client.reconcile('project', session => plan(session.generation));
    await tick();
    h.client.dispose();
    h.ready({ generation: 1, projectId: 'project' });
    await tick();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
  });

  it('does not replay an obsolete plan factory while a new project catalog is resolving', async () => {
    const h = setup();
    const oldPlan = vi.fn(session => plan(session.generation));
    h.client.reconcile('project', oldPlan);
    await tick();
    h.client.invalidate(); // project changed; async catalog sync has not submitted its new intent
    h.ready({ generation: 1, projectId: 'project' });
    await tick();
    expect(oldPlan).toHaveBeenCalledOnce();
    expect(h.deps.reconcile).toHaveBeenCalledOnce();
    h.client.reconcile('project', session => plan(session.generation, 'updated'));
    await tick();
    expect(h.deps.reconcile).toHaveBeenLastCalledWith(plan(1, 'updated'));
    h.client.dispose();
  });
});
