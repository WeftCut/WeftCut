import { beforeEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { createExportJobController } from './exportJobController';

const mock = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(), summary: vi.fn(),
  runner: { state: () => null as unknown, discard: async () => { }, run: async (_request: unknown, _abort: AbortController) => { }, retry: async () => { } },
}));
vi.mock('@/bridge/ipc', () => ({ invoke: mock.invoke }));
vi.mock('@/bridge/events', () => ({
listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    mock.listeners.set(name, callback);
    return () => { mock.listeners.delete(name); };
  }
}));
vi.mock('../ipc', () => ({ projectSummary: mock.summary }));
vi.mock('./exportRunner', () => ({ createExportRunner: () => ({
  state: () => mock.runner.state(), discard: () => mock.runner.discard(),
  run: (request: unknown, abort: AbortController) => mock.runner.run(request, abort), retry: () => mock.runner.retry(),
}) }));

beforeEach(() => {
  mock.listeners.clear(); mock.invoke.mockReset(); mock.summary.mockReset();
  mock.runner.state = () => null; mock.runner.discard = async () => { };
  mock.runner.run = async () => { }; mock.runner.retry = async () => { };
});
const controller = () => createExportJobController({
  previewRef: { current: null }, proxyStateRef: { current: new Map() }, decodeProbeMemo: { current: new Map() },
  t: vi.fn() as unknown as TFunction, onState: vi.fn(), onBegin: vi.fn(),
});

it('renews readiness after a workspace replacement without requiring the editor to remount', async () => {
  let generation = 1;
  mock.invoke.mockImplementation(async channel => channel === 'export_job_session' ? { root_id: 'root', generation } : undefined);
  mock.summary.mockResolvedValue({ root_id: 'root' });
  const c = controller(); await c.mount();
  expect(mock.invoke).toHaveBeenCalledWith('export_job_ready', expect.objectContaining({ generation: 1 }));
  mock.listeners.get('project:workspace-changing')!({ payload: {} });
  generation = 2;
  mock.listeners.get('export:session_ready')!({ payload: {} });
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('export_job_ready', expect.objectContaining({ generation: 2 })));
  await c.dispose();
});

it('subscribes before hydration and recovers if mounting races an in-flight project open', async () => {
  let opening = true;
  mock.invoke.mockImplementation(async channel => {
    if (channel === 'export_job_session') {
      expect(mock.listeners.has('export:run')).toBe(true);
      if (opening) throw new Error('project_busy');
      return { root_id: 'new-root', generation: 3 };
    }
  });
  mock.summary.mockResolvedValue({ root_id: 'new-root' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => { });
  const c = controller();
  try {
    await c.mount(); opening = false;
    mock.listeners.get('export:session_ready')!({ payload: {} });
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('export_job_ready', expect.objectContaining({ root_id: 'new-root', generation: 3 })));
  } finally { await c.dispose(); log.mockRestore(); }
});

const job = (job_id: string) => ({ job_id, renderer_token: '', state: 'preparing' }) as never;
const emit = (name: string, payload: unknown) => mock.listeners.get(name)!({ payload });
const updatesFor = (id: string) => mock.invoke.mock.calls
  .filter(([channel, args]) => channel === 'export_job_update' && args.job_id === id).map(([, args]) => args.update.state);
// A run that ends only when its abort fires, as a cancelled export does.
const runUntilAborted = () => { mock.runner.run = (_request, abort) => new Promise(resolve => abort.signal.aborted ? resolve() : abort.signal.addEventListener('abort', () => resolve())); };
async function mountedWithToken() {
  mock.invoke.mockImplementation(async channel => channel === 'export_job_session' ? { root_id: 'root', generation: 0 } : undefined);
  mock.summary.mockResolvedValue({ root_id: 'root' });
  const c = controller(); await c.mount();
  const token = mock.invoke.mock.calls.find(([channel]) => channel === 'export_job_ready')![1].renderer_token as string;
  return { c, run: (id: string) => emit('export:run', { ...(job(id) as object), renderer_token: token }), cancel: (id: string) => emit('export:cancel', { job_id: id, renderer_token: token }) };
}

// Main may answer the terminal update before its status event arrives; the
// job is still reported terminal once (a second report is `stale_renderer`).
it('reports a cancelled job terminal once, whatever order main answers in', async () => {
  runUntilAborted();
  const { c, run, cancel } = await mountedWithToken();
  run('a'); cancel('a');
  await vi.waitFor(() => expect(updatesFor('a')).toContain('cancelled'));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(updatesFor('a')).toEqual(['cancelled']);
  await c.dispose();
});

// Work queued for a cancelled job never reports for the job that follows it.
it('never reports a cancelled job\'s outcome against the next job', async () => {
  runUntilAborted();
  const { c, run, cancel } = await mountedWithToken();
  let release!: () => void;
  let discards = 0;
  mock.runner.discard = () => ++discards === 2 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  run('a'); cancel('a');
  await vi.waitFor(() => expect(discards).toBe(2));
  emit('export:status', { ...(job('a') as object), state: 'cancelled' });
  let finishB!: () => void;
  mock.runner.run = () => new Promise<void>(resolve => { finishB = resolve; });
  run('b');
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(updatesFor('b')).toEqual([]);
  mock.runner.state = () => ({ kind: 'complete', payload: { durationUs: 1 } });
  await vi.waitFor(() => expect(finishB).toBeTypeOf('function'));
  finishB();
  await vi.waitFor(() => expect(updatesFor('b')).toEqual(['completed']));
  await c.dispose();
});
