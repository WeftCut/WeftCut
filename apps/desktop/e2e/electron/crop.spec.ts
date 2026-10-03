import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, summary, driveExport, tmpDir, waitForHook } from './helpers/driver';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ffmpeg = process.env.FFMPEG ?? path.join(desktop, 'resources/ffmpeg', process.platform === 'win32' ? 'win/ffmpeg.exe' : process.platform === 'darwin' ? 'mac/ffmpeg' : 'linux/ffmpeg');
async function sample(page: Page, x: number, y: number) {
  return page.evaluate(async ({ x, y }) => {
    const hook = (window as any).__weftcutTest;
    hook.weftcutSeekUs(0);
    return hook.weftcutSampleComposite(x, y) as Promise<{ r: number; g: number; b: number; a: number }>;
  }, { x, y });
}

// Screenshot the already-presented canvas, without the sample hook's forced
// composite: this catches a draft that only repaints after mouse release.
async function redPixels(page: Page): Promise<number> {
  // Cropped CDP screenshots can release native pointer capture on Windows.
  // Capture the untouched viewport and count only the preview's pixels.
  const viewport = await page.evaluate(() => {
    const r = document.querySelector('.pixi-preview-canvas')!.getBoundingClientRect();
    return { width: innerWidth, x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const png = await page.screenshot();
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png, maxBuffer: 16 * 1024 * 1024 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  let count = 0;
  const width = png.readUInt32BE(16), ratio = width / viewport.width;
  for (let y = Math.ceil(viewport.y * ratio); y < (viewport.y + viewport.h) * ratio; y++) {
    for (let x = Math.ceil(viewport.x * ratio); x < (viewport.x + viewport.w) * ratio; x++) {
      const i = (y * width + x) * 3;
      if (decoded.stdout[i]! > 200 && decoded.stdout[i + 1]! < 40 && decoded.stdout[i + 2]! < 40) count++;
    }
  }
  const fit = Math.min(viewport.w / 320, viewport.h / 180) * ratio;
  return count / (fit * fit);
}

test('crop: Quick Panel, context menu, drag/cancel, snapping and exported pixels @serial', async ({}, info) => {
  test.setTimeout(180_000);
  const folder = tmpDir('weftcut-crop-'), media = path.join(folder, 'red.mp4');
  const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  const { app, page } = await launchApp();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || /Could not initialize shader|Fragment shader is not compiled/.test(m.text())) errors.push(m.text()); });
  try {
    await newProject(page, { parentFolder: folder, name: 'crop', canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 } });
    const { layerId } = await importAndPlaceMedia(page, { mediaAbsPath: media });
    await waitForHook(page, 'weftcutSampleComposite');
    await expect.poll(() => page.evaluate(() => !!(window as any).__weftcutTest.previewResourceProbe()), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await sample(page, 160, 90)).r, { timeout: 20_000 }).toBeGreaterThan(200);
    const patch = (p: Record<string, unknown>) => invokeCmd(page, 'update_layer_params', { layerId, patch: { kind: 'VideoClip', ...p } });
    const stored = async () => (await summary(page)).tracks.flatMap(t => t.layers).find(l => l.id === layerId)!.params as any;
    const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.8 };
    await patch({ crop });
    await expect.poll(async () => (await sample(page, 20, 90)).r).toBeLessThan(10);
    await expect.poll(async () => (await sample(page, 160, 90)).r).toBeGreaterThan(200);
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId);
    await expect(page.locator('.prop-section[aria-label="Crop"]')).toHaveCount(0);
    const cropTool = page.locator('[data-quick-action="editCrop"]');
    await expect(cropTool).toBeEnabled();
    await invokeCmd(page, 'app_settings_set', { patch: { preview_effects_enabled: false } });
    await expect.poll(async () => (await sample(page, 20, 90)).r).toBeLessThan(10);
    await invokeCmd(page, 'app_settings_set', { patch: { preview_effects_enabled: true } });
    await cropTool.click();
    await expect(cropTool).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-quick-action="selectTool"]')).toHaveAttribute('aria-checked', 'false');
    const overlay = page.getByTestId('crop-overlay');
    await expect(overlay).toBeVisible();
    const handle = overlay.locator('[data-crop-handle="w"]');
    await expect(handle).toHaveCSS('cursor', 'ew-resize');
    await expect(overlay.locator('[data-crop-edge="n"]')).toHaveCSS('cursor', 'ns-resize');
    await expect(overlay.locator('[data-crop-handle="nw"]')).toHaveCSS('cursor', 'nwse-resize');
    const beforeDrag = await redPixels(page);
    await handle.hover();
    const h = await handle.boundingBox();
    if (!h) throw new Error('no crop handle');
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 25, h.y + h.height / 2, { steps: 5 });
    await expect.poll(() => redPixels(page)).toBeLessThan(beforeDrag * 0.99);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => redPixels(page)).toBeGreaterThan(beforeDrag * 0.99);
    expect((await stored()).crop).toEqual(crop);
    await handle.hover();
    const restored = await handle.boundingBox();
    if (!restored) throw new Error('no restored crop handle');
    await page.mouse.move(restored.x + restored.width / 2, restored.y + restored.height / 2);
    await page.mouse.down();
    await page.mouse.move(restored.x + restored.width / 2 + 25, restored.y + restored.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await stored()).crop.x).toBeGreaterThan(0.25);
    const params = await stored();
    expect(params.scale_x).toEqual({ mode: 'Static', value: 1 });
    expect(params.x).toEqual({ mode: 'Static', value: 0 });
    await invokeCmd(page, 'project_undo', {});
    await expect.poll(async () => (await stored()).crop).toEqual(crop);
    await page.screenshot({ path: info.outputPath('crop-controls.png') });
    await page.keyboard.press('Enter');
    await expect(overlay).toHaveCount(0);
    await expect(cropTool).toHaveAttribute('aria-checked', 'false');
    await cropTool.click();
    await page.locator('[data-quick-action="selectTool"]').click();
    await expect(overlay).toHaveCount(0);

    // The normal transform box and its snap use the visible rectangle.
    const box = page.getByTestId('transform-gizmo-box');
    const boxInComp = () => page.evaluate(() => {
      const canvas = document.querySelector('.pixi-preview-canvas')!.getBoundingClientRect();
      const rect = document.querySelector('[data-testid="transform-gizmo-box"]')!.getBoundingClientRect();
      const scale = Math.min(canvas.width / 320, canvas.height / 180);
      return { x: (rect.left - canvas.left - (canvas.width - 320 * scale) / 2) / scale,
        y: (rect.top - canvas.top - (canvas.height - 180 * scale) / 2) / scale,
        w: rect.width / scale, h: rect.height / scale, scale };
    });
    await expect.poll(async () => Math.round((await boxInComp()).w)).toBe(160);
    expect((await boxInComp()).x).toBeCloseTo(80, 2);
    expect((await boxInComp()).h).toBeCloseTo(144, 2);
    await invokeCmd(page, 'app_settings_set', { patch: { preview_snap_enabled: true, preview_snap_strength_px: 12 } });
    const bounds = await box.boundingBox();
    if (!bounds) throw new Error('no transform box');
    const grab = { x: bounds.x + bounds.width * 0.3, y: bounds.y + bounds.height * 0.7 };
    await page.mouse.move(grab.x, grab.y); await page.mouse.down();
    await page.mouse.move(grab.x - 78 * (await boxInComp()).scale, grab.y, { steps: 5 });
    // A vertical SVG line has zero layout width; Playwright's visibility
    // predicate calls that hidden even when its stroke is being painted.
    await expect(page.getByTestId('transform-gizmo-guide-x')).not.toHaveCSS('display', 'none');
    await page.mouse.up();
    await expect.poll(async () => (await stored()).x.value).toBe(-80);
    await expect.poll(async () => Math.round((await boxInComp()).x)).toBe(0);
    await invokeCmd(page, 'project_undo', {});
    await expect.poll(async () => (await stored()).x.value).toBe(0);

    // Asymmetric source crop mirrors WITH the content, around the same pivot.
    await patch({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, flip_h: true });
    await expect.poll(async () => (await sample(page, 40, 90)).r).toBeGreaterThan(200);
    await expect.poll(async () => (await sample(page, 280, 90)).r).toBeLessThan(10);
    await expect.poll(async () => Math.round((await boxInComp()).x)).toBe(0);
    await expect.poll(async () => Math.round((await boxInComp()).w)).toBe(160);
    await patch({ flip_h: false, rotation_deg: 90 });
    await expect.poll(async () => (await sample(page, 160, 140)).r).toBeGreaterThan(200);
    await expect.poll(async () => (await sample(page, 160, 40)).r).toBeLessThan(10);
    await expect.poll(async () => Math.round((await boxInComp()).y)).toBe(90);
    await page.locator('.preview-video').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Crop in preview', exact: true }).click();
    await expect(overlay.locator('[data-crop-handle="w"]')).toHaveCSS('cursor', 'ns-resize');
    await cropTool.click();

    await patch({ rotation_deg: 0 });
    await page.locator('.preview-video').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset crop', exact: true }).click();
    await expect.poll(async () => (await stored()).crop).toBeNull();
    await expect.poll(async () => (await sample(page, 20, 90)).r).toBeGreaterThan(200);
    await page.locator(`.timeline-layer[data-layer-id="${layerId}"]`).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Reset crop', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('menuitem', { name: 'Crop in preview', exact: true }).click();
    await expect(overlay).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await patch({ rotation_deg: 0, crop });
    await expect.poll(async () => (await sample(page, 160, 90)).r).toBeGreaterThan(200);
    const out = path.join(folder, 'cropped.mp4');
    const result = await driveExport(page, { outputAbsPath: out }, { hook: 'exportTimeline', timeout: 120_000 });
    expect(result.done.ok, JSON.stringify(result)).toBe(true);
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
    expect(decoded.status, decoded.stderr.toString()).toBe(0);
    expect(decoded.stdout.length).toBe(320 * 180 * 3);
    expect(decoded.stdout[(90 * 320 + 20) * 3]).toBeLessThan(15);
    expect(decoded.stdout[(90 * 320 + 160) * 3]).toBeGreaterThan(200);
    expect(decoded.stdout[(90 * 320 + 300) * 3]).toBeLessThan(15);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
