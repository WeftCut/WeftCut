import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { launchApp, newProject, tmpDir, importAndPlaceMedia, invokeCmd, summary, driveExport } from './helpers/driver';

const media = path.resolve(process.env.WEFTCUT_TEST_MEDIA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/media'), 'test_tones_10s.m4a');

test('time remapping: Timing UI, undo, nested audio preparation and export', async () => {
  test.setTimeout(240_000);
  expect(existsSync(media)).toBe(true);
  const folder = tmpDir('weftcut-retime-');
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: folder, name: 'retime', canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 } });
    const { layerId } = await importAndPlaceMedia(page, { mediaAbsPath: media });
    const layer = async () => (await summary(page)).tracks.flatMap(t => t.layers).find(l => l.id === layerId)!;
    const before = await layer();
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId);
    const rate = page.getByRole('textbox', { name: 'Playback rate', exact: true });
    await expect(rate).toBeVisible();
    await rate.fill('2'); await rate.press('Enter');
    await expect.poll(async () => (await layer()).t_end_us).toBe(before.t_start_us + (before.t_end_us - before.t_start_us) / 2);
    await expect(page.getByLabel('Preserve pitch', { exact: true })).toBeChecked();
    await invokeCmd(page, 'project_undo');
    await expect.poll(async () => (await layer()).t_end_us).toBe(before.t_end_us);
    await invokeCmd(page, 'project_redo');
    await expect.poll(async () => (await layer()).t_end_us).toBe(before.t_end_us / 2);
    const group = await invokeCmd(page, 'groups_create', { layerIds: [layerId] }) as { layer_id: string };
    await invokeCmd(page, 'retime_layers', { layerIds: [group.layer_id], target: { kind: 'Rate', value: { num: 1, den: 2 } } });
    const full = await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}));
    let stems: Array<{ path: string; duration_us: number }> = [];
    await expect.poll(async () => {
      const result = await page.evaluate(id => (window as any).api.backend.invoke('prepare_retimed_audio', { compositionId: id }), full.root_id);
      stems = result.stems; return result.waiting;
    }, { timeout: 120_000, intervals: [200, 500, 1000] }).toBe(false);
    expect(stems).toHaveLength(1);
    expect(stems[0].duration_us).toBe(before.t_end_us);
    const pcm = readFileSync(stems[0].path);
    expect(pcm.length).toBeGreaterThan(480_000 * 2 * 4);
    expect(pcm.subarray(100_000, 110_000).some(byte => byte !== 0)).toBe(true);
    await page.evaluate(() => (window as any).__weftcutTest.transportPlay());
    await expect.poll(() => page.evaluate(() => (window as any).__weftcutTest.audioTransportSnapshot()?.phase), { timeout: 30_000 }).toBe('playing');
    await expect.poll(() => page.evaluate(() => (window as any).__weftcutTest.audioTransportSnapshot()?.positionUs ?? 0)).toBeGreaterThan(100_000);
    await page.evaluate(() => (window as any).__weftcutTest.transportPause());
    const childComp = Object.values(full.compositions as Record<string, any>).find((c: any) => c.tracks.some((t: any) => t.layers.some((l: any) => l.id === layerId))) as any;
    const isolated = await page.evaluate(({ compositionId, layerId }) => (window as any).api.backend.invoke('prepare_retimed_audio', { compositionId, layerId }), { compositionId: childComp.id, layerId });
    expect(isolated.waiting).toBe(false);
    expect(isolated.stems[0].duration_us).toBe(before.t_end_us / 2);
    const output = path.join(folder, 'retimed.m4a');
    const result = await driveExport(page, { outputAbsPath: output, settings: { includeVideo: false, includeAudio: true } }, { hook: 'exportTimeline', timeout: 120_000 });
    expect(result.done.ok, JSON.stringify(result)).toBe(true);
    expect(readFileSync(output).length).toBeGreaterThan(10_000);
  } finally { await app.close(); }
});


test('nested video rates produce the same exported frames as the equivalent flat rate', async () => {
  test.setTimeout(240_000);
  const video = path.join(path.dirname(media), 'test_1080p_30fps_6s.mp4');
  const folder = tmpDir('weftcut-retime-video-');
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: folder, name: 'retime-video', canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 } });
    const { layerId } = await importAndPlaceMedia(page, { mediaAbsPath: video });
    const retime = (id: string, num: number, den = 1) => invokeCmd(page, 'retime_layers', { layerIds: [id], target: { kind: 'Rate', value: { num, den } } });
    await retime(layerId, 2);
    const baseline = path.join(folder, 'flat.mp4');
    const nested = path.join(folder, 'nested.mp4');
    const run = async (outputAbsPath: string) => {
      const result = await driveExport(page, { outputAbsPath, settings: { includeVideo: true, includeAudio: false } }, { hook: 'exportTimeline' });
      expect(result.done.ok, JSON.stringify(result)).toBe(true);
    };
    await run(baseline);
    await retime(layerId, 4);
    const group = await invokeCmd<{ layer_id: string }>(page, 'groups_create', { layerIds: [layerId] });
    await retime(group.layer_id, 1, 2);
    await run(nested);
    const { analyze } = await import('../lib/analyze.mjs');
    const report = analyze({ output: nested, source: baseline, samples: [0, 15, 30, 60], ssimMin: 0.995 });
    expect(report.pass, JSON.stringify(report)).toBe(true);
  } finally { await app.close(); }
});
