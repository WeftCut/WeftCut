import { expect, test } from "@playwright/test";
import { launchApp, invokeCmd } from "./helpers/driver";
import type { AppSettings } from "../../src/shared/app-settings";

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

test("simple presets, independent controls and advanced edits share persisted values", async ({}, testInfo) => {
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
    const cache = pane.getByRole("combobox", { name: "缓存用量", exact: true });
    await expect(cache).toContainText("自定义");

    const parallel = pane.getByRole("combobox", { name: "同时处理的画面数量", exact: true });
    await parallel.click();
    await page.getByRole("option", { name: "较少", exact: true }).click();
    await expect.poll(async () => (await read()).performance?.preview_gpu_sessions).toBe(2);
    expect((await read()).performance?.frame_ring_mib).toBe(700);
    expect((await read()).performance?.preview_gpu_pool_slots).toBe(6);
    await cache.click();
    await page.getByRole("option", { name: "最大", exact: true }).click();
    await expect.poll(async () => (await read()).performance?.frame_ring_mib).toBe(1024);
    expect((await read()).performance?.preview_gpu_sessions).toBe(2);
    expect((await read()).performance?.preview_gpu_pool_slots).toBe(6);
    await expect(status).toHaveText("当前：自定义");

    await pane.getByRole("radio", { name: /^较少/ }).click();
    await expect.poll(async () => (await read()).performance?.preview_gpu_pool_slots).toBe(3);
    await expect(status).toHaveText("当前：较少");
    expect((await read()).performance?.frame_ring_mib).toBe(512);
    await page.reload();
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "性能", exact: true }).click();
    await expect(status).toHaveText("当前：较少");
    await expect(pane.getByRole("combobox", { name: "缓存用量", exact: true })).toContainText("较少");
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    await app.close();
  }
});
