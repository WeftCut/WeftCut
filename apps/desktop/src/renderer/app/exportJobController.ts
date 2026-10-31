import { invoke } from '@/bridge/ipc';
import { listen } from '@/bridge/events';
import { projectSummary } from '../ipc';
import { exportTerminal, type ExportJob, type ExportRun } from '../../shared/exportJob';
import { createExportRunner } from './exportRunner';
import { composeStillsSheet } from './stillsSheet';
import type { ExportState } from '../panels/ExportPanel';

/** Renderer adapter: readiness is announced only after all control listeners
 * exist. A terminal acknowledgement is sent only after runner cleanup settles.
 * Each queued step reports for the job it was queued for, never for whichever
 * job is active when it runs, and each job is reported terminal once: main
 * may answer before its status event arrives, and by then the next job can be
 * active. */
export function createExportJobController(deps: Omit<Parameters<typeof createExportRunner>[0], 'publish' | 'cancel'> & { onBegin: (request: ExportRun) => void }) {
  const token = crypto.randomUUID();
  let active: ExportRun | undefined;
  let abort = new AbortController();
  let running = Promise.resolve();
  let disposed = false;
  let state: ExportState | null = null;
  const unsubscribers: Array<() => void> = [];
  const settledJobs = new Set<string>();
  // Jobs reported terminal, by this controller or by main's status event.
  const ended = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  const args = (job: ExportRun) => ({ job_id: job.job_id, renderer_token: token });
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
    publish: () => invoke<string>('export_job_publish', args(active!)),
    onState: next => {
      state = next; display();
      if (!active || ended.has(active.job_id) || !next || next.kind === 'error' || next.kind === 'complete') return;
      const update = {
        state: next.kind === 'progress' ? 'rendering' : next.kind === 'finalizing' ? 'finalizing' : 'preparing',
        ...(next.kind === 'finalizing' ? { phase: next.step } : {}),
        ...(next.kind === 'progress' ? { progress: next.progress.progress } : {})
      };
      void invoke('export_job_update', { ...args(active), update }).catch(reportError);
    },
  });
  const report = async (job: ExportRun, update: { state: string; [key: string]: unknown }) => {
    if (ended.has(job.job_id)) return;
    await invoke('export_job_update', { ...args(job), update });
    if (exportTerminal(update.state as ExportJob['state'])) ended.add(job.job_id);
  };
  const settle = async (job: ExportRun, aborted: AbortSignal) => {
    const final = runner.state();
    await report(job, final?.kind === 'complete' ? { state: 'completed', duration_us: final.payload.durationUs }
      : final?.kind === 'error' && final.onRetry && !aborted.aborted ? { state: 'awaiting_retry', error: { code: 'finalization_failed', message: final.detail } }
        : aborted.aborted || !final ? { state: 'cancelled' }
          : { state: 'failed', error: { code: 'export_failed', message: final.kind === 'error' ? final.detail : 'Export ended without a result' } });
  };
  const enqueue = (job: ExportRun | undefined, operation: () => Promise<void>) => {
    running = running.then(operation).catch(async error => {
      reportError(error);
      state = { kind: 'error', detail: String(error) }; display();
      if (job) await report(job, { state: 'failed', error: { code: 'export_failed', message: String(error) } }).catch(reportError);
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
          const jobAbort = abort = new AbortController();
          active = request; deps.onBegin(request);
          void enqueue(request, async () => { await runner.run(request, jobAbort); if (jobAbort.signal.aborted) await runner.discard(); await settle(request, jobAbort.signal); });
        }),
        // `render_frames`: export-path stills for an agent, queued behind any
        // export so the two never share the pipeline.
        listen<{ request_id: string; renderer_token: string; times_us: number[]; width: number; sheet: boolean; settings: ExportRun['settings'] }>('render_frames:run', ({ payload: r }) => {
          if (disposed || r.renderer_token !== token) return;
          void enqueue(undefined, async () => {
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
          const job = active, jobAbort = abort;
          jobAbort.abort();
          void enqueue(job, async () => { await runner.discard(); await settle(job, jobAbort.signal); });
        }),
        listen<{ job_id: string; renderer_token: string }>('export:retry', ({ payload }) => {
          if (payload.renderer_token !== token || payload.job_id !== active?.job_id) return;
          const job = active, jobAbort = abort;
          void enqueue(job, async () => { await runner.retry(); if (jobAbort.signal.aborted) await runner.discard(); await settle(job, jobAbort.signal); });
        }),
        listen<ExportJob>('export:status', ({ payload }) => {
          if (exportTerminal(payload.state)) ended.add(payload.job_id);
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
      await running; await runner.discard();
      if (active) await settle(active, abort.signal);
      await invoke('export_job_detaching', { renderer_token: token }).catch(reportError);
    },
  };
}
