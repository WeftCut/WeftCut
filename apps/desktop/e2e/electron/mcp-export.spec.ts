import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, dockPanel, importAndPlaceMedia, invokeCmd, newProject, tmpDir, waitForHook } from './helpers/driver';
import { mergeSettings } from '../../src/shared/exportSettings';
import { exportTerminal, type ExportJob } from '../../src/shared/exportJob';

test('MCP manages the shared preset library and exports by preset ID with per-job precedence', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  let client: Client | undefined;
  try {
    const info = await page.evaluate(() => window.api.mcp.getInfo());
    client = new Client({ name: 'preset-export-e2e', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
    }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      return result.structuredContent as Record<string, any>;
    };
    const catalog = await client.listTools();
    expect(catalog.tools.map(t => t.name)).toContain('get_export_options');
    expect(catalog.tools.find(t => t.name === 'start_export')!.inputSchema.properties).toHaveProperty('preset_id');
    expect(catalog.tools.map(t => t.name)).not.toContain('app_settings_set');
    // App-level management works on the start screen, before any project exists.
    const library = await call('list_export_presets');
    expect(library.presets).toHaveLength(4);
    const { preset } = await call('create_export_preset', { name: 'MCP draft', base_preset_id: 'builtin:fullhd',
      settings: { custom_bitrate: 2_000_000, resolution_height: null } });
    await call('update_export_preset', { preset_id: preset.id, default: true });
    await call('create_project', { parent_folder: tmpDir('weftcut-mcp-preset-project-'),
      name: 'Preset export', width: 640, height: 360, fps_num: 30, fps_den: 1 });
    const trackId = await invokeCmd<string>(page, 'add_track', {});
    await invokeCmd(page, 'add_text_layer', { trackId, content: 'Preset export check', tStartUs: 0, durationUs: 500_000 });
    expect((await call('get_export_options')).settings.custom_bitrate).toBe(2_000_000);
    const unsupported = await client.callTool({ name: 'start_export', arguments: { preset_id: 'missing' } });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.structuredContent).toMatchObject({ code: 'invalid_params', error: 'ExportPresetNotFound' });
    // The existing export dropdown sees MCP writes live; there is no extra UI entry point.
    await waitForHook(page, 'exportTimeline');
    await expect(page.locator('.app-main')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByRole('button', { name: 'Preset', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: /^MCP draft/ })).toBeVisible();
    await call('update_export_preset', { preset_id: preset.id, name: 'MCP review' });
    await expect(page.getByRole('menuitemradio', { name: /^MCP review/ })).toBeVisible();
    await call('update_export_preset', { preset_id: preset.id, settings: { audio: { bitrate: 128_000 } } });
    await page.getByRole('menuitemradio', { name: /^MCP review/ }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await call('get_export_options', { preset_id: preset.id })).settings.audio.bitrate).toBe(128_000);
    const output = path.join(tmpDir('weftcut-mcp-preset-output-'), 'preset.mp4');
    const job = await call('start_export', { request_id: 'preset-default', output_path: output,
      settings: { encoder_engine: 'native', hw_accel: 'software', include_audio: false } });
    await expect.poll(async () => (await call('get_export_status', { job_id: job.job_id })).job.state, { timeout: 60_000 }).toBe('completed');
    expect((await call('get_export_status', { job_id: job.job_id })).job.settings.custom_bitrate).toBe(2_000_000);
    expect(statSync(output).size).toBeGreaterThan(100);
    expect(await invokeCmd(page, 'export_settings_get')).toBeNull();
    await invokeCmd(page, 'export_settings_set', { settings: mergeSettings({ quality: 'custom', customBitrate: 3_000_000 }) });
    expect((await call('get_export_options')).settings.custom_bitrate).toBe(3_000_000);
    expect((await call('get_export_options', { preset_id: preset.id })).settings.custom_bitrate).toBe(2_000_000);
    const override = await call('start_export', { request_id: 'preset-override', preset_id: preset.id, output_path: path.join(path.dirname(output), 'override.mp4'),
      settings: { custom_bitrate: 4_000_000, encoder_engine: 'native', hw_accel: 'software', include_audio: false } });
    await expect.poll(async () => (await call('get_export_status', { job_id: override.job_id })).job.state, { timeout: 60_000 }).toBe('completed');
    expect((await call('get_export_status', { job_id: override.job_id })).job.settings.custom_bitrate).toBe(4_000_000);
    expect((await call('get_export_options')).settings.custom_bitrate).toBe(3_000_000);
    const selected = await call('start_export', { request_id: 'preset-selected', preset_id: preset.id,
      output_path: path.join(path.dirname(output), 'selected.mp4'),
      settings: { encoder_engine: 'native', hw_accel: 'software', include_audio: false } });
    await expect.poll(async () => (await call('get_export_status', { job_id: selected.job_id })).job.state, { timeout: 60_000 }).toBe('completed');
    expect((await call('get_export_status', { job_id: selected.job_id })).job.settings.custom_bitrate).toBe(2_000_000);
    await call('delete_export_preset', { preset_id: preset.id });
    expect((await call('list_export_presets')).default_preset_id).toBe('builtin:match');
    expect((await invokeCmd<any>(page, 'export_settings_get')).customBitrate).toBe(3_000_000);
  } finally {
    if (client) {
      const result = await client.callTool({ name: 'get_export_status', arguments: {} }).catch(() => null);
      const job = (result?.structuredContent as { job?: { job_id?: string } | null } | undefined)?.job;
      if (job?.job_id) await client.callTool({ name: 'cancel_export', arguments: { job_id: job.job_id } }).catch(() => {});
      await client.close();
    }
    await app.close();
  }
});

test('MCP export reconnects, reports the actual renamed file, and retries publication through the shared UI', async ({ }, testInfo) => {
  test.setTimeout(180_000);
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  let client: Client | undefined;
  try {
    const info = await page.evaluate(() => window.api.mcp.getInfo());
    const connect = async () => {
      const next = new Client({ name: 'export-e2e', version: '1' }, { capabilities: {} });
      await next.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }));
      return next;
    };
    client = await connect();
    const created = await client.callTool({name:'create_project',arguments:{parent_folder:tmpDir('weftcut-mcp-export-project-'),name:'MCP export',width:640,height:360,fps_num:30,fps_den:1}});
    expect(created.isError,JSON.stringify(created)).toBeFalsy();
    // No UI navigation or readiness wait: a cold MCP-created project must be
    // able to admit an export while the editor initializes.
    const trackId = await invokeCmd<string>(page, 'add_track', {});
    await invokeCmd(page, 'add_text_layer', { trackId, content: 'Shared export', tStartUs: 0, durationUs: 1_000_000 });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      return result.structuredContent as Record<string, any>;
    };
    const output = path.join(tmpDir('weftcut-mcp-export-output-'), 'clip.mp4');
    writeFileSync(output, 'original');
    const options = await call('get_export_options');
    expect(options).not.toHaveProperty('settings_schema');
    const request = { request_id: 'first-export', output_path: output, settings: { encoder_engine: 'native', hw_accel: 'software', include_audio: false } };
    const started = await call('start_export', request);
    expect(started.state).toBe('preparing');
    await client.close(); client = await connect();
    const duplicate = await call('start_export', request);
    expect(duplicate.job_id).toBe(started.job_id);
    await expect.poll(async () => (await call('get_export_status', { job_id: started.job_id })).job.state, { timeout: 120_000 }).toBe('completed');
    const completed = (await call('get_export_status', { job_id: started.job_id })).job;
    expect(completed.output_path).toBe(path.join(path.dirname(output), 'clip (1).mp4'));
    expect(readFileSync(output, 'utf8')).toBe('original');
    expect(statSync(completed.output_path).size).toBeGreaterThan(100);
    await expect(page.locator('.export-progress-panel')).toContainText('clip (1).mp4');
    await testInfo.attach('export-result', { body: JSON.stringify(completed), contentType: 'application/json' });
    // A publication failure retains the completed staged file. UI retry uses
    // the same job and must not open another encoder or rerun the mux.
    await app.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('backend:invokePublished')!;
      const trace = { encodes: 0, muxes: 0, publishes: 0 };
      (globalThis as any).__exportTrace = trace;
      ipcMain._invokeHandlers.set('backend:invokePublished', (event: any, request: any) => {
        if (request.channel === 'export_video_sink_start') trace.encodes++;
        if (request.channel === 'mux_export') trace.muxes++;
        if (request.channel === 'export_job_publish' && ++trace.publishes === 1) throw new Error('Injected publication failure');
        return handler(event, request);
      });
    });
    const second = await call('start_export', { ...request, request_id: 'second-export' });
    await expect.poll(async () => (await call('get_export_status', { job_id: second.job_id })).job.state, { timeout: 120_000 }).toBe('awaiting_retry');
    const refused = await client.callTool({ name: 'add_track', arguments: {} });
    expect(refused.isError).toBe(true);
    // Declining quit must leave the job and application services usable.
    await app.evaluate(({ app, dialog }) => {
      const show = dialog.showMessageBox;
      dialog.showMessageBox = (async () => { dialog.showMessageBox = show; return { response: 0, checkboxChecked: false }; }) as typeof show;
      app.quit();
    });
    expect((await call('get_export_status', { job_id: second.job_id })).job.state).toBe('awaiting_retry');
    await page.locator('.export-progress-panel').getByRole('button', { name: '重试完成导出' }).click();
    await expect.poll(async () => (await call('get_export_status', { job_id: second.job_id })).job.state, { timeout: 30_000 }).toBe('completed');
    expect(await app.evaluate(() => (globalThis as any).__exportTrace)).toEqual({ encodes: 1, muxes: 1, publishes: 2 });
    // A UI job is discoverable and cancellable through MCP. Hold a mux IPC
    // before native entry to prove that cancellation does not release the edit
    // gate while a renderer stage is still outstanding.
    await app.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('backend:invokePublished')!;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      (globalThis as any).__releaseExportMux = release;
      (globalThis as any).__exportMuxHeld = false;
      ipcMain._invokeHandlers.set('backend:invokePublished', async (event: any, request: any) => {
        if (request.channel === 'mux_export') { (globalThis as any).__exportMuxHeld = true; await barrier; }
        return handler(event, request);
      });
    });
    const cancelledOutput = path.join(path.dirname(output), 'cancelled.mp4');
    const ui = await invokeCmd<{ job_id: string }>(page, 'export_job_start', { output_path: cancelledOutput, on_conflict: 'fail' });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__exportMuxHeld), { timeout: 60_000 }).toBe(true);
    expect((await call('get_export_status')).job.job_id).toBe(ui.job_id);
    expect((await call('get_export_status')).job.agent).toBe(false);
    await call('cancel_export', { job_id: ui.job_id });
    expect((await call('get_export_status')).job.phase).toBe('cancelling');
    const whileDraining = await client.callTool({ name: 'add_track', arguments: {} });
    expect(whileDraining.isError).toBe(true);
    await app.evaluate(() => (globalThis as any).__releaseExportMux());
    await expect.poll(async () => (await call('get_export_status', { job_id: ui.job_id })).job.state, { timeout: 30_000 }).toBe('cancelled');
    expect((await client.callTool({ name: 'add_track', arguments: {} })).isError).toBeFalsy();
  } finally {
    await app.evaluate(() => (globalThis as any).__releaseExportMux?.()).catch(() => { });
    if (client) {
      const result = await client.callTool({ name: 'get_export_status', arguments: {} }).catch(() => null);
      const job = (result?.structuredContent as { job?: { job_id?: string } | null } | undefined)?.job;
      if (job?.job_id) await client.callTool({ name: 'cancel_export', arguments: { job_id: job.job_id } }).catch(() => { });
      await client.close();
    }
    await app.close();
  }
});

test('background export keeps review available and preserves output across Preview remounts', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  let jobId: string | undefined;
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-background-export-project-'), name: 'Background export',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    });
    await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'webcodecs' } });
    const mediaDir = process.env.WEFTCUT_TEST_MEDIA ?? fileURLToPath(new URL('../fixtures/media/', import.meta.url));
    const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: path.join(mediaDir, 'test_1080p_30fps_6s.mp4') });
    await waitForHook(page, 'addMotifLayer');
    await page.evaluate(id => window.__weftcutTest!.waitMediaExportReady({ mediaId: id }), mediaId);
    await page.evaluate(() => window.__weftcutTest!.addMotifLayer({
      motifId: 'countdown', durationUs: 2_000_000, props: { seconds: 2 },
    }));

    // A real native encode waits for its first frame acknowledgment. Inject a
    // capacity refusal for editor decoder opens while leaving export leases
    // attached to their admitted plan.
    await app.evaluate(({ ipcMain }) => {
      const write = ipcMain._invokeHandlers.get('export:videosink_write')!;
      const acquire = ipcMain._invokeHandlers.get('resources:acquire')!;
      let barrier: Promise<void> | undefined;
      let release: (() => void) | undefined;
      let frameHeld = false;
      let refusePreview = false;
      Object.assign(globalThis, {
        holdExportFrames: () => { frameHeld = false; barrier = new Promise<void>(resolve => { release = resolve; }); },
        releaseExportFrames: () => { release?.(); barrier = undefined; },
        exportFrameHeld: () => frameHeld,
        refusePreviewResources: () => { refusePreview = true; },
        allowPreviewResources: () => { refusePreview = false; },
      });
      ipcMain._invokeHandlers.set('export:videosink_write', async (event, frame) => {
        if (barrier) { frameHeld = true; await barrier; }
        return write(event, frame);
      });
      ipcMain._invokeHandlers.set('resources:acquire', (event, request) => {
        if (refusePreview && !request.finalizationToken) throw new Error('resource-capacity-exceeded: synthetic preview refusal');
        return acquire(event, request);
      });
    });

    const outDir = tmpDir('weftcut-background-export-output-');
    const baseline = path.join(outDir, 'foreground.mp4');
    const output = path.join(outDir, 'background.mp4');
    const status = () => invokeCmd<ExportJob>(page, 'export_job_status', { job_id: jobId });
    const startHeld = async (output_path: string) => {
      await app.evaluate(() => Reflect.get(globalThis, 'holdExportFrames')());
      const job = await invokeCmd<ExportJob>(page, 'export_job_start', {
        output_path, on_conflict: 'fail',
        settings: mergeSettings({ encoderEngine: 'native', hwAccel: 'software', includeAudio: false }),
      });
      jobId = job.job_id;
      await expect.poll(async () => {
        const active = await status();
        if (active.error) throw new Error(active.error.message);
        return app.evaluate(() => Reflect.get(globalThis, 'exportFrameHeld')());
      }, { timeout: 30_000 }).toBe(true);
    };
    const finish = async (file: string) => {
      await app.evaluate(() => Reflect.get(globalThis, 'releaseExportFrames')());
      await expect.poll(async () => (await status()).state, { timeout: 30_000 }).toBe('completed');
      expect(statSync(file).size).toBeGreaterThan(100);
      await expect(page.getByRole('dialog')).toContainText(path.basename(file));
      await page.getByRole('button', { name: 'Dismiss' }).click();
    };

    await startHeld(baseline);
    await expect(page.getByRole('dialog').locator('.export-progress-status')).toContainText('Encoding');
    await expect(page.getByTestId('preview-suspended')).toHaveText('Exporting');
    await finish(baseline);

    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { preview_during_export: true } } });
    await startHeld(output);
    await expect(page.getByText('Timeline read-only')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const lane = page.getByTestId('track-lane').first();
    const laneIsInert = () => lane.evaluate(el => !!el.closest('[inert]'));
    await expect.poll(laneIsInert).toBe(true);
    await expect(invokeCmd(page, 'add_track', {})).rejects.toThrow(/export is active/i);

    const transport = () => page.evaluate(() => window.__weftcutTest!.audioTransportSnapshot());
    await page.getByTestId('timeline-ruler').click({ position: { x: 40, y: 10 } });
    const scrubbed = (await transport())!.positionUs;
    expect(scrubbed).toBeGreaterThan(0);
    const play = page.getByRole('button', { name: 'Play / pause', exact: true });
    await play.click();
    await expect.poll(async () => (await transport())?.phase).toBe('playing');
    await expect.poll(async () => (await transport())?.positionUs).toBeGreaterThan(scrubbed);
    await expect.poll(() => page.evaluate(() =>
      window.__weftcutTest!.compositorPerfSnapshot()?.sync.videoLateMs ?? null)).not.toBeNull();
    await play.click();
    await expect.poll(async () => (await transport())?.phase).toBe('paused');
    const capture = () => page.screenshot({
      mask: [page.locator('.status-bar-message')], maskColor: '#101418', scale: 'css',
    });
    await testInfo.attach('background-export', { body: await capture(), contentType: 'image/png' });

    const view = page.getByText('View', { exact: true });
    const openPreview = async () => {
      await view.click();
      await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    };
    await openPreview();
    await view.click();
    await page.getByRole('menuitem', { name: 'Close Active Panel', exact: true }).click();
    await expect(dockPanel(page, 'preview')).toHaveCount(0);
    await app.evaluate(() => Reflect.get(globalThis, 'refusePreviewResources')());
    await openPreview();
    await expect(dockPanel(page, 'preview')).toBeVisible();
    const resourceNotice = page.getByText('Preview is waiting for resources while the export runs.');
    await expect(resourceNotice).toBeVisible();
    await testInfo.attach('preview-capacity', { body: await capture(), contentType: 'image/png' });
    expect((await status()).state).toBe('rendering');
    await app.evaluate(() => Reflect.get(globalThis, 'allowPreviewResources')());
    await expect(resourceNotice).toHaveCount(0);
    await finish(output);
    await expect.poll(laneIsInert).toBe(false);
    expect(await invokeCmd(page, 'add_track', {})).toBeTruthy();

    const frameHashes = (file: string) => execFileSync('ffmpeg',
      ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' });
    expect(frameHashes(output)).toBe(frameHashes(baseline));
  } finally {
    try {
      await app.evaluate(() => Reflect.get(globalThis, 'releaseExportFrames')?.());
      if (jobId) {
        const args = { job_id: jobId };
        await invokeCmd(page, 'export_job_cancel', args);
        await expect.poll(async () => exportTerminal((await invokeCmd<ExportJob>(page, 'export_job_status', args)).state)).toBe(true);
      }
    } finally {
      await app.close();
    }
  }
});
