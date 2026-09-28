import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_MAX_BYTES, MotifFrameCache, hashCacheKey, type Closeable } from "./frameCache";

/// Stand-in for the browser `ImageBitmap`. The L0 store treats values
/// opaquely except for the `close()` call on eviction / clear / dispose and
/// the `width × height × 4` byte cost the eviction budget accounts, so a
/// `{ width, height, close: vi.fn() }` is enough to assert both.
function fakeBitmap(width = 1, height = 1): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

/// Byte budget for exactly `n` default (1×1 = 4-byte) fake frames.
const BYTES_FOR = (n: number) => n * 4;

describe("MotifFrameCache — L0 LRU", () => {
  test("getFrame returns null on miss", () => {
    const c = new MotifFrameCache();
    expect(c.getFrame("k", 0)).toBeNull();
  });

  test("setFrame + getFrame returns the stored bitmap", () => {
    const c = new MotifFrameCache();
    const bm = fakeBitmap();
    c.setFrame("k", 3, bm);
    expect(c.getFrame("k", 3)).toBe(bm);
    expect(c.size()).toBe(1);
  });

  test("frames are keyed by (cacheKey, frameIndex)", () => {
    const c = new MotifFrameCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a);
    c.setFrame("k", 1, b);
    expect(c.getFrame("k", 0)).toBe(a);
    expect(c.getFrame("k", 1)).toBe(b);
    expect(c.size()).toBe(2);
  });

  test("re-set of an existing entry keeps the existing bitmap, closes the incoming, and refreshes recency", () => {
    // setFrame is idempotent: on a same-(key,frame) re-set the existing
    // (possibly already-bound) bitmap is kept and the redundant incoming one is
    // closed; the canonical existing bitmap is returned. Prevents "External
    // Image has been detached" on WebGPU upload when concurrent cold-miss
    // rasterizers race to setFrame the same (key, frame).
    const c = new MotifFrameCache(BYTES_FOR(3));
    const a = fakeBitmap();
    const a2 = fakeBitmap();
    const returned = c.setFrame("k", 0, a);
    expect(returned).toBe(a);
    const returned2 = c.setFrame("k", 0, a2);
    expect(returned2).toBe(a);    // returns the EXISTING canonical, not the incoming
    expect(a2.close).toHaveBeenCalledTimes(1); // incoming redundant one closed
    expect(a.close).not.toHaveBeenCalled();    // existing (maybe-bound) one NOT closed
    expect(c.getFrame("k", 0)).toBe(a);        // canonical still in cache
    expect(c.size()).toBe(1);
  });

  test("re-set with the same bitmap reference does not close it", () => {
    const c = new MotifFrameCache();
    const a = fakeBitmap();
    c.setFrame("k", 0, a);
    expect(c.setFrame("k", 0, a)).toBe(a);
    expect(a.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a);
  });

  test("capacity eviction closes the least-recently-used frame", () => {
    const c = new MotifFrameCache(BYTES_FOR(2));
    const a = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // [a]
    c.setFrame("k", 1, b); // [a, b]
    c.setFrame("k", 2, d); // overflow → evict a → [b, d]
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBeNull();
    expect(c.getFrame("k", 1)).toBe(b);
    expect(c.getFrame("k", 2)).toBe(d);
    expect(c.size()).toBe(2);
  });

  test("eviction defers closing a retained frame until its last release", () => {
    // A sprite's bound bitmap must stay uploadable: Pixi re-reads the resource
    // whenever it (re)creates the GPU texture — after its GC unloads an idle
    // texture, or on a deferred first upload — and a closed bitmap throws
    // "ImageBitmap has been detached" out of the render, which kills the ticker.
    const c = new MotifFrameCache(BYTES_FOR(1));
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a);
    c.retain(a); // bound by a sprite
    c.setFrame("k", 1, b); // overflow → a leaves the store
    expect(c.getFrame("k", 0)).toBeNull();
    expect(a.close).not.toHaveBeenCalled();
    c.release(a);
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  test("a frame retained twice closes only after both releases", () => {
    const c = new MotifFrameCache(BYTES_FOR(1));
    const a = fakeBitmap();
    c.setFrame("k", 0, a);
    c.retain(a);
    c.retain(a); // two sprites share the canonical bitmap
    c.setFrame("k", 1, fakeBitmap());
    c.release(a);
    expect(a.close).not.toHaveBeenCalled();
    c.release(a);
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  test("releasing a frame still in the store does not close it", () => {
    const c = new MotifFrameCache(BYTES_FOR(2));
    const a = fakeBitmap();
    c.setFrame("k", 0, a);
    c.retain(a);
    c.release(a);
    expect(a.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a);
  });

  test("clearKey defers closing a retained frame", () => {
    const c = new MotifFrameCache();
    const a = fakeBitmap();
    c.setFrame("k", 0, a);
    c.retain(a);
    c.clearKey("k");
    expect(a.close).not.toHaveBeenCalled();
    c.release(a);
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  test("dispose closes retained frames that already left the store", () => {
    const c = new MotifFrameCache(BYTES_FOR(1));
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a);
    c.retain(a);
    c.setFrame("k", 1, b);
    c.dispose();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  test("retain/release of a bitmap the cache never held has no close side effect", () => {
    // Placeholder canvases and export-injected frames go through the same
    // sprite bind path; the cache must not close what it does not own.
    const c = new MotifFrameCache();
    const foreign = fakeBitmap();
    c.retain(foreign);
    c.release(foreign);
    c.release(foreign); // an unmatched release is a no-op, not a negative count
    expect(foreign.close).not.toHaveBeenCalled();
  });

  test("getFrame refreshes recency so the touched frame survives eviction", () => {
    const c = new MotifFrameCache(BYTES_FOR(2));
    const a = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // [a]
    c.setFrame("k", 1, b); // [a, b]
    // Touch a → it becomes MRU; b is now LRU.
    expect(c.getFrame("k", 0)).toBe(a); // [b, a]
    c.setFrame("k", 2, d); // overflow → evict b → [a, d]
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a);
    expect(c.getFrame("k", 1)).toBeNull();
    expect(c.getFrame("k", 2)).toBe(d);
  });

  test("setFrame refreshes recency so a re-set frame survives eviction", () => {
    // Re-`setFrame` of an existing entry must move it to the MRU tail (same as
    // a get-hit), so the OTHER frame becomes the LRU eviction victim.
    const c = new MotifFrameCache(BYTES_FOR(2));
    const a = fakeBitmap();
    const a2 = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // [k#0]
    c.setFrame("k", 1, b); // [k#0, k#1]
    // Re-set k#0 with a new bitmap → k#0 becomes MRU; k#1 is now LRU.
    // Idempotent: a is kept (canonical), a2 is closed (redundant incoming).
    c.setFrame("k", 0, a2); // [k#1, k#0]; closes the INCOMING a2 (not a)
    expect(a2.close).toHaveBeenCalledTimes(1); // incoming redundant one closed
    expect(a.close).not.toHaveBeenCalled();    // existing canonical NOT closed
    c.setFrame("k", 2, d); // overflow → evict LRU (k#1) → [k#0, k#2]
    expect(b.close).toHaveBeenCalledTimes(1); // k#1 evicted
    expect(a.close).not.toHaveBeenCalled();   // re-set k#0 (canonical a) survived
    expect(d.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a);        // canonical is still a (not a2)
    expect(c.getFrame("k", 1)).toBeNull();
    expect(c.getFrame("k", 2)).toBe(d);
  });

  test("rejects a negative or fractional frameIndex at the boundary", () => {
    const c = new MotifFrameCache();
    const a = fakeBitmap();
    expect(() => c.setFrame("k", -1, a)).toThrow(/non-negative integer/);
    expect(() => c.setFrame("k", 1.5, a)).toThrow(/non-negative integer/);
    expect(() => c.getFrame("k", -1)).toThrow(/non-negative integer/);
  });

  test("a NaN cap falls back to the default byte budget", () => {
    // A NaN cap must clamp to the default: `bytesUsed > NaN` is always false,
    // so eviction would never fire and the cache would grow unbounded.
    const c = new MotifFrameCache(Number.NaN);
    expect(c.capacityBytes()).toBe(DEFAULT_MAX_BYTES);
    c.setFrame("k", 0, fakeBitmap());
    expect(c.size()).toBe(1); // the entry is cached, not evicted into the void
  });

  test("hasKey reflects presence of any frame for a key", () => {
    const c = new MotifFrameCache();
    expect(c.hasKey("k")).toBe(false);
    c.setFrame("k", 0, fakeBitmap());
    expect(c.hasKey("k")).toBe(true);
    expect(c.hasKey("other")).toBe(false);
  });

  test("clearKey closes only that key's frames", () => {
    const c = new MotifFrameCache();
    const a0 = fakeBitmap();
    const a1 = fakeBitmap();
    const b0 = fakeBitmap();
    c.setFrame("a", 0, a0);
    c.setFrame("a", 1, a1);
    c.setFrame("b", 0, b0);
    c.clearKey("a");
    expect(a0.close).toHaveBeenCalledTimes(1);
    expect(a1.close).toHaveBeenCalledTimes(1);
    expect(b0.close).not.toHaveBeenCalled();
    expect(c.hasKey("a")).toBe(false);
    expect(c.getFrame("b", 0)).toBe(b0);
    expect(c.size()).toBe(1);
  });

  test("prefix-collision: a cacheKey that is a textual prefix of another is not swept", () => {
    // cacheKeys are caller-built JSON and can contain '#'. Key "a" must
    // not match "a#b"'s frame "a#b#5" (the '#'-split must anchor on the
    // LAST '#' and require an all-digit frame-index suffix).
    const c = new MotifFrameCache();
    const shortKey = fakeBitmap();
    const longKey = fakeBitmap();
    c.setFrame("a", 5, shortKey); // map key "a#5"
    c.setFrame("a#b", 5, longKey); // map key "a#b#5"
    expect(c.hasKey("a")).toBe(true);
    expect(c.hasKey("a#b")).toBe(true);

    c.clearKey("a"); // must drop ONLY "a#5"
    expect(shortKey.close).toHaveBeenCalledTimes(1);
    expect(longKey.close).not.toHaveBeenCalled();
    expect(c.hasKey("a")).toBe(false);
    expect(c.hasKey("a#b")).toBe(true);
    expect(c.getFrame("a#b", 5)).toBe(longKey);
  });

  test("dispose closes every frame across all keys", () => {
    const c = new MotifFrameCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k1", 0, a);
    c.setFrame("k2", 0, b);
    c.dispose();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(c.size()).toBe(0);
  });

  test("the default budget bounds BYTES, not frames (fakes claim 1080p dims)", () => {
    // 512 MB ÷ (1920×1080×4) = 64 frames fit; the 65th overflows by one frame
    // and evicts the LRU. Fakes only REPORT dims — no real allocation — so
    // this exercises the accounting cheaply.
    const c = new MotifFrameCache();
    const fit = Math.floor(DEFAULT_MAX_BYTES / (1920 * 1080 * 4)); // 64
    for (let i = 0; i < fit; i++) c.setFrame("k", i, fakeBitmap(1920, 1080));
    expect(c.size()).toBe(fit);
    c.setFrame("k", fit, fakeBitmap(1920, 1080)); // overflow by one frame
    expect(c.size()).toBe(fit);
    expect(c.getFrame("k", 0)).toBeNull(); // oldest evicted
  });

  test("eviction is by bytes: one large frame can push out several small ones", () => {
    const c = new MotifFrameCache(24); // six 1×1 frames' worth
    const a = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // 4 B
    c.setFrame("k", 1, b); // 8 B
    c.setFrame("k", 2, d); // 12 B
    const big = fakeBitmap(2, 2); // 16 B → 28 B total, over the 24 B budget
    c.setFrame("k", 3, big);
    // Only `a` (4 B) had to leave to get back under budget.
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 3)).toBe(big);
    expect(c.size()).toBe(3);
  });

  test("a frame larger than the whole budget stays cached; the next insert evicts it", () => {
    // The just-inserted frame is the one the caller is about to bind — evicting
    // it at insert would close it under the binder. The keep-at-least-one rule
    // parks it until a NEWER insert claims the space.
    const c = new MotifFrameCache(4); // one 1×1 frame's worth
    const big = fakeBitmap(4, 4); // 64 B — oversized alone
    expect(c.setFrame("k", 0, big)).toBe(big);
    expect(big.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(big);
    const small = fakeBitmap();
    c.setFrame("k", 1, small); // big is now the LRU → leaves
    expect(big.close).toHaveBeenCalledTimes(1);
    expect(c.getFrame("k", 1)).toBe(small);
    expect(c.size()).toBe(1);
  });

  test("clearAll retires every frame; a pinned one closes on its last release", () => {
    const c = new MotifFrameCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a);
    c.setFrame("k", 1, b);
    c.retain(a); // bound by a sprite
    c.clearAll();
    expect(c.size()).toBe(0);
    expect(b.close).toHaveBeenCalledTimes(1); // unpinned: closed immediately
    expect(a.close).not.toHaveBeenCalled();   // pinned: parked, not closed
    c.release(a);
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  test("constructor clamps a non-positive cap to at least 1 byte", () => {
    const c = new MotifFrameCache(0);
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a); // oversized vs the 1-byte budget: kept (keep-one rule)
    c.setFrame("k", 1, b); // a is now the LRU → evicted
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(c.size()).toBe(1);
  });

  test("hasFrame peeks without changing recency", () => {
    const cache = new MotifFrameCache(BYTES_FOR(2));
    const a = fakeBitmap(); const b = fakeBitmap(); const c = fakeBitmap();
    cache.setFrame("k", 0, a);
    cache.setFrame("k", 1, b);
    expect(cache.hasFrame("k", 0)).toBe(true);
    expect(cache.hasFrame("k", 2)).toBe(false);
    cache.setFrame("k", 2, c); // cap 2 → evicts LRU (k#0), since hasFrame didn't refresh it
    expect(cache.hasFrame("k", 0)).toBe(false);
    expect(cache.hasFrame("k", 1)).toBe(true);
    expect(cache.hasFrame("k", 2)).toBe(true);
  });

  test("capacityBytes returns the budget", () => { expect(new MotifFrameCache(7).capacityBytes()).toBe(7); });
});

describe("MotifFrameCache — content coverage", () => {
  test("counts existing frames and follows deduplication, eviction and clearing", () => {
    const c = new MotifFrameCache(BYTES_FOR(3));
    const expectExact = () => {
      for (const key of ["a", "b", "c", "missing"]) {
        let truth = 0;
        for (let f = 0; f < 4; f++) if (c.hasFrame(key, f)) truth++;
        expect(c.frameCount(key)).toBe(truth);
        expect(c.hasKey(key)).toBe(truth > 0);
      }
    };
    c.setFrame("a", 0, fakeBitmap());
    c.setFrame("a", 1, fakeBitmap());
    c.setFrame("b", 0, fakeBitmap());
    expectExact(); // late readers see existing coverage
    c.setFrame("c", 0, fakeBitmap()); // evicts a#0
    expectExact();
    c.setFrame("b", 0, fakeBitmap()); // duplicate does not count twice
    expectExact();
    c.clearKey("a");
    expectExact();
    c.clearAll();
    expectExact();
    c.setFrame("a", 0, fakeBitmap());
    c.dispose();
    expectExact();
  });

  test("evicted retained frames stop contributing before their last release", () => {
    const c = new MotifFrameCache(BYTES_FOR(1));
    const bitmap = fakeBitmap();
    c.setFrame("a", 0, bitmap);
    c.retain(bitmap);
    c.setFrame("b", 0, fakeBitmap());
    expect(c.frameCount("a")).toBe(0);
    expect(c.frameCount("b")).toBe(1);
    expect(bitmap.close).not.toHaveBeenCalled();
    c.release(bitmap);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(c.frameCount("b")).toBe(1);
    c.dispose();
  });
});

describe("MotifFrameCache — L2 worker-safety (no window bridge)", () => {
  // Asserts every L2 disk op degrades to a clean no-op when `window` (and with
  // it the IPC bridge) is absent. Why: `rasterRootDir` in frameCache.ts.
  const realWindow = (globalThis as Record<string, unknown>).window;
  afterEach(() => {
    (globalThis as Record<string, unknown>).window = realWindow;
  });

  test("listBakedHashes resolves to an empty set when window is undefined", async () => {
    delete (globalThis as Record<string, unknown>).window;
    await expect(new MotifFrameCache().listBakedHashes()).resolves.toEqual(new Set());
  });

  test("gcUnreferenced does not throw when window is undefined", async () => {
    delete (globalThis as Record<string, unknown>).window;
    await expect(new MotifFrameCache().gcUnreferenced(["k"])).resolves.toBeUndefined();
  });

  test("readPng / hasPng return the empty result when window is undefined", async () => {
    delete (globalThis as Record<string, unknown>).window;
    const c = new MotifFrameCache();
    await expect(c.readPng("k", 0)).resolves.toBeNull();
    await expect(c.hasPng("k", 0)).resolves.toBe(false);
  });
});

describe("hashCacheKey", () => {
  test("is deterministic and 32-char lowercase hex (128-bit: two FNV-1a-64 lanes)", () => {
    const h = hashCacheKey("motif|3|640|360|{\"x\":1}");
    expect(h).toBe(hashCacheKey("motif|3|640|360|{\"x\":1}"));
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  test("distinct keys hash to distinct dir names (no trivial collision)", () => {
    expect(hashCacheKey("a")).not.toBe(hashCacheKey("b"));
    expect(hashCacheKey("motif|1")).not.toBe(hashCacheKey("motif|2"));
  });

  test("non-ASCII keys mix fully and stay deterministic", () => {
    const zh = hashCacheKey("{\"标题\":\"你好\"}");
    expect(zh).toBe(hashCacheKey("{\"标题\":\"你好\"}"));
    expect(zh).toMatch(/^[0-9a-f]{32}$/);
    expect(zh).not.toBe(hashCacheKey("{\"标题\":\"好你\"}"));
  });

  test("old-format (8-hex) dirs are not live-set members, so gcUnreferenced reclaims them", () => {
    // The Phase-3 32-bit FNV dirs (8 hex chars) can never equal a live key's
    // 32-char hash — gcUnreferenced deletes any dir name not in the live set,
    // with no name-format filter, so the migration is "next GC reclaims them".
    const legacyDir = "deadbeef";
    expect(legacyDir).not.toBe(hashCacheKey("motif|3|640|360|{}"));
    expect(legacyDir.length).not.toBe(hashCacheKey("anything").length);
  });
});

// The `Closeable` interface is re-exported for callers; this no-op
// reference keeps the import meaningful to the type checker.
const _typecheck: Closeable = { close: () => {} };
void _typecheck;
