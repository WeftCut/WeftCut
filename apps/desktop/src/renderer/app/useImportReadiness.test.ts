// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaSummary, ProjectSummary } from "../ipc";
const mocks = vi.hoisted(() => ({ list: vi.fn(), probe: vi.fn(), proxy: vi.fn(), import: vi.fn(), pool: new Map(), listeners: new Map<string, (event: unknown) => void>() }));
vi.mock("react-i18next", async original => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/bridge/ipc", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn() }));
vi.mock("@/bridge/events", () => ({ listen: async (name: string, callback: (event: unknown) => void) => {
  mocks.listeners.set(name, callback);
  return () => { if (mocks.listeners.get(name) === callback) mocks.listeners.delete(name); };
} }));
vi.mock("../ipc", () => ({
  IMPORT_EVENTS: { queue: 'queue' }, MEDIA_JOB_EVENTS: { started: 'start', complete: 'complete', error: 'error' },
  importQueueList: mocks.list, ensureFullProxy: mocks.proxy, importMedia: mocks.import, logEmit: vi.fn(),
}));
vi.mock("../state/projectStore", () => ({ useProjectStore: { getState: () => ({ mediaById: mocks.pool }) } }));
vi.mock("../render/decoder/probeSourceDecodable", () => ({ classifyWebcodecsDecodability: mocks.probe }));
vi.mock("../panels/importOptimize", () => ({ importOptimizeStatus: () => 'checking', optimizeReason: () => '' }));
import * as capability from '../render/decoder/webcodecsCapability';
import { useImportReadiness } from './useImportReadiness';
import { notifyResourceSettingsChanged, updateRendererResources } from '../render/resourceClient';
import * as resourcePolicy from '../../shared/resource-policy';

const summary = (project_id: string) => ({ project_id } as ProjectSummary);
const media = (path: string) => ({ id: 'shared-id', path, kind: 'Video', decode_route: { route: 'direct-export', quick_proxy: null }, available: true, size_bytes: 1 } as MediaSummary);
const run = async (action: () => Promise<unknown>) => { await action(); };
const previewRef = { current: null };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.proxy.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
  capability.resetWebcodecsCapabilitySession();
  vi.spyOn(capability, 'markWebcodecsUnusable');
  vi.spyOn(resourcePolicy, 'resourceAllocation').mockReturnValue({
    ...resourcePolicy.resolveResourcePolicy(resourcePolicy.DEFAULT_RESOURCE_POLICY), cpu_threads: 2, work_mib: 1024,
  });
  mocks.pool.clear();
  mocks.listeners.clear();
  mocks.pool.set('shared-id', media('a.mov'));
  updateRendererResources({ renderers: 1, pressure: 'normal' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('batch import', () => {
  function setup() {
    mocks.pool.clear();
    const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
    mocks.import.mockImplementation(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })));
    const hook = renderHook(({ project }) => useImportReadiness({ summary: project, run, previewRef }), {
      initialProps: { project: summary('a') },
    });
    return { hook, pending };
  }
  it('replenishes a completed request while an earlier large file is still hashing', async () => {
    const { hook, pending } = setup();
    let done!: Promise<void>;
    await act(async () => { done = hook.result.current.importPaths(['a', 'b', 'c', 'd']); });
    expect(mocks.import.mock.calls).toEqual([['a'], ['b']]);
    await act(async () => { pending[1]!.resolve(); });
    expect(mocks.import.mock.calls).toEqual([['a'], ['b'], ['c']]);
    await act(async () => { pending[2]!.resolve(); });
    expect(mocks.import.mock.calls).toEqual([['a'], ['b'], ['c'], ['d']]);
    await act(async () => { pending[0]!.resolve(); pending[3]!.resolve(); await done; });
  });
  it('drains already started imports before reporting failure, without starting later files', async () => {
    const { hook, pending } = setup();
    const failed = new Error('unreadable source');
    let settled = false;
    const done = hook.result.current.importPaths(['a', 'b', 'c', 'd']).catch(error => { settled = true; return error; });
    await act(async () => { pending[0]!.reject(failed); });
    expect(settled).toBe(false);
    await act(async () => { pending.slice(1).forEach(p => p.resolve()); });
    expect(await done).toBe(failed);
    expect(mocks.import).toHaveBeenCalledTimes(2);
  });
  it('does not submit queued paths into a different project', async () => {
    const { hook, pending } = setup();
    const done = hook.result.current.importPaths(['a', 'b', 'c', 'd']);
    hook.rerender({ project: summary('b') });
    await act(async () => { pending.forEach(p => p.resolve()); await done; });
    expect(mocks.import).toHaveBeenCalledTimes(2);
  });
  it('stops remaining files when the same project is reopened', async () => {
    const { hook, pending } = setup();
    const done = hook.result.current.importPaths(['a', 'b', 'c', 'd']);
    act(() => { mocks.listeners.get('project:workspace-changing')!({ payload: {} }); });
    await act(async () => { pending.forEach(p => p.resolve()); await done; });
    expect(mocks.import).toHaveBeenCalledTimes(2);
  });
  it.each([[0, 1], [1, 8], [17, 2], [257, 1], [1000, 5], [4096, 16]])('imports %i files within a resource window of %i', async (count, capacity) => {
    vi.mocked(resourcePolicy.resourceAllocation).mockReturnValue({
      ...resourcePolicy.resourceAllocation(), cpu_threads: capacity, work_mib: capacity * 128,
    });
    const { hook, pending } = setup();
    const paths = Array.from({ length: count }, (_, i) => `source-${i}`);
    let done!: Promise<void>;
    await act(async () => { done = hook.result.current.importPaths(paths); });
    expect(mocks.import).toHaveBeenCalledTimes(Math.min(count, capacity));
    let completed = 0;
    while (completed < paths.length) {
      expect(pending.length - completed).toBeLessThanOrEqual(capacity);
      const chunk = pending.slice(completed);
      completed += chunk.length;
      await act(async () => { chunk.forEach(p => p.resolve()); });
    }
    await done;
    expect(mocks.import.mock.calls.map(call => call[0])).toEqual(paths);
  });
  it('shares capacity across overlapping file-picker and drop requests', async () => {
    const { hook, pending } = setup();
    const first = hook.result.current.importPaths(['a', 'b']);
    const second = hook.result.current.importPaths(['c', 'd']);
    expect(mocks.import).toHaveBeenCalledTimes(2);
    await act(async () => { pending[1]!.resolve(); });
    expect(mocks.import).toHaveBeenCalledTimes(3);
    await act(async () => { pending[2]!.resolve(); });
    await act(async () => { pending[0]!.resolve(); pending[3]!.resolve(); await Promise.all([first, second]); });
  });
  it('adjusts the request window without cancelling active imports', async () => {
    const { hook, pending } = setup();
    const done = hook.result.current.importPaths(['a', 'b', 'c', 'd', 'e']);
    vi.mocked(resourcePolicy.resourceAllocation).mockReturnValue({ ...resourcePolicy.resourceAllocation(), cpu_threads: 1 });
    act(() => { notifyResourceSettingsChanged(); });
    await act(async () => { pending[0]!.resolve(); });
    expect(mocks.import).toHaveBeenCalledTimes(2);
    vi.mocked(resourcePolicy.resourceAllocation).mockReturnValue({ ...resourcePolicy.resourceAllocation(), cpu_threads: 4 });
    await act(async () => { notifyResourceSettingsChanged(); });
    expect(mocks.import).toHaveBeenCalledTimes(5);
    await act(async () => { pending.slice(1).forEach(p => p.resolve()); await done; });
  });
  it('bounds lookahead by working memory even with many CPU slots', async () => {
    vi.mocked(resourcePolicy.resourceAllocation).mockReturnValue({ ...resourcePolicy.resourceAllocation(), cpu_threads: 32, work_mib: 256 });
    const { hook, pending } = setup();
    const done = hook.result.current.importPaths(['a', 'b', 'c']);
    expect(mocks.import).toHaveBeenCalledTimes(2);
    await act(async () => { pending[0]!.resolve(); });
    await act(async () => { pending.slice(1).forEach(p => p.resolve()); await done; });
  });
  it('stops issuing requests under memory pressure and resumes when it clears', async () => {
    const { hook, pending } = setup();
    const done = hook.result.current.importPaths(['a', 'b', 'c', 'd']);
    act(() => { updateRendererResources({ renderers: 1, pressure: 'constrained' }); });
    await act(async () => { pending.forEach(p => p.resolve()); });
    expect(mocks.import).toHaveBeenCalledTimes(2);
    await act(async () => { updateRendererResources({ renderers: 1, pressure: 'normal' }); });
    expect(mocks.import).toHaveBeenCalledTimes(4);
    await act(async () => { pending.slice(2).forEach(p => p.resolve()); await done; });
  });
  it('can retire a selection before any request starts, while pressure holds admission', async () => {
    const { hook } = setup();
    act(() => { updateRendererResources({ renderers: 1, pressure: 'constrained' }); });
    const done = hook.result.current.importPaths(['a', 'b']);
    hook.unmount();
    await done;
    expect(mocks.import).not.toHaveBeenCalled();
  });
});

describe('import probe scope', () => {
  it('rechecks the live source at drop time even before a new UI snapshot renders', async () => {
    mocks.probe.mockResolvedValue('ok');
    const project = summary('a');
    const hook = renderHook(() => useImportReadiness({ summary: project, run, previewRef }));
    await act(async () => {});
    const atDrop = hook.result.current.readinessOf;
    expect(atDrop('shared-id')).toEqual({ ready: true });
    mocks.pool.set('shared-id', { ...media('a.mov'), available: false });
    expect(atDrop('shared-id')).toEqual({ ready: false, reason: 'missing' });
    expect(hook.result.current.readinessById.get('shared-id')).toEqual({ ready: true });
  });
  it('keeps a decoded original actionable when its workspace copy enters the queue', async () => {
    mocks.probe.mockResolvedValue('ok');
    const project = summary('a');
    const hook = renderHook(() => useImportReadiness({ summary: project, run, previewRef }));
    await act(async () => {});
    await act(async () => { mocks.listeners.get('queue')!({ payload: [{ media_id: 'shared-id', status: { kind: 'Copying' } }] }); });
    expect(hook.result.current.readinessById.get('shared-id')).toEqual({ ready: true });
  });

  it('retains successful decode evidence across a same-content workspace copy', async () => {
    mocks.pool.set('shared-id', { ...media('a.mov'), content_hash: 'verified-content' });
    mocks.probe.mockResolvedValueOnce('ok').mockImplementation(() => new Promise(() => {}));
    const hook = renderHook(({ project }) => useImportReadiness({ summary: project, run, previewRef }), { initialProps: { project: summary('a') } });
    await act(async () => {});
    mocks.pool.set('shared-id', { ...media('project/Media/a.mov'), content_hash: 'verified-content' });
    hook.rerender({ project: summary('a') });
    expect(hook.result.current.decodeProbeMemo.current.get('shared-id')).toBe('ok');
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });

  it('cancels obsolete sweeps without publishing unsupported into the next project', async () => {
    const pending: { resolve: (verdict: string) => void; signal: AbortSignal }[] = [];
    mocks.probe.mockImplementation((_path, _deadline, signal) => new Promise((resolve) => pending.push({ resolve, signal })));
    const hook = renderHook(({ project }) => useImportReadiness({ summary: project, run, previewRef }), { initialProps: { project: summary('a') } });
    expect(pending).toHaveLength(1);
    act(() => { notifyResourceSettingsChanged(); notifyResourceSettingsChanged(); });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.signal.aborted).toBe(false);
    mocks.pool.set('shared-id', media('b.mov'));
    hook.rerender({ project: summary('b') });
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending).toHaveLength(2);
    await act(async () => { pending[0]!.resolve('unsupported'); pending[1]!.resolve('ok'); });
    expect(capability.markWebcodecsUnusable).not.toHaveBeenCalled(); expect(mocks.proxy).not.toHaveBeenCalled();
    expect(hook.result.current.decodeProbeMemo.current.get('shared-id')).toBe('ok');
  });

  it('retries unknown resource refusals and preserves a successful same-source memo', async () => {
    vi.useFakeTimers(); mocks.probe.mockResolvedValueOnce('unknown').mockResolvedValue('ok');
    const hook = renderHook(({ project }) => useImportReadiness({ summary: project, run, previewRef }), { initialProps: { project: summary('a') } });
    await act(async () => {});
    expect(capability.markWebcodecsUnusable).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(hook.result.current.decodeProbeMemo.current.get('shared-id')).toBe('ok');
    hook.rerender({ project: summary('a') }); await act(async () => {});
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    mocks.pool.set('shared-id', media('replacement.mov'));
    hook.rerender({ project: summary('a') }); await act(async () => {});
    expect(mocks.probe).toHaveBeenCalledTimes(3);
  });

  it('keeps the original probe running across proxy completion and retains its verdict', async () => {
    const pending: { resolve: (verdict: string) => void; signal: AbortSignal }[] = [];
    mocks.probe.mockImplementation((_path, _deadline, signal) => new Promise((resolve) => pending.push({ resolve, signal })));
    const refreshSources = vi.fn();
    const probePreviewRef = { current: { refreshSources } } as unknown as Parameters<typeof useImportReadiness>[0]["previewRef"];
    const hook = renderHook(({ project }) => useImportReadiness({
      summary: project, run, previewRef: probePreviewRef,
    }), { initialProps: { project: summary('a') } });
    // Quick-proxy completion publishes a fresh summary while the original
    // probe is pending. Use the real route selector and capability store.
    mocks.pool.set('shared-id', { ...media('a.mov'), decode_route: { route: 'direct-export', quick_proxy: '/quick.mp4' } });
    hook.rerender({ project: summary('a') });
    expect(pending[0]!.signal.aborted).toBe(false);
    expect(pending).toHaveLength(1);
    await act(async () => { pending[0]!.resolve('unsupported'); });
    expect(capability.isWebcodecsUnusable('shared-id')).toBe(true);
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
    expect(refreshSources).toHaveBeenCalled();
    expect(hook.result.current.decodeProbeMemo.current.has('shared-id')).toBe(false);
    hook.rerender({ project: summary('a') });
    expect(pending).toHaveLength(1);
    // Replacing the original invalidates even an unsupported verdict.
    mocks.pool.set('shared-id', media('replacement.mov'));
    hook.rerender({ project: summary('a') });
    expect(capability.isWebcodecsUnusable('shared-id')).toBe(false);
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!.resolve('ok'); });
    expect(hook.result.current.decodeProbeMemo.current.get('shared-id')).toBe('ok');
  });
});


describe('copy queue bootstrap', () => {
  it('does not overwrite a streamed completion with a stale initial query', async () => {
    mocks.pool.clear();
    let reply!: (entries: unknown[]) => void;
    mocks.list.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    const project = summary('a');
    const hook = renderHook(() => useImportReadiness({ summary: project, run, previewRef }));
    await act(async () => { mocks.listeners.get('queue')!({ payload: [{ media_id: 'a', status: { kind: 'Completed' } }] }); });
    await act(async () => { reply([{ media_id: 'a', status: { kind: 'Pending' } }]); });
    expect(hook.result.current.importsById.get('a')?.status.kind).toBe('Completed');
  });
});
