import { applyExportPreset, exportPresetLibrary, initialExportSettings, type ExportPreset, type ExportPresetPreferences } from '../shared/export-presets';
import type { ExportSettings } from '../shared/exportSettings';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TsActorHost } from './state/ts-actor-host';
import { rootComposition } from './state/model';
import { snapFrameRound } from './state/snap';
import { resolveExportRequest, resolveExportOptions, EXPORT_COMPATIBILITY, ExportValidationError } from '../shared/exportValidation';
import { exportTerminal, exportWire, type ExportJob, type ExportRun } from '../shared/exportJob';

/** Rendered stills: JPEG bytes per time, or one labelled sheet of them. */
export interface StillsResult {
  /** Without `sheet`, each frame's JPEG; with it, the times and sizes only. */
  frames: Array<{ t_us: number; width: number; height: number; jpeg?: Uint8Array }>;
  sheet?: { width: number; height: number; jpeg: Uint8Array };
}

export class ExportJobError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) { super(message); }
}
interface Entry {
  view: ExportJob; staging: string; video: string; audio: string; policy: 'rename' | 'fail' | 'overwrite';
  session: string; renderer?: string; dispatched: boolean; cancelling: boolean;
  published: boolean; prepared?: boolean; timer?: ReturnType<typeof setTimeout>; preparation: Promise<void>;
  publishing?: Promise<string>; finishing?: Promise<void>;
}
interface Deps {
  host: () => TsActorHost | null;
  native: (channel: string, args: Record<string, unknown>) => Promise<unknown>;
  send: (event: string, payload: unknown) => void;
  exportPreferences?: () => ExportPresetPreferences;
  readyTimeoutMs?: number;
  generation?: () => number;
}
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
export function exportBasename(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? 'weftcut-export' : safe;
}
/** A missing entry is safe to report as absent; unreadable entries are not. */
export async function exportPathExists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

/** Suggest only: the UI adopts the name explicitly and publication rechecks it. */
export async function suggestExportName(file: string): Promise<string | null> {
  const { dir, name, ext } = path.parse(file);
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = `${name} (${suffix})`;
    if (!await exportPathExists(path.join(dir, `${candidate}${ext}`))) return candidate;
  }
  return null;
}

/** Application-session authority. No transport, React or encoder ownership. */
export class ExportJobs {
  private entries = new Map<string, Entry>();
  private requests = new Map<string, { fingerprint: string; result: Promise<ExportJob> }>();
  private active?: Entry;
  private ready?: { token: string; session: string };
  private idleWaiters = new Set<() => void>();
  private stopping = false;
  private stills = new Map<string, { token: string; resolve: (v: StillsResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private deps: Deps) { }

  /** `render_frames`: the root at each time, rendered by the export pipeline
   *  in the app window and handed back as JPEGs (one contact sheet with
   *  `sheet`). Never alongside an export; the renderer must have announced the
   *  open project's session. */
  async renderStills(req: { times_us: number[]; width: number; sheet: boolean }): Promise<StillsResult> {
    const h = this.host();
    if (this.active) throw new ExportJobError('export_active', 'An export is running; render frames after it finishes');
    if (!this.ready || this.ready.session !== this.session(h)) throw new ExportJobError('renderer_unavailable', 'The app window is not ready to render this project yet; retry in a moment');
    const settings = await this.savedSettings(h);
    const id = randomUUID(), token = this.ready.token;
    return new Promise<StillsResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stills.delete(id);
        reject(new ExportJobError('render_timeout', `Rendering ${req.times_us.length} frame(s) did not finish in time`));
      }, 60_000 + 20_000 * req.times_us.length);
      this.stills.set(id, { token, resolve, reject, timer });
      this.deps.send('render_frames:run', { request_id: id, renderer_token: token, ...req, settings });
    });
  }
  /** The renderer's answer to `render_frames:run`. */
  stillsResult(p: { request_id: string; renderer_token: string; frames?: StillsResult['frames']; sheet?: StillsResult['sheet']; error?: string }) {
    const pending = this.stills.get(p.request_id);
    if (!pending || pending.token !== p.renderer_token) return;
    this.stills.delete(p.request_id);
    clearTimeout(pending.timer);
    if (p.error !== undefined) pending.reject(new ExportJobError('render_failed', p.error));
    else pending.resolve({ frames: p.frames ?? [], ...(p.sheet ? { sheet: p.sheet } : {}) });
  }
  isActive() { return !!this.active; }
  assertWritable() {
    if (this.active) throw new ExportJobError('export_busy', 'An export is active; finish or discard it before editing or switching projects', this.status());
  }
  private host() {
    const h = this.deps.host();
    if (!h?.openedProject()) throw new ExportJobError('no_project_open', 'Open a project before exporting');
    if (h.projectOperationPending?.()) throw new ExportJobError('project_busy', 'Wait for the project operation to finish');
    return h;
  }
  private session(h: TsActorHost) { return `${h.openedProject()!.dir}\n${h.actor.snapshot().root_id}\n${this.deps.generation?.() ?? 0}`; }
  rendererSession() { const h = this.host(); return { root_id: h.actor.snapshot().root_id, generation: this.deps.generation?.() ?? 0 }; }
  forgetRenderer() { this.ready = undefined; }
  workspaceSettled() {
    // Close also settles a workspace transition, but its renderer may not have
    // unmounted yet. Only invite a readiness handshake for an open project.
    if (this.deps.host()?.openedProject()) this.deps.send('export:session_ready', {});
  }
  private composition(h: TsActorHost) {
    const c = rootComposition(h.actor.snapshot());
    return { width: c.width, height: c.height, fps_num: c.fps.num, fps_den: c.fps.den, duration_us: c.duration_us };
  }
  private preset(id: unknown): ExportPreset | undefined {
    if (id === undefined) return undefined;
    if (typeof id !== 'string' || !id.trim()) throw new ExportValidationError('preset_id must be a nonempty string');
    const preset = exportPresetLibrary(this.deps.exportPreferences?.() ?? {}).find(p => p.id === id);
    if (!preset) throw new ExportJobError('not_found', `Unknown export preset ${id}; call list_export_presets`);
    return structuredClone(preset);
  }
  private async savedSettings(h: TsActorHost, preset?: ExportPreset) {
    const saved = await h.handleInvoke('export_settings_get', {}) as Partial<ExportSettings> | null;
    const current = initialExportSettings(saved, this.deps.exportPreferences?.() ?? {}, this.composition(h));
    return preset ? applyExportPreset(preset, this.composition(h), current) : current;
  }
  async options(presetId?: unknown) {
    const h = this.host();
    const options = resolveExportOptions(await this.savedSettings(h, this.preset(presetId)), this.composition(h), snapFrameRound);
    return exportWire({
      ...options, default_output_path: path.join(h.openedProject()!.dir, 'output', `${exportBasename(h.actor.snapshot().metadata.name)}.${options.extension}`),
      compatibility: EXPORT_COMPATIBILITY, range_unit: 'microseconds', range_end: 'exclusive', experimental_10bit_requires_opt_in: true
    }, true);
  }
  status(id?: string): ExportJob | null {
    const j = id ? this.entries.get(id) : this.active;
    if (id && !j) throw new ExportJobError('not_found', `Unknown export job ${id}`);
    return j ? structuredClone({ ...j.view, can_cancel: !exportTerminal(j.view.state), can_retry: j.view.state === 'awaiting_retry' && !j.cancelling }) : null;
  }
  private notify(j: Entry) { this.deps.send('export:status', this.status(j.view.job_id)); }
  start(args: Record<string, unknown>, agent = true): Promise<ExportJob> {
    const fingerprint = canonical({ args, agent });
    const key = args.request_id;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) return Promise.reject(new ExportValidationError('request_id must be a nonempty string of at most 200 characters'));
    if (typeof key === 'string') {
      const existing = this.requests.get(key);
      if (existing) return existing.fingerprint === fingerprint ? existing.result.then(j => this.status(j.job_id)!)
        : Promise.reject(new ExportJobError('request_id_conflict', 'request_id was already used with different arguments'));
    }
    const result = this.admit(args, agent);
    if (typeof key === 'string') {
      this.requests.set(key, { fingerprint, result });
      // A refused admission is not a recorded export intent.
      void result.catch(() => { if (this.requests.get(key)?.result === result) this.requests.delete(key); });
    }
    return result;
  }
  private async admit(a: Record<string, unknown>, agent: boolean): Promise<ExportJob> {
    if (this.stopping) throw new ExportJobError('app_closing', 'The application is closing');
    this.assertWritable();
    const h = this.host();
    const allowed = ['request_id', 'output_path', 'on_conflict', 'settings', 'range', 'allow_experimental_10bit', 'preset_id'];
    if (Object.keys(a).some(k => !allowed.includes(k))) throw new ExportValidationError('Unknown export argument');
    if (a.on_conflict !== undefined && !['rename', 'fail', ...(!agent ? ['overwrite'] : [])].includes(String(a.on_conflict))) throw new ExportValidationError('Invalid on_conflict policy');
    if (a.allow_experimental_10bit !== undefined && typeof a.allow_experimental_10bit !== 'boolean') throw new ExportValidationError('allow_experimental_10bit must be boolean');
    if (agent) {
      const checkWireKeys = (value: unknown): void => {
        if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) {
          if (/[A-Z]/.test(key)) throw new ExportValidationError('MCP export fields must use snake_case');
          checkWireKeys(nested);
        }
      };
      checkWireKeys(a.settings); checkWireKeys(a.range);
    }
    // Snapshot the selected recipe before any await; edits cannot change an admitted job.
    const preset = this.preset(a.preset_id);
    // Reserve synchronously before reading defaults or touching the filesystem.
    const j: Entry = {
      view: { job_id: randomUUID(), state: 'preparing', output_path: '', filename: '', agent, settings: {} as ExportJob['settings'], range: { startUs: 0, endUs: 0 } },
      staging: '', video: '', audio: '', policy: (a.on_conflict ?? (agent ? 'rename' : 'fail')) as Entry['policy'], session: this.session(h), dispatched: false, cancelling: false, published: false, preparation: Promise.resolve()
    };
    this.active = j; this.entries.set(j.view.job_id, j);
    j.preparation = (async () => {
      const resolved = resolveExportRequest(await this.savedSettings(h, preset), agent ? exportWire(a.settings, false) : a.settings,
        this.composition(h), (agent ? exportWire(a.range, false) : a.range) as ExportJob['range'] | undefined, !agent || a.allow_experimental_10bit === true, snapFrameRound);
      Object.assign(j.view, { settings: resolved.settings, range: resolved.range });
      j.video = path.join(os.tmpdir(), `weftcut-export-${j.view.job_id}-video.${['prores', 'dnxhr'].includes(resolved.settings.codec) ? 'mov' : 'mp4'}`);
      j.audio = path.join(os.tmpdir(), `weftcut-export-${j.view.job_id}-audio.${resolved.settings.audio.codec === 'opus' ? 'mka' : 'm4a'}`);
      let destination: string;
      if (a.output_path === undefined) {
        const dir = path.join(h.openedProject()!.dir, 'output');
        await fs.mkdir(dir, { recursive: true });
        destination = path.join(dir, `${exportBasename(h.actor.snapshot().metadata.name)}.${resolved.extension}`);
      } else {
        if (typeof a.output_path !== 'string' || !path.isAbsolute(a.output_path)) throw new ExportValidationError('output_path must be absolute');
        destination = path.resolve(a.output_path);
        if (!agent) await fs.mkdir(path.dirname(destination), { recursive: true });
      }
      if (path.extname(destination).toLowerCase() !== `.${resolved.extension}`) throw new ExportValidationError(`output_path must end in .${resolved.extension}`);
      if (j.policy === 'fail' && await exportPathExists(destination)) throw new ExportJobError('output_conflict', 'Output already exists; choose another filename');
      j.view.output_path = destination; j.view.filename = path.basename(destination);
      j.staging = await this.deps.native('export_prepare_output', { output: destination }) as string;
      await this.deps.native('export_begin', {});
      j.prepared = true;
    })();
    try {
      await j.preparation;
      if (j.cancelling) await this.finish(j, 'cancelled');
      else {
        this.notify(j);
        if (!this.dispatch(j)) {
          j.view.phase = 'waiting_for_renderer'; this.notify(j);
          j.timer = setTimeout(() => { void this.finish(j, 'failed', 'Export renderer did not become ready', 'renderer_unavailable').catch(() => { }); }, this.deps.readyTimeoutMs ?? 30_000);
          j.timer.unref?.();
        }
      }
    } catch (e) { await this.finish(j, 'failed', e instanceof Error ? e.message : String(e), e instanceof ExportJobError ? e.code : e instanceof ExportValidationError ? 'invalid_params' : 'output_unavailable'); }
    return this.status(j.view.job_id)!;
  }
  rendererReady(token: string, rootId: string, generation = 0) {
    const h = this.host();
    if (h.actor.snapshot().root_id !== rootId || generation !== (this.deps.generation?.() ?? 0)) throw new ExportJobError('stale_renderer', 'Renderer belongs to another project session');
    this.ready = { token, session: this.session(h) };
    if (this.active) this.dispatch(this.active);
  }
  private dispatch(j: Entry) {
    if (!j.prepared || j.dispatched || j.cancelling || !this.ready || this.ready.session !== j.session) return false;
    clearTimeout(j.timer); j.dispatched = true; j.renderer = this.ready.token; j.view.phase = 'preparing';
    const request: ExportRun = { ...j.view, staging_path: j.staging, encoded_video_path: j.video, encoded_audio_path: j.audio, renderer_token: j.renderer };
    this.deps.send('export:run', request); return true;
  }
  private owned(id: string, token: string) {
    const j = this.entries.get(id);
    if (!j || j !== this.active || j.renderer !== token) throw new ExportJobError('stale_renderer', 'Export renderer or job is no longer current');
    return j;
  }
  async update(id: string, token: string, update: Partial<ExportJob>) {
    const j = this.owned(id, token);
    if (typeof update.progress === 'number' && Number.isFinite(update.progress)) j.view.progress = Math.max(0, Math.min(1, update.progress));
    if (typeof update.duration_us === 'number') j.view.duration_us = update.duration_us;
    if (update.state && exportTerminal(update.state)) {
      if (update.state === 'completed' && !j.published) throw new ExportJobError('invalid_state', 'Export cannot complete before publication');
      await this.finish(j, j.published ? 'completed' : j.cancelling ? 'cancelled' : update.state, update.error?.message, update.error?.code);
    } else if (update.state && ['preparing', 'rendering', 'finalizing', 'awaiting_retry'].includes(update.state)) {
      j.view.state = update.state; j.view.error = update.error;
      if (!j.cancelling) j.view.phase = update.phase && ['sink', 'audio', 'mux'].includes(update.phase) ? update.phase : update.state;
      this.notify(j);
    }
    return this.status(id);
  }
  async publish(id: string, token: string): Promise<string> {
    const j = this.owned(id, token);
    if (j.published) return j.view.output_path;
    if (j.cancelling) throw new ExportJobError('cancelled', 'Export cancelled');
    if (j.publishing) return j.publishing;
    j.publishing = this.deps.native('export_publish_output', { staging: j.staging, output: j.view.output_path, policy: j.policy }).then(actual => {
      j.published = true; j.view.output_path = String(actual); j.view.filename = path.basename(String(actual)); return String(actual);
    });
    try { return await j.publishing; } finally { j.publishing = undefined; }
  }
  async cancel(id: string) {
    const j = this.entries.get(id);
    if (!j) throw new ExportJobError('not_found', `Unknown export job ${id}`);
    if (exportTerminal(j.view.state)) return this.status(id);
    j.cancelling = true; j.view.phase = 'cancelling'; clearTimeout(j.timer); this.notify(j);
    await j.preparation.catch(() => { });
    // Publication is the commit point; settle it before deciding cancellation.
    await j.publishing?.catch(() => { });
    if (!j.published) await this.deps.native('export_cancel', {});
    if (j.dispatched) this.deps.send('export:cancel', { job_id: id, renderer_token: j.renderer });
    else await this.finish(j, 'cancelled');
    return this.status(id);
  }
  async retry(id: string, filename?: string) {
    const j = this.entries.get(id);
    if (!j || j !== this.active || j.view.state !== 'awaiting_retry' || j.cancelling) throw new ExportJobError('not_retryable', 'Export is not awaiting retry');
    if (filename !== undefined) {
      if (!filename || exportBasename(filename) !== filename || path.basename(filename) !== filename || path.extname(filename).toLowerCase() !== path.extname(j.view.output_path).toLowerCase()) throw new ExportValidationError('filename must be a valid basename with the same extension');
      if (filename !== j.view.filename) { j.view.output_path = path.join(path.dirname(j.view.output_path), filename); j.view.filename = filename; if (j.policy === 'overwrite') j.policy = 'fail'; }
    }
    j.view.state = 'finalizing'; j.view.phase = 'finalizing'; delete j.view.error; this.notify(j);
    this.deps.send('export:retry', { job_id: id, renderer_token: j.renderer });
    return this.status(id);
  }
  private async finish(j: Entry, state: 'completed' | 'failed' | 'cancelled', message?: string, code = 'export_failed') {
    if (j.finishing) return j.finishing;
    j.finishing = (async () => {
      clearTimeout(j.timer);
      j.cancelling = true;
      if (!j.published) await this.deps.native('export_cancel', {});
      await Promise.all([j.staging, j.video, j.audio].filter(Boolean).map(file => fs.rm(file, { force: true })));
      j.view.state = j.published ? 'completed' : state;
      j.view.phase = j.view.state;
      if (message && !j.published) j.view.error = { code, message };
      else delete j.view.error;
      if (this.active === j) { this.active = undefined; this.idleWaiters.forEach(resolve => resolve()); this.idleWaiters.clear(); }
      this.notify(j);
    })().catch(error => {
      j.finishing = undefined;
      j.view.phase = 'cleanup_failed';
      j.view.error = { code: 'cleanup_failed', message: String(error) };
      this.notify(j);
      throw error;
    });
    return j.finishing;
  }
  async rendererGone(token?: string) {
    if (token && this.ready?.token !== token) return;
    this.ready = undefined;
    const j = this.active;
    if (!j) return;
    await this.cancel(j.view.job_id);
    await this.finish(j, 'failed', 'Export renderer disconnected', 'renderer_unavailable');
  }
  async drainForQuit() {
    this.stopping = true;
    const j = this.active;
    if (!j) return;
    const drained = new Promise<void>(resolve => this.idleWaiters.add(resolve));
    try { await this.cancel(j.view.job_id); await drained; }
    catch (error) { this.stopping = false; throw error; }
  }
}
