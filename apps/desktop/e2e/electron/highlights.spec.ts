import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, rootSummary, driveExport, tmpDir, waitForHook } from './helpers/driver';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const ffmpegPlatform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform as 'darwin' | 'win32' | 'linux'];
const ffmpeg = fileURLToPath(new URL(`../../resources/ffmpeg/${ffmpegPlatform}/ffmpeg${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

async function layer(page: Page, id: string) {
  const s = await rootSummary<any>(page);
  return s.tracks.flatMap((t: any) => t.layers).find((l: any) => l.id === id);
}

async function sample(page: Page, x: number, y: number) {
  return page.evaluate(async ({ x, y }) => {
    const hook = (window as any).__weftcutTest;
    hook.weftcutSeekUs(0);
    return hook.weftcutSampleComposite(x, y);
  }, { x, y });
}

function exportedPixel(video: string, x: number, y: number) {
  const rgb = execFileSync(ffmpeg, ['-v', 'error', '-i', video, '-vf', `crop=2:2:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [...rgb.subarray(0, 3)];
}

test('highlights: picker, MCP, both directions, protected shadows, undo, save/reopen and native export', async () => {
  test.skip(process.env.WEFTCUT_E2E_NO_EXPORT === '1', 'Preview pixel readback and native export require a real GPU; verified locally');
  test.setTimeout(120_000);
  const parent = tmpDir('weftcut-highlights-');
  const png = new PNG({ width: 512, height: 128 });
  const greys = [64, 102, 204, 245];
  for (let y = 0; y < 128; y++) for (let x = 0; x < 512; x++) {
    const i = (y * 512 + x) * 4, value = greys[Math.floor(x / 128)]!;
    png.data[i] = value; png.data[i + 1] = value; png.data[i + 2] = value; png.data[i + 3] = 255;
  }
  const image = path.join(parent, 'tone-chart.png');
  fs.writeFileSync(image, PNG.sync.write(png));
  const { app, page } = await launchApp();
  let client: Client | undefined;
  try {
    await newProject(page, { parentFolder: parent, name: 'Highlights test', canvas: { width: 512, height: 128, fpsNum: 30, fpsDen: 1 } });
    const placed = await importAndPlaceMedia(page, { mediaAbsPath: image });
    await waitForHook(page, 'revealLayer');
    await page.evaluate(id => (window as any).__weftcutTest.revealLayer({ layerId: id }), placed.layerId);
    await page.locator('.weft-dock-tab[data-panel-kind="effect"]').click();
    await page.getByTestId('effect-add').click();
    await page.getByTestId('effect-pick-highlights').click();
    await expect.poll(async () => (await layer(page, placed.layerId)).effects.length).toBe(1);
    await expect(page.getByText('Adjustment strength (%)', { exact: true })).toBeVisible();
    const effectId = (await layer(page, placed.layerId)).effects[0].id;
    const info = await page.evaluate(() => (window as any).api.mcp.getInfo());
    client = new Client({ name: 'highlights-test', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }));
    const addTool = (await client.listTools()).tools.find(t => t.name === 'add_effect')!;
    expect(JSON.stringify(addTool.inputSchema)).toContain('highlights');
    const result = await client.callTool({ name: 'update_effect', arguments: { layer_id: placed.layerId, effect_id: effectId, patch: { params: { amount: { mode: 'Static', value: -40 } } } } });
    expect(result.isError).not.toBe(true);
    await waitForHook(page, 'weftcutSampleComposite');
    await expect.poll(async () => (await sample(page, 320, 64)).r, { timeout: 20_000 }).toBeGreaterThan(130);
    await expect.poll(async () => (await sample(page, 320, 64)).r).toBeLessThan(145);
    expect((await sample(page, 64, 64)).r).toBeCloseTo(64, 0);
    expect((await sample(page, 192, 64)).r).toBeGreaterThan(92);
    expect((await sample(page, 192, 64)).r).toBeLessThan(100);
    const lowered = await sample(page, 320, 64);
    const raised = await client.callTool({ name: 'update_effect', arguments: { layer_id: placed.layerId, effect_id: effectId, patch: { params: { amount: { mode: 'Static', value: 40 } } } } });
    expect(raised.isError).not.toBe(true);
    await expect.poll(async () => (await sample(page, 320, 64)).r).toBeGreaterThan(235);
    await expect.poll(async () => (await sample(page, 320, 64)).r).toBeLessThan(248);
    expect((await sample(page, 64, 64)).r).toBeCloseTo(64, 0);
    const restored = await client.callTool({ name: 'update_effect', arguments: { layer_id: placed.layerId, effect_id: effectId, patch: { params: { amount: { mode: 'Static', value: -40 } } } } });
    expect(restored.isError).not.toBe(true);
    await invokeCmd(page, 'project_undo');
    await expect.poll(async () => (await layer(page, placed.layerId)).effects[0].params.amount).toEqual({ mode: 'Static', value: 40 });
    await invokeCmd(page, 'project_redo');
    await expect.poll(async () => (await layer(page, placed.layerId)).effects[0].params.amount).toEqual({ mode: 'Static', value: -40 });
    await invokeCmd(page, 'project_save');
    await invokeCmd(page, 'project_open', { path: path.join(parent, 'Highlights test') });
    expect((await layer(page, placed.layerId)).effects[0].params.amount).toEqual({ mode: 'Static', value: -40 });
    const video = path.join(parent, 'highlights.mp4');
    const exported = await driveExport(page, { outputAbsPath: video, settings: { encoderEngine: 'native', hwAccel: 'software', includeAudio: false, audio: { include: false } }, range: { startUs: 0, endUs: 1_000_000 } }, { hook: 'exportTimeline', timeout: 90_000 });
    expect(exported.done.ok, exported.done.error).toBe(true);
    expect(Math.abs(exportedPixel(video, 320, 64)[0]! - lowered.r)).toBeLessThanOrEqual(4);
    expect(Math.abs(exportedPixel(video, 64, 64)[0]! - 64)).toBeLessThanOrEqual(3);
    console.log('HIGHLIGHTS_PREVIEW_EXPORT', JSON.stringify({ preview: lowered.r, export: exportedPixel(video, 320, 64)[0], shadow: exportedPixel(video, 64, 64)[0] }));
  } finally { await client?.close(); await app.close(); }
});
