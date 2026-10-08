// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaSummary, ProjectSummary } from "../ipc";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), proxy: vi.fn(), pool: new Map() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/bridge/ipc", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn() }));
vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../ipc", () => ({
  IMPORT_EVENTS: { queue: 'queue' }, MEDIA_JOB_EVENTS: { started: 'start', complete: 'complete', error: 'error' },
  importQueueList: async () => [], ensureFullProxy: mocks.proxy, importMedia: vi.fn(), logEmit: vi.fn(),
}));
vi.mock("../state/projectStore", () => ({ useProjectStore: { getState: () => ({ mediaById: mocks.pool }) } }));
vi.mock("../render/decoder/probeSourceDecodable", () => ({ classifyWebcodecsDecodability: mocks.probe }));
vi.mock("../panels/importOptimize", () => ({ importOptimizeStatus: () => 'checking', optimizeReason: () => '' }));
import * as capability from '../render/decoder/webcodecsCapability';
import { useImportReadiness } from './useImportReadiness';
import { notifyResourceSettingsChanged } from '../render/resourceClient';

const summary = (project_id: string) => ({ project_id } as ProjectSummary);
const media = (path: string) => ({ id: 'shared-id', path, kind: 'Video', decode_route: { route: 'direct-export', quick_proxy: null }, available: true, size_bytes: 1 } as MediaSummary);
const run = async (action: () => Promise<unknown>) => { await action(); };
const previewRef = { current: null };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  capability.resetWebcodecsCapabilitySession();
  vi.spyOn(capability, 'markWebcodecsUnusable');
  mocks.pool.clear();
  mocks.pool.set('shared-id', media('a.mov'));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('import probe scope', () => {
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

  it('finishes original capability after a proxy interrupts the probe and retains the verdict', async () => {
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
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending).toHaveLength(2);
    await act(async () => { pending[0]!.resolve('ok'); pending[1]!.resolve('unsupported'); });
    expect(capability.isWebcodecsUnusable('shared-id')).toBe(true);
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
    expect(refreshSources).toHaveBeenCalledTimes(1);
    expect(hook.result.current.decodeProbeMemo.current.has('shared-id')).toBe(false);
    hook.rerender({ project: summary('a') });
    expect(pending).toHaveLength(2);
    // Replacing the original invalidates even an unsupported verdict.
    mocks.pool.set('shared-id', media('replacement.mov'));
    hook.rerender({ project: summary('a') });
    expect(capability.isWebcodecsUnusable('shared-id')).toBe(false);
    expect(pending).toHaveLength(3);
    await act(async () => { pending[2]!.resolve('ok'); });
    expect(hook.result.current.decodeProbeMemo.current.get('shared-id')).toBe('ok');
  });
});
