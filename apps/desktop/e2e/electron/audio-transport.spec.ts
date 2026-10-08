import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { importAndPlaceMedia, launchApp, newProject, summary, tmpDir } from './helpers/driver';

// Real conform reads and Web Audio output, deliberately with no Pixi ticks.
// This measures the graph's samples, not physical speaker/driver latency.
test('audio transport starts/stops without presentation and survives closing Preview', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  try {
    const folder = tmpDir('weftcut-audio-transport-');
    const frames = 48_000 * 30;
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(48_000, 24); wav.writeUInt32LE(96_000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 440 / 48_000)), 44 + i * 2);
    const file = path.join(folder, 'tone.wav');
    writeFileSync(file, wav);
    await newProject(page, { parentFolder: folder, name: 'Audio transport', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } });
    const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: file });
    await expect.poll(async () => {
      const s = await summary(page);
      return (s.media.find((m) => m.id === mediaId) as { conform_path?: string } | undefined)?.conform_path ?? null;
    }, { timeout: 60_000 }).not.toBeNull();
    await expect.poll(() => page.evaluate(() => (window as any).__weftcutTest.previewResourceProbe())).not.toBeNull();
    const probe = () => page.evaluate(() => (window as any).__weftcutTest.audioTransportSnapshot());
    await page.evaluate(() => {
      const hook = (window as any).__weftcutTest;
      hook.previewTickerEnabled(false);
      hook.transportSeekUs(0);
      hook.transportPlay();
    });
    await expect.poll(async () => (await probe())?.phase).toBe('playing');
    await expect.poll(async () => (await probe())?.rmsDb ?? -120).toBeGreaterThan(-40);
    const beforePause = await probe();
    const stopped = await page.evaluate(() => {
      const hook = (window as any).__weftcutTest;
      hook.transportPause();
      const state = hook.audioTransportSnapshot();
      // Stop must reach Web Audio BEFORE a subsequent main-thread stall.
      const until = performance.now() + 200;
      while (performance.now() < until) { /* controlled UI load */ }
      return state;
    });
    expect(stopped.phase).toBe('paused');
    expect(stopped.stopCommandMs).toBeLessThan(50);
    await expect.poll(async () => (await probe())?.rmsDb ?? 0).toBeLessThan(-90);
    expect((await probe()).positionUs).toBe(stopped.positionUs);

    // Resume also works with the ticker still stopped.
    await page.evaluate(() => (window as any).__weftcutTest.transportPlay());
    await expect.poll(async () => (await probe())?.rmsDb ?? -120).toBeGreaterThan(-40);

    // A real fetch rejection must remain visible and retriable. The status
    // shares the toolbar's caption typography and does not displace Play.
    await page.evaluate(() => {
      const hook = (window as any).__weftcutTest;
      hook.transportPause();
      const original = window.fetch;
      (window as any).__restoreAudioFetch = () => { window.fetch = original; };
      window.fetch = (input, init) => {
        if (String(input).startsWith('weftcut-media:')) {
          return Promise.reject(new DOMException('Controlled PCM read failure', 'NetworkError'));
        }
        return original(input, init);
      };
      hook.transportSeekUs(12_000_000);
      hook.transportPlay();
    });
    await expect.poll(async () => (await probe()).phase).toBe('error');
    const status = page.locator('.audio-playback-status');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).toHaveText('Audio playback failed');
    await expect(status).toHaveAttribute('title', /Press Play to retry.*\nNetworkError: Controlled PCM read failure/);
    const retry = page.getByRole('button', { name: 'Retry playback', exact: true });
    await expect(retry).toBeEnabled();
    const typography = await page.evaluate(() => ({
      status: getComputedStyle(document.querySelector('.audio-playback-status')!).fontSize,
      meta: getComputedStyle(document.querySelector('.preview-meta')!).fontSize,
      toolbar: document.querySelector('.preview-transport')!.getBoundingClientRect().toJSON(),
      button: document.querySelector('.transport-buttons')!.getBoundingClientRect().toJSON(),
      statusFits: (() => {
        const label = document.querySelector('.audio-playback-status-label')!;
        return label.scrollWidth <= label.clientWidth;
      })(),
    }));
    expect(typography.status).toBe(typography.meta);
    expect(typography.statusFits).toBe(true);
    expect(Math.abs((typography.button.x + typography.button.width / 2) - (typography.toolbar.x + typography.toolbar.width / 2))).toBeLessThan(1);
    await page.locator('.preview-transport').screenshot({ path: testInfo.outputPath('audio-error-toolbar.png') });
    await page.evaluate(() => (window as any).__restoreAudioFetch());
    await retry.click();
    await expect.poll(async () => (await probe()).phase).toBe('playing');
    await expect(status).toHaveCount(0);
    await expect.poll(async () => (await probe()).rmsDb).toBeGreaterThan(-40);

    const viewMenu = page.locator('.menu-trigger').nth(2);
    await viewMenu.click();
    await page.locator('.app-menu-item').filter({ hasText: /^Preview$/ }).click();
    await viewMenu.click();
    await page.locator('.app-menu-item').filter({ hasText: /Close Active Panel|关闭活动面板/ }).click();
    await expect(page.locator('.weft-dock-panel[data-panel-kind="preview"]')).toHaveCount(0);
    const withoutPanel = await probe();
    expect(withoutPanel.phase).toBe('playing');
    expect(withoutPanel.contextTime).toBeGreaterThan(beforePause.contextTime);
    await expect.poll(async () => (await probe()).positionUs).toBeGreaterThan(withoutPanel.positionUs);
    await expect.poll(async () => (await probe()).rmsDb).toBeGreaterThan(-40);
    await page.evaluate(() => (window as any).__weftcutTest.transportPause());
    await expect.poll(async () => (await probe()).rmsDb).toBeLessThan(-90);
    await page.evaluate(() => (window as any).__weftcutTest.transportPlay());
    await expect.poll(async () => (await probe()).phase).toBe('playing');
    await viewMenu.click();
    await page.locator('.app-menu-item').filter({ hasText: /^Preview$/ }).click();
    await expect(page.locator('.weft-dock-panel[data-panel-kind="preview"]')).toHaveCount(1);
    expect((await probe()).phase).toBe('playing');
    await expect.poll(async () => (await probe()).rmsDb).toBeGreaterThan(-40);
  } finally { await app.close(); }
});
