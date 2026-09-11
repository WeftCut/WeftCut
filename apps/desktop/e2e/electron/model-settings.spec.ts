import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./helpers/driver";
import type { ModelsView } from "../../src/shared/inference-models";

test("model setup stays inline and the add dialog blocks the settings behind it", async () => {
  const { app, page } = await launchApp({ locale: "zh-CN" });
  try {
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "语音转录" }).click();
    await expect(page.getByRole("button", { name: "当前模型", exact: true })).toContainText("未选择");
    await expect(page.getByText("将音视频中的语音转为文字", { exact: false })).toBeVisible();
    await expect(page.locator(".settings-model-summary:visible")).toContainText("尚未选择模型");
    await expect(page.getByRole("button", { name: "下载并使用", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "视频理解" }).click();
    await expect(page.getByLabel("采样", { exact: true })).toBeVisible();
    fs.mkdirSync("../../.scratch/model-settings/qa", { recursive: true });
    await page.screenshot({ animations: "disabled", path: "../../.scratch/model-settings/qa/video-default.png" });
    await page.getByRole("button", { name: "当前模型", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "未选择", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ animations: "disabled", path: "../../.scratch/model-settings/qa/video-picker.png" });
    await page.getByRole("menuitemradio", { name: /在线模型/ }).click();
    await expect(page.getByRole("textbox", { name: "地址", exact: true })).toBeVisible();
    await expect(page.locator(".settings-model-summary:visible")).toContainText("尚未选择模型");
    await page.screenshot({ animations: "disabled", path: "../../.scratch/model-settings/qa/video-configure.png" });
    await expect(page.locator(".settings-model-dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "当前模型", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "模型库…" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "添加自定义模型…" }).click();
    const modal = page.locator(".settings-model-dialog");
    await expect(modal).toBeVisible();
    await expect(page.locator('[data-slot="dialog-overlay"]:visible')).toHaveCount(2);
    const behind = page.locator('#settings-tab-speech');
    await expect(behind).toBeVisible();
    // The probe point has to be over the tab AND inside the viewport, so it is
    // the centre of the two boxes' INTERSECTION rather than of the tab alone.
    // `document.elementFromPoint` answers null for a coordinate outside the
    // viewport, and a tab whose centre sits there is the whole of how this
    // read `Expected "dialog-overlay" / Received null` on macos-latest while
    // passing on the other two runners. The visible extent comes back with the
    // point so a tab that is genuinely off-screen reports as that, in numbers,
    // instead of as a null nobody can place.
    const probe = await behind.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      const right = Math.min(r.right, window.innerWidth);
      const bottom = Math.min(r.bottom, window.innerHeight);
      return {
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        visibleWidth: right - left,
        visibleHeight: bottom - top,
        tab: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    const where = JSON.stringify({ tab: probe.tab, viewport: probe.viewport });
    expect(probe.visibleWidth, `the speech tab is off-screen horizontally: ${where}`).toBeGreaterThan(0);
    expect(probe.visibleHeight, `the speech tab is off-screen vertically: ${where}`).toBeGreaterThan(0);
    const point = { x: probe.x, y: probe.y };
    expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.getAttribute('data-slot'), point)).toBe('dialog-overlay');
    await page.mouse.click(point.x, point.y);
    await expect(modal).toBeVisible();
    await expect(page.locator('#settings-tab-vlm')).toHaveAttribute('aria-selected', 'true');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await modal.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.screenshot({ animations: "disabled", path: "../../.scratch/model-settings/qa/video-add-overlay.png" });
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.settings-panel--nav')).toBeVisible();
    const view = await page.evaluate(() => (window as any).api.backend.invoke("models_list")) as ModelsView;
    expect(view.active).toEqual({ speech: null, vlm: null }); expect(view.operations).toEqual([]);
    expect(view.models.every(m => !m.downloadedBytes)).toBe(true);
  } finally { await app.close(); }
});

test("online model activation verifies the candidate and preserves the current model on failure", async () => {
  let fail = false;
  let requests = 0;
  let sawSyntheticImage = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests++;
      sawSyntheticImage ||= body.includes("data:image/png;base64,");
      res.writeHead(fail ? 401 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fail ? { error: { message: "test rejection" } } : { choices: [{ message: { content: '[{"t_start":0,"t_end":1,"text":"A blue image","tags":["blue"]}]' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const { app, page } = await launchApp();
  const invoke = (channel: string, args: unknown = {}) => page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [channel, args] as const);
  try {
    await invoke("models_use", { id: "vlm-online", name: "Local test service", endpoint: { url, model: "test-vision" } });
    await expect.poll(async () => ((await invoke("models_list")) as ModelsView).active.vlm).toMatch(/^custom-/);
    const ready = await invoke("models_list") as ModelsView;
    const active = ready.active.vlm!;
    expect(ready.models.find(m => m.id === active)?.verified).toBe(true);
    expect(requests).toBe(1); expect(sawSyntheticImage).toBe(true);
    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, "model_settings.json"), "utf8"));
    expect(persisted.active.vlm).toBe(active);

    // A configured model is activated directly from the picker, without an
    // additional Use button. Both services are local synthetic test endpoints.
    await invoke("models_use", { id: "vlm-online", name: "Second test service", endpoint: { url, model: "second-vision" } });
    await expect.poll(async () => ((await invoke("models_list")) as ModelsView).active.vlm).not.toBe(active);
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "Video understanding", exact: true }).click();
    await expect(page.getByRole("button", { name: "Current model", exact: true })).toContainText("Second test service");
    await page.getByRole("button", { name: "Current model", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Local test service/ }).click();
    await expect.poll(async () => ((await invoke("models_list")) as ModelsView).active.vlm).toBe(active);
    await expect(page.getByRole("button", { name: "Current model", exact: true })).toContainText("Local test service");
    await expect(page.getByRole("button", { name: "Use", exact: true })).toHaveCount(0);

    fail = true;
    await page.getByRole("button", { name: "Current model", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add custom model…" }).click();
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.getByRole("textbox", { name: "Custom model name", exact: true }).fill("Rejected model");
    await page.getByRole("textbox", { name: "URL", exact: true }).fill(url);
    await page.getByRole("textbox", { name: "Model", exact: true }).fill("bad-model");
    await page.getByRole("button", { name: "Add and use", exact: true }).click();
    await expect.poll(async () => ((await invoke("models_list")) as ModelsView).operations[0]?.phase).toBe("error");
    const rejected = await invoke("models_list") as ModelsView;
    expect(rejected.active.vlm).toBe(active);
    expect(rejected.models.some(m => m.name === "Rejected model")).toBe(false);
    await expect(page.locator(".settings-model-summary:visible")).toContainText("Local test service");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("button", { name: "Current model", exact: true })).toContainText("Rejected model");
    await expect(page.getByRole("textbox", { name: "Custom model name", exact: true })).toHaveCount(0);

    // Editing stays inside the active model card and saves the same profile.
    const selected = ((await invoke("models_list")) as ModelsView).active.vlm!;
    const card = page.locator('.settings-model-summary:visible');
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.locator('.settings-model-dialog')).toHaveCount(0);
    await card.getByRole("textbox", { name: "Model", exact: true }).fill("edited-current");
    await card.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(card.getByRole("textbox", { name: "Model", exact: true })).toHaveCount(0);
    const saved = await invoke("models_list") as ModelsView;
    expect(saved.active.vlm).toBe(selected);
    expect(saved.models.find(m => m.id === selected)?.endpoint?.model).toBe("edited-current");
    expect(saved.models).toHaveLength(8);
    await card.getByRole("button", { name: "Remove custom entry" }).click();
    await expect(page.getByText("This model is currently selected. After removal, the selection will be None.")).toBeVisible();
    await page.getByRole("button", { name: "Confirm removal" }).click();
    await expect(page.locator(".settings-model-summary:visible")).toContainText("No model selected");
    expect(((await invoke("models_list")) as ModelsView).active.vlm).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(userData, "model_settings.json"), "utf8")).active.vlm).toBeNull();
  } finally { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("model card clears managed downloads while keeping user files and profiles", async () => {
  const { app, page } = await launchApp();
  const invoke = (channel: string, args: unknown = {}) => page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [channel, args] as const);
  try {
    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    const artifact = path.join(userData, "data", "downloads", "whisper-model-base");
    const partial = path.join(userData, "data", "cache", "content-partial", "whisper-model-base.part");
    const userFile = path.join(userData, "user-model.bin");
    fs.mkdirSync(artifact, { recursive: true }); fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(path.join(artifact, "download-test.bin"), "downloaded bytes");
    fs.writeFileSync(partial, "partial bytes"); fs.writeFileSync(userFile, "user-owned bytes");
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "Transcription", exact: true }).click();
    await page.getByRole("button", { name: "Current model", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Whisper Base/ }).click();
    await page.locator(".settings-model-candidate").getByRole("button", { name: "Clear downloads" }).click();
    expect(fs.existsSync(artifact)).toBe(true);
    await page.getByRole("button", { name: "Confirm removal" }).click();
    await expect.poll(() => fs.existsSync(artifact)).toBe(false);
    expect(fs.existsSync(partial)).toBe(false); expect(fs.readFileSync(userFile, "utf8")).toBe("user-owned bytes");
    const view = await invoke("models_list") as ModelsView;
    expect(view.models.find(m => m.id === "whisper-base")?.downloadedBytes).toBe(0);
    expect(view.active.speech).toBeNull(); expect(view.operations).toEqual([]);
    await expect(page.getByRole("button", { name: "Clear downloads" })).toHaveCount(0);
  } finally { await app.close(); }
});
