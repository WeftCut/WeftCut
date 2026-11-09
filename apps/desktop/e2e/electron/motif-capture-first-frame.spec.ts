import { test, expect, type Page } from '@playwright/test';
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver';
import { createMotifDraft, publishMotifDraft } from './helpers/motif';

/// The first frame a new capture host renders, for Motifs that draw only into
/// canvases: a new window's first commit can carry the frame id with every
/// canvas missing, and that commit never fills in
/// (docs/notes/electron-chromium-behavior.md#a-new-capture-windows-first-commits-can-omit-its-canvases).
/// Each Motif here is its own content version, so each first capture opens a
/// host; one frame at a time keeps the frame alone in its host's pipeline,
/// where a later frame cannot cover the miss.

const MOTIFS = 8;
const CANVAS_2D = (tag: string) => `<!doctype html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="1920" height="1080"></canvas><script>/*${tag}*/
  motif.define({frame(){ const c=document.getElementById('c').getContext('2d');
    c.fillStyle='#e02080'; c.fillRect(0,0,1920,1080); }});
  </script></body></html>`;
const CANVAS_WEBGL = (tag: string) => `<!doctype html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="1920" height="1080"></canvas><script>/*${tag}*/
  motif.define({frame(){ const gl=document.getElementById('c').getContext('webgl2')||document.getElementById('c').getContext('webgl');
    gl.clearColor(0.88,0.13,0.5,1); gl.clear(gl.COLOR_BUFFER_BIT); }});
  </script></body></html>`;

/// Captures one frame through the preview's frame port; the share of pixels a
/// 64×36 downscale finds opaque.
async function opaqueShare(page: Page, capture: Record<string, unknown>): Promise<number> {
  return page.evaluate(async capture => {
    const w = window as any;
    if (!w.__firstFrameProbe) {
      const channel = new MessageChannel();
      const pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
      channel.port1.onmessage = ({ data }) => {
        const request = pending.get(data.id); if (!request) { data.bitmap?.close(); return; }
        pending.delete(data.id);
        if (data.error || !data.bitmap) request.reject(new Error(data.error ?? 'Missing capture'));
        else request.resolve(data.bitmap);
      };
      window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2]);
      let next = 0;
      const context = new OffscreenCanvas(64, 36).getContext('2d', { willReadFrequently: true })!;
      w.__firstFrameProbe = async (c: Record<string, unknown>) => {
        const id = ++next;
        const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          channel.port1.postMessage({ id, capture: { ...c, requestId: id, priority: 'current' } });
        });
        try {
          context.clearRect(0, 0, 64, 36);
          context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, 64, 36);
          const px = context.getImageData(0, 0, 64, 36).data;
          let opaque = 0;
          for (let i = 3; i < px.length; i += 4) if (px[i]! >= 250) opaque++;
          return opaque / (64 * 36);
        } finally { bitmap.close(); }
      };
    }
    return w.__firstFrameProbe(capture);
  }, capture);
}

for (const backend of ['default', 'bitmap'] as const) {
  test(`a new capture host's first frame holds the Motif's canvases (${backend} host)`, async () => {
    test.setTimeout(240_000);
    // `default`: shared textures where the platform has them, else bitmaps.
    const { app, page } = await launchApp(backend === 'bitmap' ? { env: { WEFTCUT_MOTIF_CAPTURE: 'bitmap' } } : {});
    try {
      await newProject(page, { parentFolder: tmpDir('weftcut-first-frame-'), name: 'FirstFrame',
        canvas: { width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 } });
      const lanes: { motifId: string; contentHash: string; kind: string }[] = [];
      for (let i = 0; i < MOTIFS; i++) {
        const kind = i % 4 === 3 ? 'webgl' : '2d';
        const id = `first-frame-${kind}-${i}`;
        const motifId = await publishMotifDraft(page, await createMotifDraft(page, {
          id, name: id, version: 1, size: [1920, 1080], default_duration_s: 20, props_schema: {},
        }, kind === 'webgl' ? CANVAS_WEBGL(id) : CANVAS_2D(id)));
        const list = await invokeCmd<Array<{ id: string; content_hash?: string }>>(page, 'list_motifs');
        lanes.push({ motifId, contentHash: list.find(m => m.id === motifId)!.content_hash!, kind });
      }
      const misses: string[] = [];
      for (const lane of lanes) {
        const share = await opaqueShare(page, { motifId: lane.motifId, contentHash: lane.contentHash, tSec: 0,
          propsJson: '{}', width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 });
        if (share < 0.99) misses.push(`${lane.motifId}: ${(share * 100).toFixed(0)}% opaque`);
      }
      const diagnostics = await invokeCmd<{ hostBuilds: number; skippedFrames: number; textureCaptures: number; bitmapCaptures: number }>(page, 'motif_capture_diagnostics');
      console.log(`[first-frame:${backend}] ${diagnostics.hostBuilds} host builds, ${diagnostics.skippedFrames} skipped, ${diagnostics.textureCaptures} texture / ${diagnostics.bitmapCaptures} bitmap captures`);
      expect(diagnostics.hostBuilds, 'each Motif opened its own host').toBeGreaterThanOrEqual(MOTIFS);
      expect(misses, 'a first frame on a new host must hold its canvases').toEqual([]);
    } finally { await app.close(); }
  });
}
