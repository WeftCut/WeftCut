import { captureStoredMotifFrame, readStoredMotifFrame } from '../../apps/desktop/src/renderer/render/motifs/frameTransport';
import { encodeBitmapToPng } from '../../apps/desktop/src/renderer/render/motifs/pngEncode';
import { MotifBaker } from '../../apps/desktop/src/renderer/render/motifs/MotifBaker';
import { MotifPrewarmer } from '../../apps/desktop/src/renderer/render/motifs/MotifPrewarmer';
import { MotifFrameCache } from '../../apps/desktop/src/renderer/render/motifs/frameCache';

declare global { interface Window { bench: { invoke(name: string, args?: unknown): Promise<any> } } }
type Config = { mode: string; width: number; height: number; fixture: string; frames: number; round: number };
const args = (c: Config, frame: number) => ({
  motifId: 'bake-probe', contentHash: 'bake-probe-v1', tSec: frame / 30,
  propsJson: JSON.stringify({ fixture: c.fixture }), width: c.width, height: c.height,
  fpsNum: 30, fpsDen: 1, settleRafs: 2,
});
async function persist(mode: string, frame: number, bmp: ImageBitmap) {
  let start = performance.now();
  let bytes: Uint8Array;
  if (mode === 'png') {
    const png = await encodeBitmapToPng(bmp);
    bytes = new Uint8Array(await png.arrayBuffer());
  } else {
    // Same one-new-canvas-per-frame policy as production's PNG encoder.
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    bytes = new Uint8Array(rgba.buffer);
  }
  const prepareMs = performance.now() - start;
  start = performance.now();
  const main = await window.bench.invoke('persist', { mode, frame, bytes, width: bmp.width, height: bmp.height });
  return { prepareMs, persistIpcMs: performance.now() - start, transferredBytes: bytes.byteLength, ...main };
}

// One complete real MotifBaker run: disk-check, idle pacing, capture, persist,
// L0 warm, status completion. No scheduling or batch-size optimization.
export async function runBake(c: Config) {
  await window.bench.invoke('begin', c);
  const cache = new MotifFrameCache();
  const timings: Record<number, Record<string, number>> = {};
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const baker = new MotifBaker({
    schedule: cb => requestIdleCallback(cb, { timeout: 200 }), cancel: cancelIdleCallback,
    batchSize: 1,
    isOnDisk: async (_key, frame) => {
      const t = performance.now();
      const has = await window.bench.invoke('has', frame);
      timings[frame] = { hasMs: performance.now() - t, startedAt: t };
      return has;
    },
    persist: async (_key, frame, bmp) => {
      if (c.mode !== 'native') Object.assign(timings[frame], await persist(c.mode, frame, bmp));
    },
    warm: (_key, frame, bmp) => {
      cache.setFrame('bench', frame, bmp);
      timings[frame].frameMs = performance.now() - timings[frame].startedAt;
      delete timings[frame].startedAt;
    },
    onStatus: (_key, status) => {
      if (status.phase === 'ready') resolve();
      if (status.phase === 'error') reject(new Error('Benchmark baker failed'));
    },
  });
  const start = performance.now();
  baker.setTargets([{
    cacheKey: 'bench', contentFrame: 0, contentDurationFrames: c.frames,
    render: async frame => {
      const t = performance.now();
      const bmp = await captureStoredMotifFrame({ ...args(c, frame), benchFrame: frame });
      timings[frame].captureIpcMs = performance.now() - t;
      return bmp;
    },
  }]);
  try { await done; } finally { baker.dispose(); }
  const elapsedMs = performance.now() - start;
  const cachedFrames = cache.size(); cache.dispose();
  return { config: c, elapsedMs, fps: c.frames * 1000 / elapsedMs, cachedFrames,
    timings: Object.values(timings), main: await window.bench.invoke('end') };
}

// Controlled overlap, not a claim about how often a real editing session overlaps.
// Each round launches actual prewarmer + baker and a preview request for one frame.
// Candidate returns OWNED clones so production callers' close/setFrame contracts
// remain intact; a future lease API can avoid those copies.
export async function runReuse(c: Config, reuse: boolean, warmFirst: boolean) {
  await window.bench.invoke('begin', { ...c, mode: 'rgba' });
  const cache = new MotifFrameCache();
  const flights = new Map<string, Promise<ImageBitmap>>();
  let cloneMs = 0, cachedHits = 0, joinedFlights = 0;
  const capture = (frame: number) => captureStoredMotifFrame({ ...args(c, frame), benchFrame: frame });
  const acquire = async (key: string, frame: number) => {
    if (!reuse) return capture(frame);
    let bmp = cache.getFrame(key, frame);
    if (bmp) cachedHits++;
    else {
      const address = JSON.stringify([key, frame]);
      let flight = flights.get(address);
      if (flight) joinedFlights++;
      else {
        flight = capture(frame).then(b => cache.setFrame(key, frame, b));
        flights.set(address, flight);
        // Both success and rejection retire the promise; a failed frame is retryable.
        void flight.then(() => flights.delete(address), () => flights.delete(address));
      }
      bmp = await flight;
    }
    cache.retain(bmp);
    const start = performance.now();
    try { return await createImageBitmap(bmp); }
    finally { cloneMs += performance.now() - start; cache.release(bmp); }
  };
  const perFrame = [];
  for (let f = 0; f < c.frames; f++) {
    const key = `reuse-${f}`; // isolate each one-frame plan; t still changes.
    cache.clearAll();
    if (warmFirst) cache.setFrame(key, f, await capture(f));
    let resolveBake!: () => void, rejectBake!: (error: Error) => void;
    const baked = new Promise<void>((yes, no) => { resolveBake = yes; rejectBake = no; });
    let resolveWarm!: () => void;
    const warmed = new Promise<void>(yes => { resolveWarm = yes; });
    const schedule = (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const baker = new MotifBaker({
      schedule, cancel: clearTimeout, batchSize: 1,
      isOnDisk: async () => false,
      persist: async (_key, _frame, bmp) => { await persist('rgba', f, bmp); },
      warm: (_key, _frame, bmp) => { cache.setFrame(key, f, bmp); },
      onStatus: (_key, s) => { if (s.phase === 'ready') resolveBake(); if (s.phase === 'error') rejectBake(new Error('reuse bake failed')); },
    });
    const prewarmer = new MotifPrewarmer({
      schedule, cancel: clearTimeout, batchSize: 1, capBytes: c.width * c.height * 4,
      hasFrame: () => cache.hasFrame(key, f), prioritizeFrames: () => {},
      setFrame: (_key, _frame, bmp) => { cache.setFrame(key, f, bmp); },
      onProgress: resolveWarm,
    });
    const start = performance.now();
    baker.setTargets([{ cacheKey: key, contentFrame: 0, contentDurationFrames: 1, render: () => acquire(key, f) }]);
    prewarmer.setTargets([{ cacheKey: key, contentFrame: 0, contentDurationFrames: 1,
      frameBytes: c.width * c.height * 4, render: () => acquire(key, f) }]);
    const cached = cache.getFrame(key, f);
    const preview = cached ? Promise.resolve() : acquire(key, f).then(bmp => {
      // This probe only observes the frame, like a consumer retiring after seek.
      bmp.close();
    });
    try { await Promise.all([baked, warmed, preview]); }
    finally { baker.dispose(); prewarmer.dispose(); }
    perFrame.push(performance.now() - start);
  }
  cache.dispose();
  return { reuse, warmFirst, frames: c.frames, perFrame, cloneMs, cachedHits, joinedFlights,
    main: await window.bench.invoke('end') };
}

// Compare what the compositor can actually see, through the production GPU
// disk reader as well as the CPU fallback, including transparent edges.
export async function verifyRendered(reference: string, actual: string, frames: number) {
  const result = [];
  for (const gpu of [true, false]) {
    await window.bench.invoke('readMode', gpu);
    for (const background of ['transparent', '#000000', '#ffffff', '#3279bc']) {
      let channels = 0, alpha = 0, max = 0;
      for (let frame = 0; frame < frames; frame++) {
        const pixels = async (hash: string) => {
          const bmp = (await readStoredMotifFrame(hash, frame))!;
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = canvas.getContext('2d')!;
          if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, bmp.width, bmp.height); }
          ctx.drawImage(bmp, 0, 0); bmp.close();
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const expected = await pixels(reference), got = await pixels(actual);
        for (let i = 0; i < expected.length; i++) {
          const d = Math.abs(expected[i] - got[i]);
          if (d) { channels++; if (i % 4 === 3) alpha++; max = Math.max(max, d); }
        }
      }
      result.push({ gpu, background, channels, alpha, max });
    }
  }
  return result;
}
