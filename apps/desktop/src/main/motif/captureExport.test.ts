import { afterEach, expect, it, vi } from 'vitest';
import { CAPTURE_SUPERSEDED_MESSAGE, MotifCaptureTimeoutError } from '../../shared/motifs/captureErrors';

const state = vi.hoisted(() => ({ opened: 0, loads: 0, active: 0, peak: 0, closed: 0, leases: 0, released: 0, shots: 0,
  failures: [] as Error[], onFailure: undefined as (() => void) | undefined }));
vi.mock('../resources.js', () => ({ reserveResources: vi.fn((_threads: number, _size: number, parent: number) => {
  expect(parent).toBe(77); state.leases++;
  return () => { state.released++; };
}) }));
vi.mock('../windows', () => ({ hardenWindow: () => {}, markInternalWindow: () => {} }));
vi.mock('electron', () => ({ BrowserWindow: class {
  url = 'about:blank'; t = 0; size = { width: 0, height: 0 };
  constructor() { state.opened++; }
  webContents = { debugger: { attach() {}, detach() {}, sendCommand: async (method: string, params: { expression?: string } = {}) => {
    if (method === 'Page.captureScreenshot') {
      state.shots++;
      if (state.failures.length) { state.onFailure?.(); throw state.failures.shift(); }
      state.active++; state.peak = Math.max(state.peak, state.active);
      const data = Buffer.from(JSON.stringify([this.url, this.t])).toString('base64');
      await new Promise(resolve => setTimeout(resolve, 10)); state.active--;
      return { data };
    }
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('window.__motifRender('))
      this.t = Number(params.expression.slice('window.__motifRender('.length).split(',')[0]);
    return { result: { value: true } };
  } } };
  loadURL = async (url: string) => { this.url = url; if (url.startsWith('motif:')) state.loads++; };
  setContentSize = (width: number, height: number) => { this.size = { width, height }; };
  destroy = () => { state.closed++; };
} }));

import { captureExportMotifFrameB64, captureDiagnostics, retireExportCaptureHosts, setRuntimeSource, setMotifStore } from './capture';
afterEach(async () => {
  state.failures.length = 0; state.onFailure = undefined;
  retireExportCaptureHosts(77); await new Promise(resolve => setTimeout(resolve, 0)); setMotifStore(null as never);
  Object.assign(state, { opened: 0, loads: 0, active: 0, peak: 0, closed: 0, leases: 0, released: 0, shots: 0 });
});

const retryFrame = () => ({ motifId: 'retry-transition', tSec: .433333, propsJson: '{"direction":1}',
  width: 32, height: 16, settleRafs: 2, contentHash: 'retry-test', fpsNum: 30, fpsDen: 1 });

it('rebuilds a timed-out screenshot page and captures exactly the same export frame once', async () => {
  setRuntimeSource('/* runtime */');
  const opened = state.opened, shots = state.shots, closed = state.closed;
  state.failures.push(new MotifCaptureTimeoutError(5000, 'Page.captureScreenshot'));
  const a = retryFrame(), data = await captureExportMotifFrameB64(a, 77);
  expect(state.opened - opened).toBe(2);
  expect(state.closed - closed).toBe(1);
  expect(state.shots - shots).toBe(2);
  const [url, time] = JSON.parse(Buffer.from(data, 'base64').toString());
  expect(url).toContain('motif://retry-transition/'); expect(time).toBe(a.tSec);
});

it('fails after the second screenshot timeout instead of retrying forever', async () => {
  const shots = state.shots;
  state.failures.push(new MotifCaptureTimeoutError(5000, 'Page.captureScreenshot'),
    new MotifCaptureTimeoutError(5000, 'Page.captureScreenshot'));
  await expect(captureExportMotifFrameB64(retryFrame(), 77)).rejects.toThrow('Page.captureScreenshot');
  expect(state.shots - shots).toBe(2);
});

it.each([new Error('authored content failed'), new MotifCaptureTimeoutError(5000, 'Runtime.evaluate')])(
  'does not retry other failures: %s', async failure => {
    const shots = state.shots; state.failures.push(failure);
    await expect(captureExportMotifFrameB64(retryFrame(), 77)).rejects.toBe(failure);
    expect(state.shots - shots).toBe(1);
  },
);

it('does not rebuild a screenshot page after export work becomes stale', async () => {
  let current = true; const shots = state.shots;
  state.onFailure = () => { current = false; };
  state.failures.push(new MotifCaptureTimeoutError(5000, 'Page.captureScreenshot'));
  await expect(captureExportMotifFrameB64(retryFrame(), 77, undefined, true, () => current))
    .rejects.toThrow(CAPTURE_SUPERSEDED_MESSAGE);
  expect(state.shots - shots).toBe(1);
});

it('captures three persistent pages with exact frame identity and at most two simultaneous operations', async () => {
  setRuntimeSource('/* runtime */');
  const jobs = [];
  for (let frame = 0; frame < 4; frame++) for (const motifId of ['plate', 'title', 'illustration']) {
    const a = { motifId, tSec: frame / 30, propsJson: '{}', width: 32, height: 16, settleRafs: 2, contentHash: 'v1', fpsNum: 30, fpsDen: 1 };
    jobs.push(captureExportMotifFrameB64(a, 77, `${motifId}:${frame}`).then(data => {
      const [url, time] = JSON.parse(Buffer.from(data, 'base64').toString());
      expect(url).toContain(`motif://${motifId}/`); expect(time).toBe(frame / 30);
    }));
  }
  await Promise.all(jobs);
  expect(state.peak).toBe(2); expect(state.opened).toBe(3); expect(state.loads).toBe(3);
  expect(captureDiagnostics().exportPools[0]).toMatchObject({ hosts: 3 });
  retireExportCaptureHosts(77);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(state.closed).toBe(3); expect(state.released).toBe(state.leases);
});

it('reuses only the exact last PNG for immutable non-media content and invalidates render inputs', async () => {
  setMotifStore({ getMotif: (id: string) => ({ manifest: { id, name: id, version: 1, size: [32, 16], default_duration_s: 1, props_schema: {} } }) } as never);
  const a = { motifId: 'held-title', tSec: .8, propsJson: '{}', width: 32, height: 16, settleRafs: 2, contentHash: 'v-cache' };
  const before = state.shots;
  const first = await captureExportMotifFrameB64(a, 77);
  expect(await captureExportMotifFrameB64(a, 77)).toBe(first);
  expect(state.shots - before).toBe(1);
  await captureExportMotifFrameB64({ ...a, tSec: .9 }, 77);
  await captureExportMotifFrameB64({ ...a, tSec: .9, settleRafs: 3 }, 77);
  await captureExportMotifFrameB64({ ...a, tSec: .9, settleRafs: 3, scale: 1 }, 77);
  await captureExportMotifFrameB64({ ...a, propsJson: '{"text":"changed"}' }, 77);
  expect(state.shots - before).toBe(5);
  expect(captureDiagnostics().exportCacheHits).toBeGreaterThan(0);
  retireExportCaptureHosts(77);
  await captureExportMotifFrameB64(a, 77);
  expect(state.shots - before).toBe(6);
});

it('never reuses PNGs when mutable media props exist', async () => {
  setMotifStore({ getMotif: (id: string) => ({ manifest: { id, name: id, version: 1, size: [32, 16], default_duration_s: 1,
    props_schema: { picture: { type: 'media', default: '' } } } }) } as never);
  const a = { motifId: 'mutable-image', tSec: .8, propsJson: '{}', width: 32, height: 16, settleRafs: 2, contentHash: 'v-media' };
  const before = state.shots;
  await captureExportMotifFrameB64(a, 77); await captureExportMotifFrameB64(a, 77);
  expect(state.shots - before).toBe(2);
});

it('retains immutable package assets for every resident page, releases on navigation and teardown, and budgets bytes', async () => {
  const released: string[] = [];
  const retainPackage = vi.fn((id: string) => () => released.push(id));
  setMotifStore({ retainPackage, pinnedPackageBytes: () => 16 * 1048576, getMotif: () => null } as never);
  for (const motifId of ['one', 'two', 'three']) {
    await captureExportMotifFrameB64({ motifId, tSec: 0, propsJson: '{}', width: 32, height: 16,
      settleRafs: 2, contentHash: 'a'.repeat(64) }, 77);
  }
  expect(retainPackage).toHaveBeenCalledTimes(3);
  expect(released).toEqual([]);
  await captureExportMotifFrameB64({ motifId: 'four', tSec: 0, propsJson: '{}', width: 32, height: 16,
    settleRafs: 2, contentHash: 'a'.repeat(64) }, 77);
  expect(released).toEqual(['one']);
  retireExportCaptureHosts(77);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(released.sort()).toEqual(['four', 'one', 'three', 'two']);
});
