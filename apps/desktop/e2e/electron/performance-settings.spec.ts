import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, invokeCmd } from './helpers/driver';
import type { AppSettings } from '../../src/shared/app-settings';
import { PLAYBACK_CALIBRATION, playbackCalibrationRecommendation } from '../../src/shared/playback-calibration';
import { DEFAULT_RESOURCE_POLICY } from '../../src/shared/resource-policy';

async function openPerformance(page: Page) {
  await page.locator('.startup-settings-toggle').click();
  await page.getByRole('tab', { name: '性能', exact: true }).click();
  const pane = page.locator('#settings-panel-performance');
  await expect(pane.getByLabel('内存使用目标', { exact: true })).toBeEnabled();
  await expect(pane.getByRole('heading', { name: '资源使用详情', exact: true })).toBeVisible();
  await expect(pane.getByTestId('performance-cache-usage')).toBeVisible();
  await expect(pane.getByRole('heading', { name: '本机性能测试（实验性）', exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: '进行基准测试', exact: true })).toBeVisible();
  return pane;
}

test('resource preferences are understandable, persistent and independent of decode quality', async ({}, testInfo) => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    const pane = await openPerformance(page);
    const read = () => invokeCmd<AppSettings>(page, 'app_settings_get');
    const memory = pane.getByLabel('内存使用目标', { exact: true });
    await expect(pane.locator('.settings-performance-value .app-number-input:visible')).toHaveCount(2);
    await expect(pane.getByRole('combobox')).toHaveCount(1);
    await expect(pane.getByLabel('并行解码数', { exact: true })).toHaveCount(0);
    const before = (await read()).decode_engine;
    await memory.fill('4');
    await expect.poll(async () => (await read()).resource_policy?.memory_mib).toBe(4096);
    await expect(memory).toBeFocused();
    await pane.getByRole('combobox', { name: '处理强度', exact: true }).click();
    await expect(page.getByRole('option')).toHaveText(['低占用', '均衡', '高性能']);
    const triggerBounds = await pane.getByRole('combobox', { name: '处理强度', exact: true }).boundingBox();
    const popupBounds = await page.getByRole('listbox').boundingBox();
    expect(triggerBounds).not.toBeNull();
    expect(popupBounds).not.toBeNull();
    expect(Math.abs(popupBounds!.width - triggerBounds!.width)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('processing-options.png'), animations: 'disabled' });
    await page.getByRole('option', { name: '低占用', exact: true }).click();
    await pane.getByLabel('临时缓存空间', { exact: true }).fill('3');
    await pane.getByRole('checkbox', { name: /播放时继续后台处理/ }).check();
    await expect.poll(async () => (await read()).resource_policy).toEqual({
      version: 1, memory_mib: 4096, processing: 'low', disk_cache_mib: 3072, background_playback: true,
    });
    await page.screenshot({ path: testInfo.outputPath('resource-settings.png'), animations: 'disabled' });
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.reload(); await openPerformance(page);
    await expect(memory).toHaveValue('4');
    await expect(pane.getByRole('combobox', { name: '处理强度', exact: true })).toHaveText('低占用');
    expect((await read()).decode_engine).toBe(before);
    await pane.getByRole('button', { name: '恢复默认值', exact: true }).click();
    await expect.poll(async () => (await read()).resource_policy).toEqual(DEFAULT_RESOURCE_POLICY);
    const status = await page.evaluate(() => window.api.resources.status());
    expect(['normal', 'constrained']).toContain(status.pressure);
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).memory_scope).toBe('process-tree');
    expect((await page.evaluate(() => window.api.resources.status())).memory_mib).toBeGreaterThan(0);
  } finally { await app.close(); }
});

test('native resource admission is shared, rejects excess and releases on renderer reload', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    const settings = await invokeCmd<AppSettings>(page, 'app_settings_get');
    const work = settings.resource_allocation!.work_mib;
    const baseline = await page.evaluate(async () => (await window.api.resources.status()).reserved_mib);
    const rejected = await page.evaluate(async memoryMiB => {
      try { await window.api.resources.acquire({ id: 'too-large', memoryMiB, threads: 0 }); return false; }
      catch { return true; }
    }, work + 1);
    expect(rejected).toBe(true);
    await page.evaluate(() => window.api.resources.acquire({ id: 'reload-owned', memoryMiB: 64, threads: 0 }));
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).reserved_mib).toBe(baseline + 64);
    await page.reload();
    await expect.poll(async () => (await page.evaluate(() => window.api.resources.status())).reserved_mib).toBe(baseline);
  } finally { await app.close(); }
});

test('saving a test is separate from applying, restoring defaults retains it, and clearing is explicit', async ({}, testInfo) => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    const read = () => invokeCmd<AppSettings>(page, 'app_settings_get');
    const before = (await read()).performance;
    const profile = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({
      count, status: count <= 5 ? 'pass' : 'slow', reasons: [],
    })))!;
    await invokeCmd(page, 'app_settings_set', { patch: { performance_test_recommendation: profile } });
    expect((await read()).performance).toEqual(before);
    const pane = await openPerformance(page);
    await expect(pane.getByTestId('performance-test-record')).toContainText('通过 5 路');
    await pane.getByRole('button', { name: '应用测试配置', exact: true }).click();
    await expect.poll(async () => (await read()).performance_policy?.decode).toBe('tested');
    expect((await read()).performance?.preview_gpu_sessions).toBe(5);
    expect((await read()).performance?.preview_gpu_pixel_area).toBe(5 * 3840 * 2160);
    const record = (await read()).performance_test_profile;
    await pane.getByRole('button', { name: '恢复默认值', exact: true }).click();
    await expect.poll(async () => (await read()).performance_policy?.decode).toBe('baseline');
    expect((await read()).performance_test_profile).toEqual(record);
    await page.reload();
    await openPerformance(page);
    await expect(pane.getByTestId('performance-test-record')).toContainText('通过 5 路');
    await pane.getByRole('button', { name: '清除测试记录', exact: true }).click();
    await expect.poll(async () => (await read()).performance_test_profile).toBeNull();
    await expect(pane.getByRole('button', { name: '应用测试配置', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('performance-test.png'), animations: 'disabled' });
  } finally { await app.close(); }
});

test('legacy cache values do not become an application memory limit', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    const read = () => invokeCmd<AppSettings>(page, 'app_settings_get');
    await invokeCmd(page, 'app_settings_set', { patch: { performance: { frame_ring_mib: 700, preview_gpu_pool_slots: 6 } } });
    const before = (await read()).performance;
    const pane = await openPerformance(page);
    expect((await read()).performance).toEqual(before);
    await pane.getByLabel('内存使用目标', { exact: true }).fill('4');
    await expect.poll(async () => (await read()).resource_policy?.memory_mib).toBe(4096);
    expect((await read()).performance).toEqual(before);
  } finally { await app.close(); }
});

test('benchmark cancellation and completion never silently modify budgets @serial @matrix', async () => {
  test.skip(process.platform !== 'win32', 'D3D11VA prototype');
  test.setTimeout(960_000);
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    const pane = await openPerformance(page);
    const read = () => invokeCmd<AppSettings>(page, 'app_settings_get');
    // Hosted Windows has 16 GiB RAM: its automatic work allowance is only
    // ~2.2 GiB, below the fixed eight-stream calibration reservation (~4.1 GiB).
    // Explicitly admit this isolated workload; production must still reject
    // it under an insufficient user budget (covered separately below).
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 16384 } } });
    const budgets = async () => {
      const settings = await read();
      return { performance: settings.performance, resource_policy: settings.resource_policy };
    };
    const before = await budgets();
    const status = () => page.evaluate(() => window.api.performanceCalibration.status());
    const cache = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'data', 'cache', 'performance-calibration');
    expect(fs.existsSync(path.join(cache, 'h264-4k60.mp4'))).toBe(false);
    await pane.getByRole('button', { name: '进行基准测试', exact: true }).click();
    await expect.poll(async () => (await status()).running).toBe(true);
    await pane.getByRole('button', { name: '取消测试', exact: true }).click();
    await expect.poll(async () => (await status()).running).toBe(false);
    expect(await budgets()).toEqual(before);
    await pane.getByRole('button', { name: '进行基准测试', exact: true }).click();
    await expect.poll(async () => (await status()).running, { timeout: 900_000, intervals: [1000] }).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(cache, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, codec: 'h264', width: 3840, height: 2160, fps: 60, durationUs: 20_000_000 });
    expect(fs.statSync(path.join(cache, 'h264-4k60.mp4')).size).toBe(manifest.bytes);
    expect(fs.readdirSync(cache).filter(name => name.startsWith('.prepare-'))).toEqual([]);
    expect(await budgets()).toEqual(before);
    const report = (await status()).report;
    if (report?.state === 'complete' && report.recommendation) {
      await pane.getByRole('button', { name: '保存测试建议', exact: true }).click();
      await expect.poll(async () => (await read()).performance_test_profile?.calibration).toEqual(report.recommendation);
      expect(await budgets()).toEqual(before);
    }
  } finally { await page.evaluate(() => window.api.performanceCalibration.cancel()).catch(() => {}); await app.close(); }
});

test('benchmark rejects insufficient capacity without changing resource budgets', async () => {
  test.skip(process.platform !== 'win32', 'D3D11VA prototype');
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: 1024 } } });
    const before = await invokeCmd<AppSettings>(page, 'app_settings_get');
    const error = await page.evaluate(async () => {
      try { await window.api.performanceCalibration.start(); return null; }
      catch (error) { return String(error); }
    });
    expect(error).toContain('resource-capacity-exceeded');
    expect(await page.evaluate(() => window.api.performanceCalibration.status()))
      .toMatchObject({ running: false, report: { state: 'error', recommendation: null } });
    const after = await invokeCmd<AppSettings>(page, 'app_settings_get');
    expect(after.performance).toEqual(before.performance);
    expect(after.resource_policy).toEqual(before.resource_policy);
  } finally { await app.close(); }
});
