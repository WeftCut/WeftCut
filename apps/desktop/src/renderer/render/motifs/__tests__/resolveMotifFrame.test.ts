import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../motifRaster", () => ({ rasterMotifFrame: vi.fn(async () => ({ id: "cdp" }) as unknown as ImageBitmap) }));
import { rasterMotifFrame } from "../motifRaster";
import { resolveMotifFrame, sharedBakedKeyIndex, sharedMotifFrameCache } from "../motifRasterCache";
import { MotifTransportError } from "../frameTransport";

const motif = { manifest: { id: "countdown", size: [480, 480], settle_rafs: 2 } } as unknown as Parameters<typeof resolveMotifFrame>[0];

describe("resolveMotifFrame → Motif CDP", () => {
  beforeEach(() => (rasterMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear());

  it("on a non-baked key, produces the frame via rasterMotifFrame with id, manifest size + settle_rafs", async () => {
    expect(sharedBakedKeyIndex.has("k-not-baked")).toBe(false);
    const bmp = await resolveMotifFrame(motif, "k-not-baked", 7, 2.5, 5, { seconds: 5 });
    expect(rasterMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480, 2, undefined, undefined, undefined, undefined);
    expect(bmp).toEqual({ bitmap: { id: "cdp" }, persisted: false, scaleDiv: "live" });
  });

  it("forwards the composition fps so meta.fps matches the rate tSec was computed on", async () => {
    await resolveMotifFrame(motif, "k-not-baked", 7, 2.5, 5, { seconds: 5 }, undefined, 30000, 1001);
    expect(rasterMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480, 2, undefined, undefined, 30000, 1001);
  });

  it("an on-demand frame waits for restoration and reads the saved pixels without capture", async () => {
    const saved = { id: "saved" } as unknown as ImageBitmap;
    const read = vi.spyOn(sharedMotifFrameCache, "readBitmap").mockResolvedValue(saved);
    sharedBakedKeyIndex.beginHydration();
    try {
      const pending = resolveMotifFrame(motif, "restored", 0, 0, 5, { seconds: 5 });
      await Promise.resolve();
      expect(rasterMotifFrame).not.toHaveBeenCalled();
      sharedBakedKeyIndex.restoreFrames("restored", new Set([0]));
      sharedBakedKeyIndex.finishHydration();
      expect(await pending).toEqual({ bitmap: saved, persisted: true, scaleDiv: 1 });
      expect(rasterMotifFrame).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledWith("restored", 0, 1);
    } finally {
      sharedBakedKeyIndex.clear();
      read.mockRestore();
    }
  });

  it("reads at the preview divisor; a miss captures, a transport error does not", async () => {
    const saved = { id: "half" } as unknown as ImageBitmap;
    const read = vi.spyOn(sharedMotifFrameCache, "readBitmap").mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(null).mockRejectedValueOnce(new MotifTransportError("utility", "timeout"));
    sharedBakedKeyIndex.restoreFrames("saved", new Set([0, 1, 2]));
    try {
      const at = (frame: number) => resolveMotifFrame(motif, "saved", frame, 0, 5, {}, undefined, undefined, undefined, false, "foreground", 2);
      expect(await at(0)).toEqual({ bitmap: saved, persisted: true, scaleDiv: 2 });
      expect(await at(1)).toEqual({ bitmap: { id: "cdp" }, persisted: false, scaleDiv: "live" });
      await expect(at(2)).rejects.toBeInstanceOf(MotifTransportError);
      expect(rasterMotifFrame).toHaveBeenCalledTimes(1);
      expect(read.mock.calls).toEqual([["saved", 0, 2], ["saved", 1, 2], ["saved", 2, 2]]);
    } finally {
      sharedBakedKeyIndex.clear();
      read.mockRestore();
    }
  });
});
