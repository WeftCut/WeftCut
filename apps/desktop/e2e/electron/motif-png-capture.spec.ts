import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launchApp, newProject, tmpDir } from './helpers/driver';
import { createMotifDraft, publishMotifDraft } from './helpers/motif';

test('PNG capture preserves canvas pixels across Motif navigation', async () => {
  test.setTimeout(180_000);
  // Exercise the real fallback backend even on a machine with shared textures.
  // Without this, a successful GPU run never tests PNG canvas compositing.
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_CAPTURE: 'png' } });
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-png-capture-'), name: 'Capture',
      canvas: { width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 } });
    const draft = await createMotifDraft(page, {
      id: 'capture-solid', name: 'Capture solid', version: 1,
      size: [1920, 1080], default_duration_s: 20, props_schema: {},
    }, `<!doctype html><html><body style="margin:0;background:transparent">
      <canvas id="c" width="1920" height="1080"></canvas><script>
      motif.define({frame(){const c=document.getElementById('c').getContext('2d');
        c.fillStyle='#e02080';c.fillRect(0,0,1920,1080);}});
      </script></body></html>`);
    const solid = await publishMotifDraft(page, draft);
    // Pin the canvas that reproduced the OSR failure without depending on the
    // harness branch's built-in Motif catalog or future design changes.
    const networkDraft = await createMotifDraft(page, {
      id: 'capture-network', name: 'Capture network', version: 1,
      size: [1920, 1080], default_duration_s: 20, props_schema: {},
    }, readFileSync(new URL('./fixtures/png-capture-network.html', import.meta.url), 'utf8'));
    const networkId = await publishMotifDraft(page, networkDraft);
    const missing = await page.evaluate(async ({ solid, networkId }) => {
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
      try {
        for (let i = 0; i < 48; i++) {
          const network = i % 2 === 0;
          const props = network ? {
            accent: '#D2261C', count: 70, cue_detail_s: 11.4, cue_link_s: 3.6,
            cue_pattern_s: 14.8, cue_release_s: 12.2, cue_signal_s: 10.9,
            cue_spread_s: 7.2, detail: 'synapse', duration_s: 17.5, exit: 'fade',
            ground: 'paper', ink: '#16130F', kind: 'neuron', paper: '#F2ECDF', seed: 7, step_fps: 0,
          } : {};
          const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
            pending.set(i, { resolve, reject });
            channel.port1.postMessage({ id: i, capture: {
              motifId: network ? networkId : solid, tSec: 2 + i / 25,
              propsJson: JSON.stringify(props), width: 1920, height: 1080,
              settleRafs: 1, contentHash: '', fpsNum: 25, fpsDen: 1, high: true,
            } });
          });
          try {
            context.clearRect(0, 0, 3, 1);
            context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, 3, 1);
            const pixels = context.getImageData(0, 0, 3, 1).data;
            if (bitmap.width !== 1920 || bitmap.height !== 1080 ||
              [3, 7, 11].some(index => pixels[index]! < 250)) missing.push(i);
          } finally { bitmap.close(); }
        }
      } finally { channel.port1.close(); }
      return missing;
    }, { solid, networkId });
    expect(missing, 'opaque authored canvases must survive the PNG capture backend').toEqual([]);
  } finally { await app.close(); }
});
