import { describe, expect, it, vi } from "vitest";
import { MotifPrewarmer, type PrewarmContentSpec } from "./MotifPrewarmer";
import { MotifFrameCache } from "./frameCache";

function makeBmp(): ImageBitmap { return { close() {} } as unknown as ImageBitmap; }
type Rendered = Awaited<ReturnType<PrewarmContentSpec['render']>>;
/** A stored frame read at full size. */
const rendered = (bitmap: ImageBitmap): Rendered => ({ bitmap, scaleDiv: 1 });

describe("MotifPrewarmer", () => {
  it("bounds subscription metadata even when tiny long Motifs fit in the pixel budget", () => {
    let scheduled!: () => void;
    const cancelRequest = vi.fn();
    const render = vi.fn(() => new Promise<Rendered>(() => {}));
    const prewarmer = new MotifPrewarmer({
      capBytes: 512 * 1024 * 1024, hasFrame: () => false, setFrame: () => {},
      prioritizeFrames: () => {}, schedule: cb => { scheduled = cb; return 1; },
      cancel: () => {}, cancelRequest,
    });
    prewarmer.setTargets(['a', 'b'].map(cacheKey => ({
      cacheKey, contentFrame: 0, contentDurationFrames: 1_000_000, frameBytes: 4, render,
    })));
    scheduled();
    expect(render).toHaveBeenCalledTimes(256);
    prewarmer.dispose();
    expect(cancelRequest).toHaveBeenCalledTimes(256);
  });
  it("does not refill with an already in-flight frame after replanning", async () => {
    const pending: (() => void)[] = [];
    const releases = new Map<number, (bitmap: ImageBitmap) => void>();
    const cached = new Set<number>();
    const render = vi.fn((frame: number) => new Promise<Rendered>(resolve => releases.set(frame, bitmap => resolve(rendered(bitmap)))));
    const prewarmer = new MotifPrewarmer({
      capBytes: 3, hasFrame: (_k, f) => cached.has(f),
      setFrame: (_k, f) => { cached.add(f); }, prioritizeFrames: () => {},
      schedule: cb => { pending.push(cb); return pending.length; }, cancel: () => {},
      cancelRequest: vi.fn(),
    });
    const specs = [{ cacheKey: "animation", contentFrame: 0, contentDurationFrames: 64, frameBytes: 1, render }];
    prewarmer.setTargets(specs);
    pending.shift()!(); // frames 0, 1, 2
    prewarmer.setTargets(specs); // compositor replans while those reads run
    releases.get(1)!(makeBmp());
    await new Promise(r => setTimeout(r, 0));
    expect(pending).toHaveLength(0);
    prewarmer.setTargets([{ ...specs[0]!, contentFrame: 1 }]);
    pending.shift()!();
    expect(render.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2, 3]);
    prewarmer.dispose();
    releases.forEach(resolve => resolve(makeBmp()));
  });

  it("rasters missing targets in plan order, skips cached, stops when done", async () => {
    const cached = new Set<string>();
    const setSpy = vi.fn((k: string, f: number) => cached.add(`${k}#${f}`));
    const renderSpy = vi.fn(async (_f: number) => rendered(makeBmp()));
    const pending: (() => void)[] = [];
    const prewarmer = new MotifPrewarmer({
      capBytes: 240,
      hasFrame: (k, f) => cached.has(`${k}#${f}`),
      setFrame: setSpy,
      prioritizeFrames: () => {},
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => {},
      cancelRequest: vi.fn(),
    });
    const spec: PrewarmContentSpec = {
      cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, frameBytes: 1, render: renderSpy,
    };
    prewarmer.setTargets([spec]);
    let guard = 0;
    while (pending.length > 0 && guard++ < 20) {
      const cb = pending.shift()!;
      cb();
      await new Promise((r) => setTimeout(r, 0)); // let async drainBatch settle
    }
    expect(renderSpy).toHaveBeenCalledTimes(3); // frames 0,1,2
    expect(cached.has("a#0") && cached.has("a#1") && cached.has("a#2")).toBe(true);
  });

  it("dispose cancels and stops rastering", async () => {
    const pending: (() => void)[] = [];
    const renderSpy = vi.fn(async () => rendered(makeBmp()));
    const prewarmer = new MotifPrewarmer({
      capBytes: 240, hasFrame: () => false, setFrame: () => {},
      prioritizeFrames: () => {},
      schedule: (cb) => { pending.push(cb); return pending.length; }, cancel: () => {}, cancelRequest: vi.fn(),
    });
    prewarmer.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, frameBytes: 1, render: renderSpy }]);
    prewarmer.dispose();
    while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("registers only the byte-bounded demand window with acquisition", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      (_f: number) =>
        new Promise<Rendered>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight--;
            resolve(rendered(makeBmp()));
          });
        }),
    );
    const pending: (() => void)[] = [];
    const prewarmer = new MotifPrewarmer({
      capBytes: 3,
      hasFrame: () => false,
      setFrame: () => {},
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      cancelRequest: vi.fn(),
      prioritizeFrames: () => {},
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 10, frameBytes: 1, render },
    ]);
    pending.shift()!(); // run the first scheduled batch
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(3); // three frame addresses fit the demand window
    release.forEach((r) => r());
  });

  it("calls onProgress after draining a batch", async () => {
    const onProgress = vi.fn();
    let scheduled: (() => void) | null = null;
    const prewarmer = new MotifPrewarmer({
      capBytes: 10,
      hasFrame: () => false,
      setFrame: () => {},
      schedule: (cb) => { scheduled = cb; return 1; },
      cancel: () => {},
      onProgress,
      prioritizeFrames: () => {},
      cancelRequest: vi.fn(),
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 2, frameBytes: 1, render: async () => rendered(makeBmp()) },
    ]);
    scheduled!();
    await new Promise((r) => setTimeout(r, 0));
    expect(onProgress).toHaveBeenCalled();
  });

  it("closes bitmaps that resolve after dispose (mid-batch)", async () => {
    const closed: number[] = [];
    let n = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      () =>
        new Promise<Rendered>((resolve) => {
          const id = n++;
          release.push(() =>
            resolve(rendered({
              close() {
                closed.push(id);
              },
            } as unknown as ImageBitmap)),
          );
        }),
    );
    const setFrame = vi.fn();
    const pending: (() => void)[] = [];
    const prewarmer = new MotifPrewarmer({
      capBytes: 2,
      hasFrame: () => false,
      setFrame,
      prioritizeFrames: () => {},
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      cancelRequest: vi.fn(),
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, frameBytes: 1, render },
    ]);
    pending.shift()!(); // start the batch (2 renders in flight, gated)
    await Promise.resolve();
    prewarmer.dispose();
    release.forEach((r) => r()); // resolve after dispose
    await new Promise((r) => setTimeout(r, 0));
    expect(setFrame).not.toHaveBeenCalled();
    expect(closed.length).toBe(2); // both late bitmaps closed, not leaked
  });
});

// Exercise the real byte-bounded cache together with the real prewarm queue.
// A Set double cannot catch prefetch evicting the next unplayed frame.
describe("MotifPrewarmer cache retention", () => {
  const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;

  function rig(capacityFrames: number) {
    const cache = new MotifFrameCache(capacityFrames * 4);
    const pending: (() => void)[] = [];
    const render = vi.fn(async (_frame: number) => rendered(bitmap()));
    const prewarmer = new MotifPrewarmer({
      capBytes: cache.capacityBytes(),
      hasFrame: (k, f) => cache.hasFrame(k, f, 1),
      setFrame: (k, f, div, b) => { cache.setFrame(k, f, div, b); },
      prioritizeFrames: (targets) => cache.prioritizeFrames(targets, 1),
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => { pending.length = 0; },
      cancelRequest: vi.fn(),
    });
    const spec = (contentFrame: number, cacheKey = "a"): PrewarmContentSpec => ({
      cacheKey, contentFrame, contentDurationFrames: 40, frameBytes: 4, render,
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const drain = async () => {
      let batches = 0;
      while (pending.length && batches++ < 100) { pending.shift()!(); await settle(); }
      expect(pending).toHaveLength(0);
    };
    return { cache, prewarmer, render, spec, pending, settle, drain };
  }

  it("keeps upcoming frames through repeated forward playback at capacity", async () => {
    const r = rig(3);
    try {
      r.prewarmer.setTargets([r.spec(0)]);
      await r.drain();
      expect(r.cache.getFrame("a", 0, 1)).not.toBeNull();
      for (let frame = 1; frame <= 20; frame++) {
        expect(r.cache.getFrame("a", frame, 1), `playback frame ${frame}`).not.toBeNull();
        r.prewarmer.setTargets([r.spec(frame)]);
        await r.drain();
        expect(r.cache.hasFrame("a", frame + 1, 1), `next frame after ${frame}`).toBe(true);
        expect(r.cache.hasFrame("a", frame - 1, 1)).toBe(false);
        expect(r.cache.size()).toBe(3);
      }
      // Every frame was prepared once, with no re-read of an evicted future.
      expect(r.render.mock.calls.map(([frame]) => frame)).toEqual(
        Array.from({ length: 23 }, (_, i) => i),
      );
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("preserves both contents' upcoming frames and a retired bitmap's pin", async () => {
    const r = rig(4);
    try {
      r.prewarmer.setTargets([r.spec(0), r.spec(0, "b")]);
      await r.drain();
      const bound = r.cache.getFrame("a", 0, 1)!;
      r.cache.retain(bound);
      r.cache.getFrame("b", 0, 1);
      r.cache.getFrame("a", 1, 1);
      r.cache.getFrame("b", 1, 1);
      r.prewarmer.setTargets([r.spec(1), r.spec(1, "b")]);
      await r.drain();
      for (const key of ["a", "b"]) {
        expect(r.cache.hasFrame(key, 0, 1)).toBe(false);
        expect(r.cache.hasFrame(key, 1, 1)).toBe(true);
        expect(r.cache.hasFrame(key, 2, 1)).toBe(true);
      }
      expect(r.cache.size()).toBe(4);
      expect(bound.close).not.toHaveBeenCalled();
      r.cache.release(bound);
      expect(bound.close).toHaveBeenCalledTimes(1);
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("discards an in-flight frame outside the new window after seeking back", async () => {
    const r = rig(3);
    try {
      r.prewarmer.setTargets([r.spec(0)]);
      await r.drain();
      let finish!: (bmp: ImageBitmap) => void;
      r.render.mockImplementationOnce(() => new Promise((resolve) => { finish = bmp => resolve(rendered(bmp)); }));
      r.prewarmer.setTargets([r.spec(10)]);
      r.pending.shift()!();
      r.prewarmer.setTargets([r.spec(0)]);
      const stale = bitmap();
      finish(stale);
      await r.settle();
      expect(stale.close).toHaveBeenCalledTimes(1);
      expect(r.cache.hasFrame("a", 10, 1)).toBe(false);
      for (const frame of [0, 1, 2]) expect(r.cache.hasFrame("a", frame, 1)).toBe(true);
      await r.drain();
      expect(r.render).toHaveBeenCalledTimes(6); // initial window + abandoned window 10–12
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("keeps an in-flight frame still needed after the playhead advances", async () => {
    const r = rig(3);
    try {
      r.cache.setFrame("a", 0, 1, bitmap());
      r.cache.setFrame("a", 1, 1, bitmap());
      let finish!: (bmp: ImageBitmap) => void;
      r.render.mockImplementationOnce(() => new Promise((resolve) => { finish = bmp => resolve(rendered(bmp)); }));
      r.prewarmer.setTargets([r.spec(0)]);
      r.pending.shift()!(); // frame 2 is in flight
      r.cache.getFrame("a", 1, 1);
      r.prewarmer.setTargets([r.spec(1)]);
      const next = bitmap();
      finish(next);
      await r.settle();
      await r.drain();
      expect(next.close).not.toHaveBeenCalled();
      expect(r.cache.getFrame("a", 2, 1)).toBe(next);
      expect(r.render.mock.calls.map(([frame]) => frame)).toEqual([2, 3]);
      expect(r.cache.hasFrame("a", 0, 1)).toBe(false);
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("stores live captures as divisor 1 and does not request them again at 1/2", async () => {
    const cache = new MotifFrameCache(3 * 4);
    const pending: (() => void)[] = [];
    const render = vi.fn(async (_frame: number): Promise<Rendered> => ({ bitmap: bitmap(), scaleDiv: "live" }));
    const prewarmer = new MotifPrewarmer({
      capBytes: cache.capacityBytes(),
      hasFrame: (k, f) => cache.hasFrame(k, f, 2),
      setFrame: (k, f, div, b) => { cache.setFrame(k, f, div, b); },
      prioritizeFrames: (targets) => cache.prioritizeFrames(targets, 2),
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => {}, cancelRequest: vi.fn(),
    });
    const spec: PrewarmContentSpec = { cacheKey: "a", contentFrame: 0, contentDurationFrames: 40, frameBytes: 4, render };
    try {
      for (let pass = 0; pass < 3; pass++) {
        prewarmer.setTargets([spec]);
        while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
      }
      expect(render.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2]);
      expect(cache.getFrame("a", 0, 1)).not.toBeNull();
    } finally { prewarmer.dispose(); cache.dispose(); }
  });
});
