import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver';
import { createMotifDraft, publishMotifDraft } from './helpers/motif';

/// The two Windows OSR regressions this guards: an accelerated 2D canvas layer
/// omitted after navigation (pngCanvasRuntime.ts), and a screenshot clip that
/// scaled width alone. The macOS one: the first committed frame of a new
/// document carrying no canvas at all while the host window and the page's
/// emulated size disagreed (capture.ts §setContentSize, ADR 0142). Every
/// capture in the first phase navigates (two Motifs alternate on the one
/// capture host); the second phase repeats one Motif so a blank that is NOT
/// tied to navigation would show up as well.
const NETWORK_PROPS = {
  accent: '#D2261C', count: 70, cue_detail_s: 11.4, cue_link_s: 3.6,
  cue_pattern_s: 14.8, cue_release_s: 12.2, cue_signal_s: 10.9,
  cue_spread_s: 7.2, detail: 'synapse', duration_s: 17.5, exit: 'fade',
  ground: 'paper', ink: '#16130F', kind: 'neuron', paper: '#F2ECDF', seed: 7, step_fps: 0,
};
const MAX_DUMPS = 8;

test('PNG capture preserves canvas pixels across Motif navigation', async ({}, testInfo) => {
  test.setTimeout(240_000);
  // Exercise the real fallback backend even on a machine with shared textures.
  // Without this, a successful GPU run never tests PNG canvas compositing.
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: 'png' } });
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-png-capture-'), name: 'Capture',
      canvas: { width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 } });
    // Frame i is captured at tSec = 2 + i/25; the solid canvas paints green =
    // (i * 5) % 256 so a capture can tell "previous frame" from "no frame".
    const draft = await createMotifDraft(page, {
      id: 'capture-solid', name: 'Capture solid', version: 1,
      size: [1920, 1080], default_duration_s: 20, props_schema: {},
    }, `<!doctype html><html><body style="margin:0;background:transparent">
      <canvas id="c" width="1920" height="1080"></canvas><script>
      motif.define({frame(t){const c=document.getElementById('c').getContext('2d');
        const i=Math.round((t-2)*25);const g=(i*5)%256;
        c.fillStyle='rgb(224,'+g+',128)';c.fillRect(0,0,1920,1080);}});
      </script></body></html>`);
    const solid = await publishMotifDraft(page, draft);
    // Pin the canvas that reproduced the OSR failure without depending on the
    // harness branch's built-in Motif catalog or future design changes.
    const networkDraft = await createMotifDraft(page, {
      id: 'capture-network', name: 'Capture network', version: 1,
      size: [1920, 1080], default_duration_s: 20, props_schema: {},
    }, readFileSync(new URL('./fixtures/png-capture-network.html', import.meta.url), 'utf8'));
    const networkId = await publishMotifDraft(page, networkDraft);
    // Phase 1 alternates the two Motifs (48 navigations); phase 2 repeats the
    // solid one (24 captures on one document).
    const plan = [
      ...Array.from({ length: 48 }, (_, i) => ({ i, network: i % 2 === 0 })),
      ...Array.from({ length: 24 }, (_, k) => ({ i: 48 + k, network: false })),
    ];
    const result = await page.evaluate(async ({ solid, networkId, plan, networkProps, maxDumps }) => {
      const channel = new MessageChannel();
      const pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
      channel.port1.onmessage = ({ data }) => {
        const request = pending.get(data.id)!; pending.delete(data.id);
        if (data.error || !data.bitmap) request.reject(new Error(data.error ?? 'Missing capture'));
        else request.resolve(data.bitmap);
      };
      window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2]);
      const context = new OffscreenCanvas(3, 1).getContext('2d', { willReadFrequently: true })!;
      const missing: number[] = [];
      const details: { i: number; kind: string; expectedG: number; size: string; rgba: number[]; ms: number }[] = [];
      const dumps: { i: number; png: string }[] = [];
      const toBase64 = async (bitmap: ImageBitmap) => {
        const full = new OffscreenCanvas(bitmap.width, bitmap.height);
        full.getContext('2d')!.drawImage(bitmap, 0, 0);
        const bytes = new Uint8Array(await (await full.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let binary = '';
        for (let k = 0; k < bytes.length; k += 0x8000) binary += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
        return btoa(binary);
      };
      try {
        for (const { i, network } of plan) {
          const started = performance.now();
          const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
            pending.set(i, { resolve, reject });
            channel.port1.postMessage({ id: i, capture: {
              motifId: network ? networkId : solid, tSec: 2 + i / 25,
              propsJson: JSON.stringify(network ? networkProps : {}), width: 1920, height: 1080,
              settleRafs: 1, contentHash: '', fpsNum: 25, fpsDen: 1, high: true,
            } });
          });
          const ms = Math.round(performance.now() - started);
          try {
            context.clearRect(0, 0, 3, 1);
            context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, 3, 1);
            const pixels = context.getImageData(0, 0, 3, 1).data;
            const expectedG = network ? -1 : (i * 5) % 256;
            const sizeBad = bitmap.width !== 1920 || bitmap.height !== 1080;
            const alphaBad = [3, 7, 11].some(index => pixels[index]! < 250);
            // A solid frame whose green is off by more than 2 holds some other
            // frame's pixels (stale compositor output), not a blank.
            const colourBad = !network && [1, 5, 9].some(index => Math.abs(pixels[index]! - expectedG) > 2);
            if (sizeBad || alphaBad || colourBad) {
              missing.push(i);
              details.push({ i, kind: network ? 'network' : 'solid', expectedG,
                size: `${bitmap.width}x${bitmap.height}`, rgba: Array.from(pixels), ms });
              if (dumps.length < maxDumps) dumps.push({ i, png: await toBase64(bitmap) });
            }
          } finally { bitmap.close(); }
        }
      } finally { channel.port1.close(); }
      return { missing, details, dumps };
    }, { solid, networkId, plan, networkProps: NETWORK_PROPS, maxDumps: MAX_DUMPS });
    for (const { i, png } of result.dumps) {
      const file = testInfo.outputPath(`png-capture-frame-${i}.png`);
      writeFileSync(file, Buffer.from(png, 'base64'));
      await testInfo.attach(`frame-${i}`, { path: file, contentType: 'image/png' });
    }
    const diagnostics = await invokeCmd<{ pngCaptures: number; pageLoads: number }>(page, 'motif_capture_diagnostics');
    console.log(`[png-capture] ${result.missing.length ? 'MISSES' : 'all frames opaque'}; host pngCaptures=${diagnostics.pngCaptures} pageLoads=${diagnostics.pageLoads}`);
    expect(result.missing, 'opaque authored canvases must survive the PNG capture backend\n' + JSON.stringify(result.details, null, 1)).toEqual([]);
  } finally { await app.close(); }
});
