import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./helpers/driver";
import type { ModelsView } from "../../src/shared/inference-models";

test("model settings preview one card without automatic downloads", async () => {
  const { app, page } = await launchApp({ locale: "zh-CN" });
  try {
    await page.locator(".startup-settings-toggle").click();
    await page.getByRole("tab", { name: "语音转录" }).click();
    await expect(page.getByRole("combobox", { name: "模型" })).toContainText("Whisper Base");
    await expect(page.locator(".settings-model-card:visible")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "下载并使用", exact: true })).toBeVisible();
    const view = await page.evaluate(() => (window as any).api.backend.invoke("models_list")) as ModelsView;
    expect(view.active).toEqual({ speech: null, vlm: null }); expect(view.operations).toEqual([]);
    await page.getByRole("tab", { name: "视频理解" }).click();
    await expect(page.getByRole("combobox", { name: "模型" })).toContainText("Qwen3-VL-4B");
    fs.mkdirSync("../../.scratch/model-settings/qa", { recursive: true });
    await page.screenshot({ path: "../../.scratch/model-settings/qa/video-default.png" });
    await page.getByRole("button", { name: "高级设置", exact: true }).click();
    await expect(page.getByLabel("采样", { exact: true })).toBeVisible();
    await page.screenshot({ path: "../../.scratch/model-settings/qa/video-advanced.png" });
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

    fail = true;
    await invoke("models_use", { id: active, name: "Rejected model", endpoint: { url, model: "bad-model" } });
    await expect.poll(async () => ((await invoke("models_list")) as ModelsView).operations[0]?.phase).toBe("error");
    const rejected = await invoke("models_list") as ModelsView;
    expect(rejected.active.vlm).toBe(active);
    expect(rejected.models.some(m => m.name === "Rejected model")).toBe(false);
  } finally { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
