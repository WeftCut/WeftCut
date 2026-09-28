import { describe, expect, it, vi } from "vitest";
import { MotifBaker, type BakeContentSpec, type BakeStatus } from "./MotifBaker";

function makeFakeBitmap(): ImageBitmap {
  return { close: vi.fn(), width: 1, height: 1 } as unknown as ImageBitmap;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/// Drive the idle loop deterministically: run each scheduled callback, then let
/// the async drainBatch fully settle (a macrotask flush via setTimeout(0))
/// before checking for the next re-armed callback. Mirrors
/// MotifPrewarmer.test.ts. `guard` bounds a runaway loop.
async function drain(pending: (() => void)[]): Promise<void> {
  let guard = 0;
  while (pending.length > 0 && guard++ < 50) {
    const cb = pending.shift()!;
    cb();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("MotifBaker", () => {
  function harness() {
    const pending: (() => void)[] = [];
    const deps = {
      schedule: (cb: () => void) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: vi.fn(async (_key: string, _frame: number) => false),
      persist: vi.fn(async () => {}),
      warm: vi.fn(),
      onStatus: vi.fn((_key: string, _status: BakeStatus) => {}),
      batchSize: 1,
    };
    const bitmap = makeFakeBitmap();
    const spec: BakeContentSpec = {
      cacheKey: "a", contentFrame: 0, contentDurationFrames: 3,
      render: vi.fn(async () => bitmap),
    };
    return { pending, deps, bitmap, spec, baker: new MotifBaker(deps) };
  }

  it("closes a rendered bitmap when persistence fails", async () => {
    const h = harness();
    h.deps.persist.mockRejectedValue(new Error("disk full"));
    h.baker.setTargets([{ ...h.spec, contentDurationFrames: 1 }]);
    await drain(h.pending);
    expect(h.bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.deps.warm).not.toHaveBeenCalled();
  });

  it("does not begin a capture after disposal during the disk check", async () => {
    const h = harness();
    const check = deferred<boolean>();
    h.deps.isOnDisk.mockReturnValue(check.promise);
    h.baker.setTargets([h.spec]);
    h.pending.shift()!();
    h.baker.dispose();
    check.resolve(false);
    await drain(h.pending);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.spec.render).not.toHaveBeenCalled();
  });

  it("closes without warming or publishing when disposed during persistence", async () => {
    const h = harness();
    const write = deferred<void>();
    h.deps.persist.mockReturnValue(write.promise);
    h.baker.setTargets([h.spec]);
    h.pending.shift()!();
    await vi.waitFor(() => expect(h.deps.persist).toHaveBeenCalled());
    h.baker.dispose();
    h.deps.onStatus.mockClear();
    write.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.bitmap.close).toHaveBeenCalledTimes(1);
    expect(h.deps.warm).not.toHaveBeenCalled();
    expect(h.deps.onStatus).not.toHaveBeenCalled();
  });

  it("counts distinct completed frames across repeated playhead replans", async () => {
    const h = harness();
    h.deps.isOnDisk.mockResolvedValue(true);
    h.baker.setTargets([h.spec]);
    // Finish frame zero, then repeatedly replan from that same frame.
    for (let i = 0; i < 3; i++) {
      h.pending.shift()!();
      await new Promise((r) => setTimeout(r, 0));
      h.baker.setTargets([h.spec]);
    }
    expect(h.deps.onStatus.mock.lastCall![1]).toEqual({ phase: "ready", done: 3, total: 3 });
    expect(h.deps.isOnDisk.mock.calls.map(([, frame]) => frame)).toEqual([0, 1, 2]);
    await drain(h.pending);
    expect(h.deps.onStatus.mock.lastCall![1]).toEqual({ phase: "ready", done: 3, total: 3 });
    h.baker.setTargets([h.spec]);
    await drain(h.pending);
    expect(h.deps.isOnDisk).toHaveBeenCalledTimes(3);
    h.baker.dispose();
  });

  it("renders + persists every frame of the active content, skipping on-disk", async () => {
    const pending: (() => void)[] = [];
    const persisted: string[] = [];
    const render = vi.fn(async (_f: number) => makeFakeBitmap());
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async (k, f) => k === "a" && f === 0, // frame 0 already baked
      persist: async (k, f, _bmp) => { persisted.push(`${k}#${f}`); },
      warm: vi.fn(),
      batchSize: 2,
    });
    const spec: BakeContentSpec = {
      cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render,
    };
    baker.setTargets([spec]);
    await drain(pending);
    expect(persisted.sort()).toEqual(["a#1", "a#2"]); // frame 0 skipped (on disk)
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does nothing when targets is empty", async () => {
    const pending: (() => void)[] = [];
    const persist = vi.fn();
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([]);
    await drain(pending);
    expect(persist).not.toHaveBeenCalled();
  });

  it("dispose stops further work", async () => {
    const pending: (() => void)[] = [];
    const persist = vi.fn(async () => {});
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 4, render: async () => makeFakeBitmap() }]);
    baker.dispose();
    await drain(pending);
    expect(persist).not.toHaveBeenCalled();
  });

  it("emits baking on setTargets then ready when all frames complete", async () => {
    const pending: (() => void)[] = [];
    const emits: { k: string; phase: string; done: number; total: number }[] = [];
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (k, s) => emits.push({ k, ...s }),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() }]);
    expect(emits[0]).toEqual({ k: "a", phase: "baking", done: 0, total: 3 });
    await drain(pending);
    expect(emits[emits.length - 1]).toEqual({ k: "a", phase: "ready", done: 3, total: 3 });
  });

  it("reaches ready via skips when every frame is already on disk (no render)", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const render = vi.fn(async () => makeFakeBitmap());
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => true,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render }]);
    await drain(pending);
    expect(render).not.toHaveBeenCalled();
    expect(emits[emits.length - 1]).toEqual({ phase: "ready", done: 3, total: 3 });
  });

  it("emits error when a frame's persist throws, with counts frozen", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => { throw new Error("disk full"); },
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() }]);
    await drain(pending);
    const last = emits[emits.length - 1]!;
    expect(last.phase).toBe("error");
    expect(last.done).toBe(0);
  });

  it("does not re-announce baking when setTargets repeats an already-ready content", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const spec = { cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() };
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([spec]);
    await drain(pending);
    expect(emits[emits.length - 1]!.phase).toBe("ready");
    const countAfterFirstBake = emits.length;
    // Repeat setTargets with the SAME content (as happens every playback frame).
    baker.setTargets([spec]);
    await drain(pending);
    const newEmits = emits.slice(countAfterFirstBake);
    // No "baking" re-announcement, and it stays ready.
    expect(newEmits.some((e) => e.phase === "baking")).toBe(false);
    expect(emits[emits.length - 1]!.phase).toBe("ready");
  });

  it("targetCacheKeys reports queued AND in-flight contents, empty after dispose", async () => {
    // Block the first batch's render so "a" is mid-flight while "b" is still
    // queued: both must report as targets — the GC live set unions these so a
    // dir the baker is writing into is never collected mid-bake.
    const pending: (() => void)[] = [];
    let releaseRender: (() => void) | null = null;
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => {},
      warm: vi.fn(),
      batchSize: 1,
    });
    baker.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 1, render: () => new Promise<ImageBitmap>((r) => { releaseRender = () => r(makeFakeBitmap()); }) },
      { cacheKey: "b", contentFrame: 0, contentDurationFrames: 1, render: async () => makeFakeBitmap() },
    ]);
    expect(baker.targetCacheKeys().sort()).toEqual(["a", "b"]);
    // Start the drain (frame a#0 goes in-flight and blocks), then re-check.
    const cb = pending.shift()!;
    cb();
    expect(baker.targetCacheKeys().sort()).toEqual(["a", "b"]);
    // A re-plan that drops "b" (props changed mid-bake) must NOT drop the
    // in-flight "a": its frame is still writing to a's hash dir.
    baker.setTargets([{ cacheKey: "c", contentFrame: 0, contentDurationFrames: 1, render: async () => makeFakeBitmap() }]);
    expect(baker.targetCacheKeys().sort()).toEqual(["a", "c"]);
    // Let the batch reach a's render (it sits behind the isOnDisk await).
    await new Promise((r) => setTimeout(r, 0));
    releaseRender!();
    // Let a's settled batch re-arm the queue (its completion chain runs in
    // microtasks first) so drain() below sees the re-armed callback.
    await new Promise((r) => setTimeout(r, 0));
    await drain(pending);
    // Baked-but-still-targeted contents stay listed until setTargets moves on:
    // the conservative answer is the safe one for a GC live set.
    expect(baker.targetCacheKeys()).toEqual(["c"]);
    baker.dispose();
    expect(baker.targetCacheKeys()).toEqual([]);
  });
});
