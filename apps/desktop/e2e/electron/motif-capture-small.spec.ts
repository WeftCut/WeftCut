import { test, expect, type Page } from '@playwright/test';
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver';
import { createMotifDraft, publishMotifDraft } from './helpers/motif';

/// A Motif narrower than the frame marker still captures: the marker wraps
/// over extra rows below the picture, and the frame holds the picture alone
/// (`shared/motifs/frameMarker.ts` §frameMarkerRows).

const SIZES: [number, number][] = [[32, 32], [48, 48], [7, 3], [1, 1]];
const OPAQUE = (tag: string) => `<!doctype html><html><head><style>
  html,body{margin:0;height:100%;background:#e02080}</style></head><body><script>/*${tag}*/
  motif.define({frame(){}});</script></body></html>`;

/// Captures one frame through the preview's frame port: its size and how many
/// of its pixels are the Motif's opaque pink.
async function capture(page: Page, request: Record<string, unknown>): Promise<{ width: number; height: number; pink: number }> {
  return page.evaluate(async request => {
    const w = window as any;
    if (!w.__smallProbe) {
      const channel = new MessageChannel();
      const pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
      channel.port1.onmessage = ({ data }) => {
        const entry = pending.get(data.id); if (!entry) { data.bitmap?.close(); return; }
        pending.delete(data.id);
        if (data.error || !data.bitmap) entry.reject(new Error(data.error ?? 'Missing capture'));
        else entry.resolve(data.bitmap);
      };
      window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2]);
      let next = 0;
      w.__smallProbe = async (c: Record<string, unknown>) => {
        const id = ++next;
        const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          channel.port1.postMessage({ id, capture: { ...c, requestId: id, priority: 'current' } });
        });
        try {
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true })!;
          context.drawImage(bitmap, 0, 0);
          const px = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
          let pink = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i]! > 200 && px[i + 1]! < 60 && px[i + 2]! > 100 && px[i + 3]! >= 250) pink++;
          }
          return { width: bitmap.width, height: bitmap.height, pink };
        } finally { bitmap.close(); }
      };
    }
    return w.__smallProbe(request);
  }, request);
}

for (const backend of ['default', 'bitmap'] as const) {
  test(`a Motif narrower than the frame marker captures whole (${backend} host)`, async () => {
    test.setTimeout(180_000);
    // `default`: shared textures where the platform has them, else bitmaps.
    const { app, page } = await launchApp(backend === 'bitmap' ? { env: { WEFTCUT_MOTIF_CAPTURE: 'bitmap' } } : {});
    try {
      await newProject(page, { parentFolder: tmpDir('weftcut-small-motif-'), name: 'SmallMotif',
        canvas: { width: 640, height: 360, fpsNum: 25, fpsDen: 1 } });
      const results: string[] = [];
      for (const [width, height] of SIZES) {
        const id = `small-${width}x${height}`;
        const motifId = await publishMotifDraft(page, await createMotifDraft(page, {
          id, name: id, version: 1, size: [width, height], default_duration_s: 2, props_schema: {},
        }, OPAQUE(id)));
        const list = await invokeCmd<Array<{ id: string; content_hash?: string }>>(page, 'list_motifs');
        const contentHash = list.find(m => m.id === motifId)!.content_hash!;
        const frame = await capture(page, { motifId, contentHash, tSec: 0, propsJson: '{}', width, height, fpsNum: 25, fpsDen: 1 });
        results.push(`${width}x${height}: ${frame.width}x${frame.height}, ${frame.pink} pink`);
        expect(frame, `${width}x${height}`).toEqual({ width, height, pink: width * height });
      }
      console.log(`[small-motif:${backend}] ${results.join(' | ')}`);
    } finally { await app.close(); }
  });
}
