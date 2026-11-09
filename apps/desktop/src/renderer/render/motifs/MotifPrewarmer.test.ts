import { describe, expect, it, vi } from "vitest";
import { MotifPrewarmer, type MotifPrewarmerDeps, type PrewarmContentSpec } from "./MotifPrewarmer";
import { MotifFrameCache, type MotifFrameDiv } from "./frameCache";
import type { MotifFrameAcquisition, MotifFrameLease, MotifFrameRequest } from "./motifFrameSource";
import type { MotifFramePriority } from "../../../shared/motifs/frameTransport";
import type { MotifFrameDescriptor } from "./motifFrameDescriptor";
import { MOTIF_TUNING_DEFAULTS } from "../../../shared/motifs/tuning";
import type { MotifReaderDiv } from "../../../shared/motifs/readerProtocol";

type Acquire = (d: MotifFrameDescriptor, request: MotifFrameRequest) => Promise<MotifFrameLease>;
const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;
const settle = () => new Promise((r) => setTimeout(r, 0));
const lease = (frame: number, release = vi.fn()): MotifFrameLease => ({ bitmap: bitmap(), frame, release });

function descriptor(cacheKey: string, contentFrame: number): MotifFrameDescriptor {
  return {
    cacheKey, motifId: "m", contentHash: "", fpsNum: 30, fpsDen: 1, contentFrame,
    contentDurationFrames: 1, contentDurationUs: 0, srcInUs: 0, renderW: 1, renderH: 1,
    canonicalProps: {}, tSec: contentFrame / 30, overlayActive: false,
  };
}
function spec(cacheKey: string, contentFrame: number, contentDurationFrames: number, frameBytes = 1, scaleDiv: MotifReaderDiv = 1, historyFrames?: number): PrewarmContentSpec {
  return {
    cacheKey, contentFrame, contentDurationFrames, frameBytes, scaleDiv,
    ...(historyFrames !== undefined ? { historyFrames } : {}),
    descriptor: descriptor(cacheKey, contentFrame),
  };
}

/** `acquire` as the prewarmer sees it: each re-class or re-rank of a request
 * reaches `setPriority` with the request's frame. */
function handles(acquire: Acquire, setPriority: (frame: number, priority: MotifFramePriority, order?: number) => void = () => {}) {
  return (d: MotifFrameDescriptor, request: MotifFrameRequest): MotifFrameAcquisition => ({
    lease: acquire(d, request),
    setPriority: (priority, order) => setPriority(d.contentFrame, priority, order),
  });
}

/** A prewarmer whose idle slices run on `drain`. `cached` stands in for L0. */
function rig(acquire: Acquire, capBytes: number, cached = new Set<string>(), overrides: Partial<MotifPrewarmerDeps> = {}) {
  const pending: (() => void)[] = [];
  const acquireSpy = vi.fn(acquire);
  const setPriority = vi.fn<(frame: number, priority: MotifFramePriority, order?: number) => void>();
  const prewarmer = new MotifPrewarmer({
    capBytes,
    coverage: { has: (k, f) => cached.has(`${k}#${f}`), prioritize: () => {} },
    acquire: handles(acquireSpy, setPriority),
    schedule: (cb) => { pending.push(cb); return pending.length; },
    cancel: () => {},
    ...overrides,
  });
  const frames = () => acquireSpy.mock.calls.map(([d]) => d.contentFrame);
  return { prewarmer, pending, acquire: acquireSpy, setPriority, frames };
}

describe("MotifPrewarmer", () => {
  it("bounds requests even when tiny long Motifs fit in the pixel budget, and aborts them on dispose", () => {
    const r = rig(() => new Promise(() => {}), 512 * 1024 * 1024);
    r.prewarmer.setTargets([spec("a", 0, 1_000_000, 4), spec("b", 0, 1_000_000, 4)]);
    r.pending.shift()!();
    expect(r.acquire).toHaveBeenCalledTimes(MOTIF_TUNING_DEFAULTS.prewarmRequests);
    r.prewarmer.dispose();
    expect(r.acquire.mock.calls.every(([, request]) => request.signal.aborted)).toBe(true);
  });

  it("requests each frame with its own descriptor, lookahead `ahead` and history `background`", () => {
    const r = rig(() => new Promise(() => {}), 6);
    r.prewarmer.setTargets([spec("a", 5, 10, 1, 2, 2)]);
    r.pending.shift()!();
    const calls = r.acquire.mock.calls.map(([d, request]) => [d.contentFrame, d.tSec, request.priority, request.scaleDiv]);
    expect(calls).toEqual([
      [5, 5 / 30, "ahead", 2], [6, 6 / 30, "ahead", 2], [7, 7 / 30, "ahead", 2], [8, 8 / 30, "ahead", 2],
      [4, 4 / 30, "background", 2], [3, 3 / 30, "background", 2],
    ]);
    r.prewarmer.dispose();
  });

  it("does not refill with an already in-flight frame after replanning", async () => {
    const releases = new Map<number, () => void>();
    const cached = new Set<string>();
    const r = rig((d) => new Promise((resolve) => releases.set(d.contentFrame, () => {
      cached.add(`animation#${d.contentFrame}`);
      resolve(lease(d.contentFrame));
    })), 3, cached);
    const specs = [spec("animation", 0, 64)];
    r.prewarmer.setTargets(specs);
    r.pending.shift()!(); // frames 0, 1, 2
    r.prewarmer.setTargets(specs); // compositor replans while those reads run
    releases.get(1)!();
    await settle();
    expect(r.pending).toHaveLength(0);
    r.prewarmer.setTargets([spec("animation", 1, 64)]);
    r.pending.shift()!();
    expect(r.frames()).toEqual([0, 1, 2, 3]);
    r.prewarmer.dispose();
  });

  it("warms missing targets in plan order, skips cached ones, releases each lease and stops when done", async () => {
    const cached = new Set<string>(["a#1"]);
    const releases: ReturnType<typeof vi.fn>[] = [];
    const onProgress = vi.fn();
    const r = rig(async (d) => {
      cached.add(`a#${d.contentFrame}`);
      const release = vi.fn(); releases.push(release);
      return lease(d.contentFrame, release);
    }, 240, cached, { onProgress });
    r.prewarmer.setTargets([spec("a", 0, 3)]);
    let guard = 0;
    while (r.pending.length > 0 && guard++ < 20) {
      r.pending.shift()!();
      await settle();
    }
    expect(r.frames()).toEqual([0, 2]);
    expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(2);
    r.prewarmer.setTargets([spec("a", 0, 3)]);
    expect(r.pending).toHaveLength(0);
  });

  it("a target whose request throws at once does not stop the others", () => {
    const r = rig(d => {
      if (d.contentFrame === 1) throw new Error("synthetic");
      return new Promise(() => {});
    }, 3);
    r.prewarmer.setTargets([spec("a", 0, 10)]);
    r.pending.shift()!();
    expect(r.frames()).toEqual([0, 1, 2]);
    r.prewarmer.dispose();
  });

  it("dispose cancels the idle slice before any request", async () => {
    const r = rig(async (d) => lease(d.contentFrame), 240);
    r.prewarmer.setTargets([spec("a", 0, 5)]);
    r.prewarmer.dispose();
    while (r.pending.length) { r.pending.shift()!(); await settle(); }
    expect(r.acquire).not.toHaveBeenCalled();
  });

  it("registers only the byte-bounded demand window", () => {
    const r = rig(() => new Promise(() => {}), 3);
    r.prewarmer.setTargets([spec("a", 0, 10)]);
    r.pending.shift()!();
    expect(r.frames()).toEqual([0, 1, 2]);
    r.prewarmer.dispose();
  });

  it("aborts requests a replan drops and keeps those it still wants", () => {
    const r = rig(() => new Promise(() => {}), 3);
    r.prewarmer.setTargets([spec("a", 0, 10)]);
    r.pending.shift()!();
    r.prewarmer.setTargets([spec("a", 1, 10)]);
    const signals = r.acquire.mock.calls.map(([d, request]) => [d.contentFrame, request.signal.aborted]);
    expect(signals).toEqual([[0, true], [1, false], [2, false]]);
    r.prewarmer.dispose();
  });

  it("ranks each request by its place in the plan", () => {
    const r = rig(() => new Promise(() => {}), 4);
    r.prewarmer.setTargets([spec("a", 2, 10, 1, 1, 1)]);
    r.pending.shift()!();
    expect(r.acquire.mock.calls.map(([d, request]) => [d.contentFrame, request.priority, request.order]))
      .toEqual([[2, "ahead", 0], [3, "ahead", 1], [4, "ahead", 2], [1, "background", 3]]);
    r.prewarmer.dispose();
  });

  it("a playhead that passes a kept frame demotes it to background, and re-ranks the rest", () => {
    const r = rig(() => new Promise(() => {}), 4);
    r.prewarmer.setTargets([spec("a", 0, 10, 1, 1, 2)]);
    r.pending.shift()!(); // frames 0..3, all ahead
    r.prewarmer.setTargets([spec("a", 1, 10, 1, 1, 2)]);
    // Plan [1, 2, 3, 0]: 0 is history now.
    expect(r.setPriority.mock.calls).toEqual([[1, "ahead", 0], [2, "ahead", 1], [3, "ahead", 2], [0, "background", 3]]);
    r.prewarmer.dispose();
  });

  it("a seek back before kept history re-classes it ahead", () => {
    const r = rig(() => new Promise(() => {}), 4);
    r.prewarmer.setTargets([spec("a", 5, 10, 1, 1, 1)]);
    r.pending.shift()!(); // plan [5, 6, 7, 4]
    expect(r.acquire.mock.calls.map(([d, request]) => [d.contentFrame, request.priority])).toEqual([[5, "ahead"], [6, "ahead"], [7, "ahead"], [4, "background"]]);
    r.setPriority.mockClear();
    r.prewarmer.setTargets([spec("a", 4, 10, 1, 1, 1)]);
    // Plan [4, 5, 6, 3]: 4 was history and leads now; 7 left the plan.
    expect(r.setPriority.mock.calls).toEqual([[4, "ahead", 0], [5, "ahead", 1], [6, "ahead", 2]]);
    expect(r.acquire.mock.calls.find(([d]) => d.contentFrame === 7)![1].signal.aborted).toBe(true);
    r.prewarmer.dispose();
  });
});

// Exercise the real byte-bounded cache together with the real prewarm queue.
// A Set double cannot catch prefetch evicting the next unplayed frame.
describe("MotifPrewarmer cache retention", () => {
  /** Publishes into `cache` the way `acquireMotifFrame` does: once, pinned
   * for the holder. */
  function publishing(cache: MotifFrameCache, div: (d: MotifFrameDescriptor, scaleDiv: MotifReaderDiv) => MotifFrameDiv = (_d, s) => s) {
    return (d: MotifFrameDescriptor, request: MotifFrameRequest, value = bitmap()): MotifFrameLease => {
      const canonical = cache.setFrame(d.cacheKey, d.contentFrame, div(d, request.scaleDiv), value);
      cache.retain(canonical);
      return { bitmap: canonical, frame: d.contentFrame, release: () => cache.release(canonical) };
    };
  }
  function cacheRig(capacityFrames: number) {
    const cache = new MotifFrameCache(capacityFrames * 4);
    const publish = publishing(cache);
    const pending: (() => void)[] = [];
    const acquire = vi.fn<Acquire>(async (d, request) => publish(d, request));
    const prewarmer = new MotifPrewarmer({
      capBytes: cache.capacityBytes(),
      coverage: { has: (k, f, div) => cache.hasFrame(k, f, div), prioritize: (targets) => cache.prioritizeFrames(targets) },
      acquire: handles(acquire),
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => { pending.length = 0; },
    });
    const at = (contentFrame: number, cacheKey = "a") => spec(cacheKey, contentFrame, 40, 4);
    const drain = async () => {
      let batches = 0;
      while (pending.length && batches++ < 100) { pending.shift()!(); await settle(); }
      expect(pending).toHaveLength(0);
    };
    return { cache, prewarmer, acquire, publish, at, pending, drain };
  }

  it("keeps upcoming frames through repeated forward playback at capacity", async () => {
    const r = cacheRig(3);
    try {
      r.prewarmer.setTargets([r.at(0)]);
      await r.drain();
      expect(r.cache.getFrame("a", 0, 1)).not.toBeNull();
      for (let frame = 1; frame <= 20; frame++) {
        expect(r.cache.getFrame("a", frame, 1), `playback frame ${frame}`).not.toBeNull();
        r.prewarmer.setTargets([r.at(frame)]);
        await r.drain();
        expect(r.cache.hasFrame("a", frame + 1, 1), `next frame after ${frame}`).toBe(true);
        expect(r.cache.hasFrame("a", frame - 1, 1)).toBe(false);
        expect(r.cache.size()).toBe(3);
      }
      // Every frame was prepared once, with no re-read of an evicted future.
      expect(r.acquire.mock.calls.map(([d]) => d.contentFrame)).toEqual(Array.from({ length: 23 }, (_, i) => i));
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("preserves both contents' upcoming frames and a bound bitmap's pin", async () => {
    const r = cacheRig(4);
    try {
      r.prewarmer.setTargets([r.at(0), r.at(0, "b")]);
      await r.drain();
      const bound = r.cache.getFrame("a", 0, 1)!;
      r.cache.retain(bound);
      r.cache.getFrame("b", 0, 1);
      r.cache.getFrame("a", 1, 1);
      r.cache.getFrame("b", 1, 1);
      r.prewarmer.setTargets([r.at(1), r.at(1, "b")]);
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

  it("keeps an in-flight frame still needed after the playhead advances", async () => {
    const r = cacheRig(3);
    try {
      r.cache.setFrame("a", 0, 1, bitmap());
      r.cache.setFrame("a", 1, 1, bitmap());
      let finish!: (value: ImageBitmap) => void;
      let signal!: AbortSignal;
      r.acquire.mockImplementationOnce((d, request) => new Promise((resolve) => {
        signal = request.signal;
        finish = (value) => resolve(r.publish(d, request, value));
      }));
      r.prewarmer.setTargets([r.at(0)]);
      r.pending.shift()!(); // frame 2 is in flight
      r.cache.getFrame("a", 1, 1);
      r.prewarmer.setTargets([r.at(1)]);
      expect(signal.aborted).toBe(false);
      const next = bitmap();
      finish(next);
      await settle();
      await r.drain();
      expect(next.close).not.toHaveBeenCalled();
      expect(r.cache.getFrame("a", 2, 1)).toBe(next);
      expect(r.acquire.mock.calls.map(([d]) => d.contentFrame)).toEqual([2, 3]);
      expect(r.cache.hasFrame("a", 0, 1)).toBe(false);
    } finally { r.prewarmer.dispose(); r.cache.dispose(); }
  });

  it("does not request a live capture again at 1/2", async () => {
    const cache = new MotifFrameCache(3 * 4);
    const publish = publishing(cache, () => "live");
    const pending: (() => void)[] = [];
    const acquire = vi.fn<Acquire>(async (d, request) => publish(d, request));
    const prewarmer = new MotifPrewarmer({
      capBytes: cache.capacityBytes(),
      coverage: { has: (k, f, div) => cache.hasFrame(k, f, div), prioritize: (targets) => cache.prioritizeFrames(targets) },
      acquire: handles(acquire),
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => {},
    });
    try {
      for (let pass = 0; pass < 3; pass++) {
        prewarmer.setTargets([spec("a", 0, 40, 4, 2)]);
        while (pending.length) { pending.shift()!(); await settle(); }
      }
      expect(acquire.mock.calls.map(([d]) => d.contentFrame)).toEqual([0, 1, 2]);
      expect(cache.getFrame("a", 0, 1)).not.toBeNull();
    } finally { prewarmer.dispose(); cache.dispose(); }
  });
});
