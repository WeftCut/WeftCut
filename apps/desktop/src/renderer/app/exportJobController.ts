import { invoke } from '@/bridge/ipc';
import { listen } from '@/bridge/events';
import { projectSummary } from '../ipc';
import { exportTerminal, type ExportJob, type ExportRun } from '../../shared/exportJob';
import { createExportRunner } from './exportRunner';
import { composeStillsSheet } from './stillsSheet';
import type { ExportState } from '../panels/ExportPanel';

/** Renderer adapter: readiness is announced only after all control listeners
 * exist. A terminal acknowledgement is sent only after runner cleanup settles. */
export function createExportJobController(deps: Omit<Parameters<typeof createExportRunner>[0], 'publish' | 'cancel'> & { onBegin: (request: ExportRun) => void }) {
  const token = crypto.randomUUID();
  let active: ExportRun | undefined;
  let abort = new AbortController();
  let running = Promise.resolve();
  let disposed = false;
  let state: ExportState | null = null;
  const unsubscribers: Array<() => void> = [];
  const settledJobs = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  const args = () => ({ job_id: active!.job_id, renderer_token: token });
  const reportError = (error: unknown) => console.error('[export job]', error);
  const cancel = () => { if (active) void invoke('export_job_cancel', { job_id: active.job_id }).catch(reportError); };
  const display = () => {
    if (disposed) return;
    deps.onState(state && active ? {
      ...state, job: active,
      ...(!['complete', 'error'].includes(state.kind) ? { onCancel: cancel } : {}),
      ...(state.kind === 'error' && state.onRetry ? {
        onRetry: async (filename?: string) => { await invoke('export_job_retry', { job_id: active!.job_id, ...(filename ? { filename } : {}) }); },
        onDiscard: async () => { await invoke('export_job_cancel', { job_id: active!.job_id }); },
      } : {}),
    } as ExportState : state);
  };
  const runner = createExportRunner({
    ...deps, cancel,
    publish: () => invoke<string>('export_job_publish', args()),
    onState: next => {
      state = next; display();
      if (!active || !next || next.kind === 'error' || next.kind === 'complete') return;
      const update = {
        state: next.kind === 'progress' ? 'rendering' : next.kind === 'finalizing' ? 'finalizing' : 'preparing',
        ...(next.kind === 'finalizing' ? { phase: next.step } : {}),
        ...(next.kind === 'progress' ? { progress: next.progress.progress } : {})
      };
      void invoke('export_job_update', { ...args(), update }).catch(reportError);
    },
  });
  const settle = async () => {
    if (!active || exportTerminal(active.state)) return;
    const final = runner.state();
    const update = final?.kind === 'complete' ? { state: 'completed', duration_us: final.payload.durationUs }
      : final?.kind === 'error' && final.onRetry && !abort.signal.aborted ? { state: 'awaiting_retry', error: { code: 'finalization_failed', message: final.detail } }
        : abort.signal.aborted || !final ? { state: 'cancelled' }
          : { state: 'failed', error: { code: 'export_failed', message: final.kind === 'error' ? final.detail : 'Export ended without a result' } };
    await invoke('export_job_update', { ...args(), update });
  };
  const enqueue = (operation: () => Promise<void>) => {
    running = running.then(operation).catch(async error => {
      reportError(error);
      state = { kind: 'error', detail: String(error) }; display();
      if (active && !exportTerminal(active.state)) await invoke('export_job_update', { ...args(), update: { state: 'failed', error: { code: 'export_failed', message: String(error) } } }).catch(reportError);
    });
    return running;
  };
  let readyAttempt = 0;
  const announceReady = async () => {
    const attempt = ++readyAttempt;
    try {
      const session = await invoke<{ root_id: string; generation: number }>('export_job_session');
      const summary = await projectSummary();
      if (!disposed && attempt === readyAttempt && summary.root_id === session.root_id) {
        await invoke('export_job_ready', { renderer_token: token, ...session });
      }
    } catch (error) {
      // Closing/opening invalidates a handshake in flight. The settled session
      // event below retries after the host has committed the new workspace.
      if (!disposed) reportError(error);
    }
  };
  return {
    waitUntilSettled(id: string) {
      if (settledJobs.has(id)) return Promise.resolve();
      return new Promise<void>(resolve => waiters.set(id, [...(waiters.get(id) ?? []), resolve]));
    },
    async mount() {
      const subscriptions = await Promise.all([
        listen('project:workspace-changing', () => { readyAttempt++; }),
        listen('export:session_ready', () => { void announceReady(); }),
        listen<ExportRun>('export:run', ({ payload: request }) => {
          if (disposed || request.renderer_token !== token || active && !exportTerminal(active.state)) return;
          active = request; abort = new AbortController(); deps.onBegin(request);
          void enqueue(async () => { await runner.run(request, abort); if (abort.signal.aborted) await runner.discard(); await settle(); });
        }),
        // `render_frames`: export-path stills for an agent, queued behind any
        // export so the two never share the pipeline.
        listen<{ request_id: string; renderer_token: string; times_us: number[]; width: number; sheet: boolean; settings: ExportRun['settings'] }>('render_frames:run', ({ payload: r }) => {
          if (disposed || r.renderer_token !== token) return;
          void enqueue(async () => {
            const reply = (body: Record<string, unknown>) => invoke('export_job_stills', { request_id: r.request_id, renderer_token: token, ...body });
            try {
              const frames = await runner.runStills(r, new AbortController().signal);
              const sheet = r.sheet && frames.length > 0 ? await composeStillsSheet(frames) : null;
              await reply(sheet
                ? { frames: frames.map(({ t_us, width, height }) => ({ t_us, width, height })), sheet: { ...sheet, jpeg: new Uint8Array(sheet.jpeg) } }
                : { frames: frames.map((f) => ({ ...f, jpeg: new Uint8Array(f.jpeg) })) });
            } catch (error) {
              await reply({ error: error instanceof Error ? error.message : String(error) }).catch(reportError);
            }
          });
        }),
        listen<{ job_id: string; renderer_token: string }>('export:cancel', ({ payload }) => {
          if (payload.renderer_token !== token || payload.job_id !== active?.job_id) return;
          abort.abort();
          void enqueue(async () => { await runner.discard(); await settle(); });
        }),
        listen<{ job_id: string; renderer_token: string }>('export:retry', ({ payload }) => {
          if (payload.renderer_token !== token || payload.job_id !== active?.job_id) return;
          void enqueue(async () => { await runner.retry(); if (abort.signal.aborted) await runner.discard(); await settle(); });
        }),
        listen<ExportJob>('export:status', ({ payload }) => {
          if (exportTerminal(payload.state) || payload.state === 'awaiting_retry') {
            settledJobs.add(payload.job_id);
            waiters.get(payload.job_id)?.forEach(resolve => resolve());
            waiters.delete(payload.job_id);
          }
          if (active?.job_id === payload.job_id) {
            active = { ...active, ...payload };
            if (payload.state === 'completed') state = { kind: 'complete', payload: { outputPath: payload.output_path, durationUs: payload.duration_us ?? 0 } };
            if (payload.state === 'cancelled') state = null;
            display();
          }
          else if (!active || exportTerminal(active.state)) {
            if (payload.state === 'failed') deps.onState({ kind: 'error', job: payload, detail: payload.error?.message ?? 'Export failed' });
            else if (payload.state === 'cancelled') deps.onState(null);
            else if (!exportTerminal(payload.state)) deps.onState({ kind: 'starting', job: payload, onCancel: () => { void invoke('export_job_cancel', { job_id: payload.job_id }).catch(reportError); } });
          }
        }),
      ]);
      if (disposed) { subscriptions.forEach(f => f()); return; }
      unsubscribers.push(...subscriptions);
      await announceReady();
    },
    async dispose() {
      disposed = true; abort.abort();
      unsubscribers.splice(0).forEach(f => f());
      if (active && !exportTerminal(active.state)) await invoke('export_job_cancel', { job_id: active.job_id }).catch(reportError);
      await running; await runner.discard(); await settle();
      await invoke('export_job_detaching', { renderer_token: token }).catch(reportError);
    },
  };
}
