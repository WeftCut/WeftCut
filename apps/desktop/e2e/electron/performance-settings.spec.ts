import { expect, test } from "@playwright/test";
import { launchApp, invokeCmd } from "./helpers/driver";
import type { AppSettings } from "../../src/shared/app-settings";
import { PLAYBACK_CALIBRATION, playbackCalibrationRecommendation } from "../../src/shared/playback-calibration";

test("performance controls save on edit, preserve pixel precision and restore defaults", async ({}, testInfo) => {
  const { app, page } = await launchApp({ locale: "zh-CN" });
  try {
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "性能", exact: true }).click();
    const pane = page.locator("#settings-panel-performance");
    await pane.getByRole("button", { name: "高级设置", exact: true }).click();
    const pixels = pane.getByLabel("同时处理的画面总量", { exact: true });
    await expect(pixels).toHaveValue("24.8832");
    await pixels.focus();
    await pixels.press("Tab");
    const read = () => invokeCmd<AppSettings>(page, "app_settings_get");
    expect((await read()).performance?.preview_gpu_pixel_area).toBe(24_883_200);
    await pixels.fill("24.5");
    await expect.poll(async () => (await read()).performance?.preview_gpu_pixel_area).toBe(24_500_000);

    const videos = pane.getByLabel("同时加速的视频数", { exact: true });
    await videos.fill("2");
    await expect.poll(async () => (await read()).performance?.preview_gpu_sessions).toBe(2);
    await expect(videos).toHaveValue("2");
    const inputBox = await videos.boundingBox();
    expect(inputBox!.width).toBeLessThanOrEqual(140);
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("performance-top.png"), animations: "disabled" });

    const reset = pane.getByRole("button", { name: "恢复性能默认值" });
    await reset.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("performance-bottom.png"), animations: "disabled" });
    await reset.click();
    await expect.poll(async () => (await read()).performance?.preview_gpu_pixel_area).toBe(24_883_200);
    await expect(videos).toHaveValue("5");
    await expect(pixels).toHaveValue("24.8832");
  } finally {
    await app.close();
  }
});

test("calibrated preset selection survives reload and preserves advanced cache values", async () => {
  const { app, page } = await launchApp({ locale: "zh-CN" });
  try {
    const profile = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({
      count, status: count <= 5 ? 'pass' : 'slow', reasons: [],
    })))!;
    await invokeCmd(page, 'app_settings_set', { patch: { performance_calibration: profile,
      performance: { ...profile.standard, frame_ring_mib: 700, preview_gpu_pool_slots: 6 } } });
    await page.locator('.startup-settings-toggle').click();
    await page.getByRole('tab', { name: '性能', exact: true }).click();
    const pane = page.locator('#settings-panel-performance');
    await pane.getByRole('radio', { name: /^最大/ }).click();
    const read = () => invokeCmd<AppSettings>(page, 'app_settings_get');
    await expect.poll(async () => (await read()).performance_calibration_tier).toBe('maximum');
    expect((await read()).performance).toMatchObject({ ...profile.maximum, frame_ring_mib: 700, preview_gpu_pool_slots: 6 });
    await page.reload();
    await page.locator('.startup-settings-toggle').click();
    await page.getByRole('tab', { name: '性能', exact: true }).click();
    await expect(pane.getByTestId('performance-preset-status')).toHaveText('当前：最大');
    await pane.getByRole('button', { name: '高级设置', exact: true }).click();
    await pane.getByRole('button', { name: '恢复性能默认值' }).click();
    await expect.poll(async () => (await read()).performance_calibration).toBeNull();
  } finally { await app.close(); }
});

test('experimental calibration starts, cancels and applies only reviewed results @serial @matrix', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'D3D11VA prototype');
  test.setTimeout(360_000);
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    await page.locator('.startup-settings-toggle').click();
    await page.getByRole('tab', { name: '性能', exact: true }).click();
    const pane = page.locator('#settings-panel-performance');
    const read = () => invokeCmd<AppSettings>(page, 'app_settings_get');
    const before = (await read()).performance;
    const status = () => page.evaluate(() => window.api.performanceCalibration.status());
    const start = pane.getByRole('button', { name: '测试此电脑（实验性）', exact: true });
    await start.click();
    await expect.poll(async () => (await status()).report?.state, { timeout: 30_000 }).toBe('running');
    await pane.getByRole('button', { name: '取消测试', exact: true }).click();
    await expect.poll(async () => (await status()).running).toBe(false);
    expect((await status()).report?.state).toBe('cancelled');
    expect((await read()).performance).toEqual(before);
    await start.click();
    await expect.poll(async () => (await status()).running, { timeout: 300_000, intervals: [1000] }).toBe(false);
    const result = (await status()).report;
    await testInfo.attach('calibration-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect((await read()).performance).toEqual(before);
    if (result?.state === 'complete' && result.recommendation) {
      await pane.getByRole('button', { name: '使用测试预设' }).click();
      await expect.poll(async () => (await read()).performance_calibration).toEqual(result.recommendation);
      expect((await read()).performance).toEqual({ ...before, ...result.recommendation.standard });
    } else {
      await expect(pane.getByText('未能获得有效测试结果，设置未更改，可以重试。')).toBeVisible();
      expect(result?.state).toBe('complete'); // unsupported/error hosts are not a validated runtime gate
    }
    await page.screenshot({ path: testInfo.outputPath('performance-calibrated.png') });
  } finally { await page.evaluate(() => window.api.performanceCalibration.cancel()).catch(() => {}); await app.close(); }
});

test("simple presets and advanced edits share persisted values without separate group controls", async ({}, testInfo) => {
  const { app, page } = await launchApp({ locale: "zh-CN" });
  const read = () => invokeCmd<AppSettings>(page, "app_settings_get");
  try {
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "性能", exact: true }).click();
    const pane = page.locator("#settings-panel-performance");
    const status = pane.getByTestId("performance-preset-status");
    const advanced = pane.getByRole("button", { name: "高级设置", exact: true });
    const original = await read();
    await expect(status).toHaveText("当前：最大");
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(pane.getByLabel("视频画面缓存", { exact: true })).not.toBeVisible();
    await advanced.click();
    expect((await read()).performance).toEqual(original.performance);
    await advanced.click();

    await pane.getByRole("radio", { name: /^标准/ }).click();
    await expect.poll(async () => (await read()).performance?.frame_ring_mib).toBe(768);
    await expect(status).toHaveText("当前：标准");
    expect((await read()).playback_resolution).toBe(original.playback_resolution);
    await page.screenshot({ path: testInfo.outputPath("performance-simple.png"), animations: "disabled" });

    await advanced.click();
    const slots = pane.getByLabel("每段视频的显卡缓冲帧数", { exact: true });
    await slots.fill("6");
    await expect.poll(async () => (await read()).performance?.preview_gpu_pool_slots).toBe(6);
    await expect(status).toHaveText("当前：自定义");
    const frames = pane.getByLabel("视频画面缓存", { exact: true });
    await frames.fill("700");
    await expect.poll(async () => (await read()).performance?.frame_ring_mib).toBe(700);
    await expect(pane.getByRole("combobox")).toHaveCount(0);
    await expect(status).toHaveText("当前：自定义");

    await pane.getByRole("radio", { name: /^较少/ }).click();
    await expect.poll(async () => (await read()).performance?.preview_gpu_pool_slots).toBe(3);
    await expect(status).toHaveText("当前：较少");
    expect((await read()).performance?.frame_ring_mib).toBe(512);
    await page.reload();
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "性能", exact: true }).click();
    await expect(status).toHaveText("当前：较少");
    await expect(pane.getByRole("button", { name: "测试此电脑（实验性）", exact: true })).toBeVisible();
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    await app.close();
  }
});
