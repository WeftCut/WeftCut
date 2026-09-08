import { describe, it, expect, vi } from "vitest";
import {
  createAnimatedImageCache,
  imageMimeFor,
  naturalScale,
  type DecodedAnimation,
  type DecodeFn,
} from "./animatedImageCache";

describe("naturalScale", () => {
  it("maps a composition-capped frame back to the source size", () => {
    // A 1920×1080 source decoded onto a 640×360 composition: the sprite must
    // render the 640-wide frame 3× so that layer scale 1/3 shows 640×360, not
    // 213×120 — the shrink that put the sharpen smoke's sample points on empty
    // canvas.
    expect(naturalScale({ width: 640, height: 360, naturalWidth: 1920, naturalHeight: 1080 })).toEqual({ kx: 3, ky: 3 });
  });

  it("is the identity for an uncapped frame and for degenerate sizes", () => {
    expect(naturalScale({ width: 320, height: 240, naturalWidth: 320, naturalHeight: 240 })).toEqual({ kx: 1, ky: 1 });
    expect(naturalScale({ width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 })).toEqual({ kx: 1, ky: 1 });
  });
});

describe("imageMimeFor", () => {
  const GIF = "weftcut-media://localhost/C%3A%5Cclips%5Cloop.gif";

  it("keeps a definite image type from the response", () => {
    expect(imageMimeFor("image/webp", GIF)).toBe("image/webp");
  });

  it("falls back to the extension for an empty, generic or error-page type", () => {
    // application/octet-stream is what weftcut-media:// sends for an extension
    // it does not know; ImageDecoder rejects it as firmly as an empty type, and
    // trusting it froze every animated GIF to its first frame.
    for (const type of ["", "application/octet-stream", "text/html"]) {
      expect(imageMimeFor(type, GIF), type || "(empty)").toBe("image/gif");
    }
  });

  it("yields empty when neither side knows, so the caller fails loudly", () => {
    expect(imageMimeFor("application/octet-stream", "weftcut-media://localhost/frame.bin")).toBe("");
  });
});

/// A fake decoded animation whose "bitmaps" record close() calls.
function fakeAnimation(): DecodedAnimation {
  const mk = () => ({ close: vi.fn(), width: 4, height: 4 }) as unknown as ImageBitmap;
  return { frames: [mk(), mk()], durationsUs: [100_000, 100_000], totalUs: 200_000, width: 4, height: 4, naturalWidth: 4, naturalHeight: 4 };
}

describe("createAnimatedImageCache", () => {
  it("decodes once per key and shares the result (single-flight)", async () => {
    const decode: DecodeFn = vi.fn(async () => fakeAnimation());
    const cache = createAnimatedImageCache(decode);
    const [a, b] = await Promise.all([
      cache.acquire("k", "url", 10, 10),
      cache.acquire("k", "url", 10, 10),
    ]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("closes every frame when the last reference is released", async () => {
    const anim = fakeAnimation();
    const decode: DecodeFn = vi.fn(async () => anim);
    const cache = createAnimatedImageCache(decode);
    await cache.acquire("k", "url", 10, 10);
    await cache.acquire("k", "url", 10, 10); // refs = 2
    cache.release("k"); // refs = 1, not yet closed
    expect(anim.frames[0]!.close).not.toHaveBeenCalled();
    cache.release("k"); // refs = 0, closed + evicted
    expect(anim.frames[0]!.close).toHaveBeenCalledTimes(1);
    expect(anim.frames[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("re-decodes after full eviction", async () => {
    const decode: DecodeFn = vi.fn(async () => fakeAnimation());
    const cache = createAnimatedImageCache(decode);
    await cache.acquire("k", "url", 10, 10);
    cache.release("k");
    await cache.acquire("k", "url", 10, 10);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("closes frames if released before decode resolves (no leak)", async () => {
    const anim = fakeAnimation();
    let resolve!: (a: DecodedAnimation) => void;
    const decode: DecodeFn = vi.fn(
      () => new Promise<DecodedAnimation>((r) => { resolve = r; }),
    );
    const cache = createAnimatedImageCache(decode);
    const p = cache.acquire("k", "url", 10, 10);
    cache.release("k"); // released while decode is still in flight
    resolve(anim);
    await p;
    expect(anim.frames[0]!.close).toHaveBeenCalledTimes(1);
  });
});
