import { describe, expect, it, vi } from "vitest";
import { MotifPrewarmer, type PrewarmContentSpec } from "./MotifPrewarmer";
import { MotifFrameCache } from "./frameCache";

function makeBmp(): ImageBitmap { return { close() {} } as unknown as ImageBitmap; }

describe("MotifPrewarmer", () => {
  it("rasters missing targets in plan order, skips cached, stops when done", async () => {
    const cached = new Set<string>();
    const setSpy = vi.fn((k: string, f: number) => cached.add(`${k}#${f}`));
    const renderSpy = vi.fn(async (_f: number) => makeBmp());
    const pending: (() => void)[] = [];
    const prewarmer = new MotifPrewarmer({
      capBytes: 240,
      hasFrame: (k, f) => cached.has(`${k}#${f}`),
      setFrame: setSpy,
      prioritizeFrames: () => {},
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => {},
      batchSize: 2,
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
    const renderSpy = vi.fn(async () => makeBmp());
    const prewarmer = new MotifPrewarmer({
      capBytes: 240, hasFrame: () => false, setFrame: () => {},
      prioritizeFrames: () => {},
      schedule: (cb) => { pending.push(cb); return pending.length; }, cancel: () => {}, batchSize: 1,
    });
    prewarmer.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, frameBytes: 1, render: renderSpy }]);
    prewarmer.dispose();
    while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("dispatches up to batchSize rasters concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      (_f: number) =>
        new Promise<ImageBitmap>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight--;
            resolve(makeBmp());
          });
        }),
    );
    const pending: (() => void)[] = [];
    const prewarmer = new MotifPrewarmer({
      capBytes: 240,
      hasFrame: () => false,
      setFrame: () => {},
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      batchSize: 3,
      prioritizeFrames: () => {},
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 10, frameBytes: 1, render },
    ]);
    pending.shift()!(); // run the first scheduled batch
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(3); // batchSize rasters in flight at once
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
      batchSize: 1,
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 2, frameBytes: 1, render: async () => makeBmp() },
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
        new Promise<ImageBitmap>((resolve) => {
          const id = n++;
          release.push(() =>
            resolve({
              close() {
                closed.push(id);
              },
            } as unknown as ImageBitmap),
          );
        }),
    );
    const setFrame = vi.fn();
    const pending: (() => void)[] = [];
    const prewarmer = new MotifPrewarmer({
      capBytes: 240,
      hasFrame: () => false,
      setFrame,
      prioritizeFrames: () => {},
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      batchSize: 2,
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
    const render = vi.fn(async (_frame: number) => bitmap());
    const prewarmer = new MotifPrewarmer({
      capBytes: cache.capacityBytes(),
      hasFrame: (k, f) => cache.hasFrame(k, f),
      setFrame: (k, f, b) => { cache.setFrame(k, f, b); },
      prioritizeFrames: (targets) => cache.prioritizeFrames(targets),
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => { pending.length = 0; },
      batchSize: 1,
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
      expect(r.cache.getFrame("a", 0)).not.toBeNull();
      for (let frame = 1; frame <= 20; frame++) {
        expect(r.cache.getFrame("a", frame), `playback frame ${frame}`).not.toBeNull();
        r.prewarmer.setTargets([r.spec(frame)]);
        await r.drain();
        expect(r.cache.hasFrame("a", frame + 1), `next frame after ${frame}`).toBe(true);
        expect(r.cache.hasFrame("a", frame - 1)).toBe(false);
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
      const bound = r.cache.getFrame("a", 0)!;
      r.cache.retain(bound);
      r.cache.getFrame("b", 0);
      r.cache.getFrame("a", 1);
      r.cache.getFrame("b", 1);
      r.prewarmer.setTargets([r.spec(1), r.spec(1, "b")]);
      await r.drain();
      for (const key of ["a", "b"]) {
        expect(r.cache.hasFrame(key, 0)).toBe(false);
        expect(r.cache.hasFrame(key, 1)).toBe(true);
        expect(r.cache.hasFrame(key, 2)).toBe(true);
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
      r.render.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      r.prewarmer.setTargets([r.spec(10)]);
      r.pending.shift()!();
      r.prewarmer.setTargets([r.spec(0)]);
      const stale = bitmap();
      finish(stale);
      await r.settle();
      expect(stale.close).toHaveBeenCalledTimes(1);
      expect(r.cache.hasFrame("a", 10)).toBe(false);
      for (const frame of [0, 1, 2]) expect(r.cache.hasFrame("a", frame)).toBe(true);
      await r.drain();
      expect(r.render).toHaveBeenCalledTimes(4); // initial window + abandoned frame 10
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("keeps an in-flight frame still needed after the playhead advances", async () => {
    const r = rig(3);
    try {
      r.cache.setFrame("a", 0, bitmap());
      r.cache.setFrame("a", 1, bitmap());
      let finish!: (bmp: ImageBitmap) => void;
      r.render.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      r.prewarmer.setTargets([r.spec(0)]);
      r.pending.shift()!(); // frame 2 is in flight
      r.cache.getFrame("a", 1);
      r.prewarmer.setTargets([r.spec(1)]);
      const next = bitmap();
      finish(next);
      await r.settle();
      await r.drain();
      expect(next.close).not.toHaveBeenCalled();
      expect(r.cache.getFrame("a", 2)).toBe(next);
      expect(r.render.mock.calls.map(([frame]) => frame)).toEqual([2, 3]);
      expect(r.cache.hasFrame("a", 0)).toBe(false);
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });
});
