// `getPerfSnapshot().motifReader`: the document's Motif frame reader stats
// plus the preview divisor, read without ever creating the reader.
import { Container, type Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Compositor } from "./Compositor";
import type { DecoderPool } from "./decoder/session";
import type { MotifReaderStats } from "./motifs/MotifFrameReader";

const { current, create } = vi.hoisted(() => ({ current: vi.fn(), create: vi.fn() }));
vi.mock("./motifs/MotifFrameReader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./motifs/MotifFrameReader")>()),
  currentMotifFrameReader: current,
  motifFrameReader: create,
}));

const fakeStats: MotifReaderStats = {
  reads: { texture: 12, utility: 30 },
  misses: 4,
  fallbacks: 2,
  transportFailures: 1,
  restarts: 1,
  stages: { readMs: 1.5, decodeMs: 3, hashMs: 0.25, scaleMs: 2, uploadMs: null, importMs: null, bitmapMs: 0.5 },
};

describe("Compositor perf snapshot: motifReader", () => {
  let compositor: Compositor;

  beforeEach(() => {
    vi.clearAllMocks();
    // `setPlaybackScaleDiv` schedules a repaint; node has no rAF.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920, height: 1080, mode: "export",
      originalAssetUrl: () => null, sourceColor: () => undefined, mediaById: () => undefined,
      pool: { dispose: vi.fn() } as unknown as DecoderPool,
    });
  });
  afterEach(() => {
    compositor.dispose();
    vi.unstubAllGlobals();
  });

  it("reports zeros and nulls before the first read, without creating the reader", () => {
    current.mockReturnValue(null);
    expect(compositor.getPerfSnapshot().motifReader).toEqual({
      reads: { texture: 0, utility: 0 },
      misses: 0,
      fallbacks: 0,
      transportFailures: 0,
      restarts: 0,
      stages: { readMs: null, decodeMs: null, hashMs: null, scaleMs: null, uploadMs: null, importMs: null, bitmapMs: null },
      scaleDiv: 1,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("reports the existing reader's stats and the current divisor", () => {
    current.mockReturnValue({ stats: fakeStats });
    compositor.setPlaybackScaleDiv(2);
    expect(compositor.getPerfSnapshot().motifReader).toEqual({ ...fakeStats, scaleDiv: 2 });
    expect(create).not.toHaveBeenCalled();
  });
});
