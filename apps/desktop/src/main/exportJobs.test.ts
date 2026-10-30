import { exportPresetValues, type ExportPresetPreferences } from '../shared/export-presets';
import { mergeSettings } from '../shared/exportSettings';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportJobs, exportBasename, exportPathExists, suggestExportName } from './exportJobs';
import { blankProject, rootComposition } from './state/model';
import type { TsActorHost } from './state/ts-actor-host';
import type { ExportRun } from '../shared/exportJob';

const cleanup: string[] = [];
it('suggests an unused numbered name without creating or replacing any file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weftcut-export-name-'));
  cleanup.push(dir);
  for (const name of ['clip.mp4', 'clip (1).mp4', 'clip (2).mp4', 'clip (3).mov']) {
    await fs.writeFile(path.join(dir, name), 'existing output');
  }
  expect(await suggestExportName(path.join(dir, 'clip.mp4'))).toBe('clip (3)');
  expect(await exportPathExists(path.join(dir, 'clip (3).mp4'))).toBe(false);
  expect(await fs.readFile(path.join(dir, 'clip.mp4'), 'utf8')).toBe('existing output');
});
it('distinguishes absent output files from filesystem failures during filename checks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weftcut-filename-check-'));
  cleanup.push(dir);
  const output = path.join(dir, 'clip.mp4');
  expect(await exportPathExists(output)).toBe(false);
  await fs.writeFile(output, 'existing output');
  expect(await exportPathExists(output)).toBe(true);
  for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
    const error = Object.assign(new Error('Cannot read output entry'), { code });
    const stat = vi.spyOn(fs, 'lstat').mockRejectedValueOnce(error);
    try { await expect(exportPathExists(output)).rejects.toBe(error); }
    finally { stat.mockRestore(); }
  }
});
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function setup(exportPreferences?: () => ExportPresetPreferences, telemetry?: ConstructorParameters<typeof ExportJobs>[0]['telemetry']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weftcut-export-test-')); cleanup.push(dir);
  const project = blankProject(() => crypto.randomUUID(), 'Project');
  rootComposition(project).duration_us = 1_000_000;
  let opened = { dir } as { dir: string } | null;
  const host = { actor: { snapshot: () => project }, openedProject: () => opened, handleInvoke: async () => null } as unknown as TsActorHost;
  const send = vi.fn();
  const native = vi.fn(async (channel: string, args: Record<string, unknown>): Promise<unknown> => {
    if (channel === 'export_prepare_output') { const p = path.join(dir, '.staged.mp4'); await fs.writeFile(p, ''); return p; }
    if (channel === 'export_publish_output') { await fs.writeFile(String(args.output), 'complete'); return args.output; }
    return null;
  });
  const jobs = new ExportJobs({ host: () => host, send, native, readyTimeoutMs: 40, exportPreferences, telemetry });
  const ready = () => jobs.rendererReady('renderer', project.root_id);
  const run = () => send.mock.calls.find(([event]) => event === 'export:run')![1] as ExportRun;
  return { jobs, dir, project, send, native, ready, run, close: () => { opened = null; } };
}

it('reserves before awaits, deduplicates before busy/default resolution and retains terminal records', async () => {
  const s = await setup(); s.ready();
  const a = s.jobs.start({ request_id: 'one' }), b = s.jobs.start({ request_id: 'one' });
  await expect(s.jobs.start({ request_id: 'two' })).rejects.toMatchObject({ code: 'export_busy' });
  const job = await a; expect(await b).toEqual(job);
  expect(s.native.mock.calls.filter(([c]) => c === 'export_begin')).toHaveLength(1);
  await expect(s.jobs.start({ request_id: 'one', settings: { codec: 'hevc' } })).rejects.toMatchObject({ code: 'request_id_conflict' });
  const actual = await s.jobs.publish(job.job_id, 'renderer');
  await s.jobs.update(job.job_id, 'renderer', { state: 'completed' });
  s.close();
  expect((await s.jobs.start({ request_id: 'one' })).output_path).toBe(actual);
  expect(s.jobs.status()).toBeNull();
});

it('waits for the matching renderer and rejects stale ownership', async () => {
  const s = await setup(); const job = await s.jobs.start({});
  expect(job.phase).toBe('waiting_for_renderer'); expect(s.send.mock.calls.some(([c]) => c === 'export:run')).toBe(false);
  expect(() => s.jobs.rendererReady('bad', 'different')).toThrow('another project');
  s.ready(); expect(s.run().job_id).toBe(job.job_id);
  await s.jobs.update(job.job_id, 'renderer', { state: 'finalizing', phase: 'mux' });
  expect(s.jobs.status(job.job_id)).toMatchObject({ phase: 'mux', can_cancel: true, can_retry: false });
  await expect(s.jobs.publish(job.job_id, 'bad')).rejects.toMatchObject({ code: 'stale_renderer' });
  await s.jobs.cancel(job.job_id); await s.jobs.update(job.job_id, 'renderer', { state: 'cancelled' });
});

it('keeps admission during cancellation until the renderer acknowledges cleanup', async () => {
  const s = await setup(); s.ready(); const job = await s.jobs.start({});
  await s.jobs.cancel(job.job_id); expect(s.jobs.isActive()).toBe(true);
  expect(() => s.jobs.assertWritable()).toThrow('export');
  await s.jobs.update(job.job_id, 'renderer', { state: 'cancelled' });
  expect(s.jobs.isActive()).toBe(false);
  expect(await s.jobs.cancel(job.job_id)).toMatchObject({ state: 'cancelled' });
});

it('retains files for finalization retry and removes overwrite approval for a new filename', async () => {
  const s = await setup(); s.ready(); const job = await s.jobs.start({ on_conflict: 'overwrite' }, false);
  await fs.writeFile(s.run().staging_path, 'encoded');
  await s.jobs.update(job.job_id, 'renderer', { state: 'awaiting_retry', error: { code: 'io', message: 'disk full' } });
  expect(s.jobs.status(job.job_id)?.can_retry).toBe(true);
  await expect(s.jobs.retry(job.job_id, '../other.mp4')).rejects.toThrow('basename');
  await s.jobs.retry(job.job_id, 'different.mp4');
  expect(await fs.readFile(s.run().staging_path, 'utf8')).toBe('encoded');
  await s.jobs.publish(job.job_id, 'renderer');
  expect(s.native.mock.calls.find(([c]) => c === 'export_publish_output')![1]).toMatchObject({ policy: 'fail', output: path.join(s.dir, 'output', 'different.mp4') });
  await s.jobs.update(job.job_id, 'renderer', { state: 'completed' });
});

it('reports completion when publication wins a cancellation race', async () => {
  const s = await setup(); s.ready(); const job = await s.jobs.start({});
  await s.jobs.publish(job.job_id, 'renderer'); await s.jobs.cancel(job.job_id);
  await s.jobs.update(job.job_id, 'renderer', { state: 'cancelled' });
  expect(s.jobs.status(job.job_id)?.state).toBe('completed');
});

it('times out waiting for initialization without retaining the edit lock', async () => {
  const s = await setup(); const job = await s.jobs.start({});
  await vi.waitFor(() => expect(s.jobs.status(job.job_id)?.state).toBe('failed'));
  expect(s.jobs.isActive()).toBe(false);
});

it('rejects strict conflicts before starting native encoding and never changes defaults', async () => {
  const s = await setup(); const output = path.join(s.dir, 'exists.mp4'); await fs.writeFile(output, 'original');
  const job = await s.jobs.start({ output_path: output, on_conflict: 'fail', settings: { include_audio: false } });
  expect(job).toMatchObject({ state: 'failed', error: { code: 'output_conflict' }, can_retry: false, can_cancel: false }); expect(await fs.readFile(output, 'utf8')).toBe('original');
  expect(s.native.mock.calls.some(([c]) => c === 'export_begin')).toBe(false);
});

it('does not accept a completion acknowledgement without publication', async () => {
  const s = await setup(); s.ready(); const job = await s.jobs.start({});
  await expect(s.jobs.update(job.job_id, 'renderer', { state: 'completed' })).rejects.toMatchObject({ code: 'invalid_state' });
  await s.jobs.rendererGone(); expect(s.jobs.status(job.job_id)?.state).toBe('failed');
});

it('shares a measured encoding ETA with UI and reconnecting MCP clients, then clears it for finalization', async () => {
  const s = await setup(); s.ready();
  let now = 100_000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const job = await s.jobs.start({ request_id: 'timed-export' });
    expect(s.jobs.status(job.job_id)?.render_elapsed_ms).toBeUndefined();
    await s.jobs.update(job.job_id, 'renderer', { state: 'rendering', progress: 0 });
    expect(s.jobs.status(job.job_id)?.estimated_remaining_ms).toBeNull();
    now += 10_000;
    await s.jobs.update(job.job_id, 'renderer', { state: 'rendering', progress: 0.25 });
    expect(s.jobs.status(job.job_id)).toMatchObject({ render_elapsed_ms: 10_000, estimated_remaining_ms: 30_000 });
    expect((await s.jobs.start({ request_id: 'timed-export' })).estimated_remaining_ms).toBe(30_000);
    expect(s.send.mock.calls.filter(([event]) => event === 'export:status').at(-1)?.[1]).toMatchObject({ estimated_remaining_ms: 30_000 });
    now += 30_000;
    expect(s.jobs.status(job.job_id)?.estimated_remaining_ms).toBeNull();
    await s.jobs.update(job.job_id, 'renderer', { state: 'finalizing', phase: 'mux' });
    expect(s.jobs.status(job.job_id)?.estimated_remaining_ms).toBeUndefined();
    await s.jobs.publish(job.job_id, 'renderer');
    await s.jobs.update(job.job_id, 'renderer', { state: 'completed' });
    expect(s.jobs.status(job.job_id)?.render_elapsed_ms).toBeUndefined();
    const next = await s.jobs.start({});
    await s.jobs.update(next.job_id, 'renderer', { state: 'rendering', progress: 0 });
    expect(s.jobs.status(next.job_id)).toMatchObject({ render_elapsed_ms: 0, estimated_remaining_ms: null });
    await s.jobs.cancel(next.job_id);
    expect(s.jobs.status(next.job_id)?.estimated_remaining_ms).toBeUndefined();
    await s.jobs.update(next.job_id, 'renderer', { state: 'cancelled' });
  } finally { clock.mockRestore(); }
});

it('samples telemetry at most every three seconds and hides it after rendering', async () => {
  const telemetry = vi.fn(async () => ({ encoder: 'h264_nvenc', device: 'gpu' as const, utilization_percent: 0 }));
  const s = await setup(undefined, telemetry);s.ready();
  let now = 100_000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const job = await s.jobs.start({});
    await s.jobs.update(job.job_id, 'renderer', { state: 'rendering', progress: 0 });
    expect(telemetry).toHaveBeenCalledOnce();
    expect(telemetry).toHaveBeenCalledWith(s.run().encoded_video_path);
    expect(s.jobs.status(job.job_id)?.encoder_load).toMatchObject({ device: 'gpu', utilization_percent: 0 });
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    now += 2_000;
    await s.jobs.update(job.job_id, 'renderer', { state: 'rendering', progress: 0.1 });
    expect(telemetry).toHaveBeenCalledOnce();
    now += 1_001;
    await s.jobs.update(job.job_id, 'renderer', { state: 'rendering', progress: 0.2 });
    expect(telemetry).toHaveBeenCalledTimes(2);
    now += 10_000;
    expect(s.jobs.status(job.job_id)?.encoder_load?.utilization_percent).toBeNull();
    await s.jobs.update(job.job_id, 'renderer', { state: 'finalizing', phase: 'mux' });
    expect(s.jobs.status(job.job_id)?.encoder_load).toBeUndefined();
    await s.jobs.cancel(job.job_id);await s.jobs.update(job.job_id, 'renderer', { state: 'cancelled' });
  } finally { clock.mockRestore(); }
});

it('a restart admission gate blocks new export without cancelling an existing one', async () => {
  const s = await setup();s.ready();
  const job = await s.jobs.start({});
  expect(() => s.jobs.holdForRestart()).toThrow('An export is active');
  expect(s.jobs.status(job.job_id)?.state).toBe('preparing');
  await s.jobs.cancel(job.job_id);await s.jobs.update(job.job_id, 'renderer', { state: 'cancelled' });
  const release = s.jobs.holdForRestart();
  await expect(s.jobs.start({})).rejects.toMatchObject({ code: 'app_closing' });
  release();
  const next = await s.jobs.start({});
  await s.jobs.cancel(next.job_id);await s.jobs.update(next.job_id, 'renderer', { state: 'cancelled' });
});

it('sanitizes portable default filenames', () => {
  expect(exportBasename('CON')).toBe('weftcut-export');
  expect(exportBasename('clip/one:two. ')).toBe('clip_one_two');
});

it('allows a previously busy request id to be admitted after the active job drains', async () => {
  const s = await setup(); s.ready(); const first = await s.jobs.start({});
  await expect(s.jobs.start({ request_id: 'later' })).rejects.toMatchObject({ code: 'export_busy' });
  await s.jobs.rendererGone(); s.ready();
  const next = await s.jobs.start({ request_id: 'later' });
  expect(next.job_id).not.toBe(first.job_id); expect(next.state).toBe('preparing');
  await s.jobs.rendererGone();
});

it('rejects internal camelCase at the MCP boundary and reports the default path without creating it', async () => {
  const s = await setup();
  await expect(s.jobs.start({ settings: { includeAudio: false } })).rejects.toThrow('snake_case');
  expect(await s.jobs.options()).toMatchObject({ default_output_path: path.join(s.dir, 'output', 'Project.mp4') });
  await expect(fs.stat(path.join(s.dir, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleans encoded streams owned by a crashed renderer before releasing admission', async () => {
  const s = await setup(); s.ready(); const job = await s.jobs.start({});
  const { encoded_video_path, encoded_audio_path } = s.run();
  await fs.writeFile(encoded_video_path, 'partial video'); await fs.writeFile(encoded_audio_path, 'partial audio');
  await s.jobs.rendererGone();
  expect(s.jobs.status(job.job_id)).toMatchObject({ state: 'failed', error: { code: 'renderer_unavailable' } });
  await expect(fs.stat(encoded_video_path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(encoded_audio_path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(s.jobs.isActive()).toBe(false);
});

it('uses the personal default for MCP options while keeping saved project settings first', async () => {
  const project = blankProject(() => crypto.randomUUID(), 'Preset project');
  Object.assign(rootComposition(project), { width: 1920, height: 1080, duration_us: 1_000_000 });
  const preset = { id: 'personal', name: 'Review', version: 1 as const, values: exportPresetValues(mergeSettings({ quality: 'custom', customBitrate: 7_000_000 })) };
  let saved: unknown = null;
  const host = { actor: { snapshot: () => project }, openedProject: () => ({ dir: 'C:/project' }), handleInvoke: async () => saved } as unknown as TsActorHost;
  const jobs = new ExportJobs({ host: () => host, send: vi.fn(), native: vi.fn(), exportPreferences: () => ({ export_presets: [preset], default_export_preset_id: preset.id }) });
  expect(await jobs.options()).toMatchObject({ settings: { custom_bitrate: 7_000_000 } });
  saved = mergeSettings({ quality: 'custom', customBitrate: 3_000_000, hwAccel: 'software', decodeEngine: 'ffmpeg' });
  expect(await jobs.options()).toMatchObject({ settings: { custom_bitrate: 3_000_000 } });
  expect(await jobs.options(preset.id)).toMatchObject({ settings: { custom_bitrate: 7_000_000, hw_accel: 'software', decode_engine: 'ffmpeg' } });
  expect(await jobs.options('builtin:hd')).toMatchObject({ settings: { resolution_height: 720, custom_bitrate: 5_000_000 } });
  expect(saved).toMatchObject({ customBitrate: 3_000_000 });
  await expect(jobs.options('missing')).rejects.toMatchObject({ code: 'not_found' });
  await expect(jobs.options(null)).rejects.toMatchObject({ code: 'invalid_params' });
});

it('snapshots a selected preset before awaits and replays the job after that preset is deleted', async () => {
  const preset = { id: 'personal', name: 'Review', version: 1 as const, values: exportPresetValues(mergeSettings({ quality: 'custom', customBitrate: 7_000_000 })) };
  const prefs: ExportPresetPreferences = { export_presets: [preset] };
  const s = await setup(() => prefs); s.ready();
  await expect(s.jobs.start({ preset_id: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(s.jobs.start({ preset_id: null })).rejects.toMatchObject({ code: 'invalid_params' });
  expect(s.jobs.isActive()).toBe(false);
  expect(s.native).not.toHaveBeenCalled();
  const request = { preset_id: preset.id, request_id: 'selected', settings: { include_audio: false } };
  const admitted = s.jobs.start(request);
  preset.values.customBitrate = 1_000_000;
  prefs.export_presets = [];
  const job = await admitted;
  expect(job.settings.customBitrate).toBe(7_000_000);
  await s.jobs.publish(job.job_id, 'renderer');
  await s.jobs.update(job.job_id, 'renderer', { state: 'completed' });
  expect(await s.jobs.start(request)).toMatchObject({ job_id: job.job_id, state: 'completed', settings: { customBitrate: 7_000_000 } });
  await expect(s.jobs.start({ ...request, preset_id: 'builtin:hd' })).rejects.toMatchObject({ code: 'request_id_conflict' });
});
