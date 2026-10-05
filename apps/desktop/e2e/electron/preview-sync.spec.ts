import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importAndPlaceMedia, invokeCmd, launchApp, newProject, summary, tmpDir, DECODE_COMPONENT_PRESENT } from './helpers/driver';

// Real PCM, IPC and render submissions. This deliberately does not claim to
// measure physical screen/speaker latency, or gate machine-dependent p99 speed.
test('preview sync reports output mapping, visible frame intervals and a stalled presentation', async () => {
  test.skip(!DECODE_COMPONENT_PRESENT, 'native-decode component required');
  test.setTimeout(120_000);
  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: 'software' } });
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-sync-'), name: 'Preview sync',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } });
    await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'ffmpeg' } });
    const mediaRoot = process.env.WEFTCUT_TEST_MEDIA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/media');
    const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: path.join(mediaRoot, 'test_1080p_30fps_audio.mp4') });
    await expect.poll(async () => (await summary(page)).media.find((m) => m.id === mediaId)?.conform_path ?? null,
      { timeout: 60_000 }).not.toBeNull();
    const sync = () => page.evaluate(() => window.__weftcutTest!.compositorPerfSnapshot()?.sync ?? null);
    await page.evaluate(() => { window.__weftcutTest!.transportSeekUs(0); window.__weftcutTest!.transportPlay(); });
    await expect.poll(async () => (await sync())?.samples ?? 0).toBeGreaterThan(5);
    await expect.poll(async () => (await sync())?.videoLateMs ?? null).not.toBeNull();
    const before = (await sync())!;
    expect(['output-timestamp', 'latency-estimate', 'render-clock']).toContain(before.clock?.source);
    expect(before.clock!.renderCompUs).toBeGreaterThanOrEqual(before.clock!.outputCompUs!);
    expect(Number.isFinite(before.clockSkewMs)).toBe(true);
    expect(before.missingLayers).toBe(0);
    await page.evaluate(() => {
      const end = performance.now() + 180;
      while (performance.now() < end) { /* controlled renderer stall */ }
    });
    await expect.poll(async () => (await sync())?.submitIntervalMs?.max ?? 0).toBeGreaterThanOrEqual(170);
    await page.evaluate(() => window.__weftcutTest!.transportPause());
    const held = (await sync())!.samples;
    await page.waitForTimeout(100);
    expect((await sync())!.samples).toBe(held);
  } finally { await app.close(); }
});
