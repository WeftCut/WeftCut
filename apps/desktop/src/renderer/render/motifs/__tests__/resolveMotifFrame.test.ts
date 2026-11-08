import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMotifFrameRequests, resolveMotifFrame, sharedBakedKeyIndex, sharedMotifFrameCache } from "../motifRasterCache";
import { captureMotifFrameResult } from "../host";
import { hashCacheKey } from "../../../../shared/motifs/cacheKey";

vi.mock("../host", () => ({ captureMotifFrameResult: vi.fn() }));
vi.mock("../frameTransport", async importOriginal => ({
  ...await importOriginal<typeof import("../frameTransport")>(), controlStoredMotifCapture: vi.fn(),
}));

const motif = { manifest: { id: "countdown", size: [480, 480] } } as unknown as Parameters<typeof resolveMotifFrame>[0];
const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;

describe("resolveMotifFrame", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
  });
  afterEach(() => {
    resetMotifFrameRequests();
    sharedBakedKeyIndex.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("captures an unsaved frame at manifest size with the composition fps and its cache address", async () => {
    const live = bitmap();
    vi.mocked(captureMotifFrameResult).mockResolvedValue({ bitmap: live, persisted: false, scaleDiv: "live" });
    const got = await resolveMotifFrame(motif, "k-not-baked", 7, 2.5, { seconds: 5 }, "sprite", 30000, 1001);
    expect(got).toMatchObject({ persisted: false, scaleDiv: "live" });
    expect(createImageBitmap).toHaveBeenCalledExactlyOnceWith(live);
    expect(captureMotifFrameResult).toHaveBeenCalledExactlyOnceWith("countdown", 2.5, { seconds: 5 }, 480, 480,
      undefined, 30000, 1001, expect.objectContaining({ scaleDiv: 1, cache: { hash: hashCacheKey("k-not-baked"), frame: 7 } }));
  });

  it("an on-demand frame waits for restoration and reads the saved pixels without capture", async () => {
    const saved = bitmap();
    const read = vi.spyOn(sharedMotifFrameCache, "readBitmap").mockResolvedValue(saved);
    sharedBakedKeyIndex.beginHydration();
    const pending = resolveMotifFrame(motif, "restored", 0, 0, { seconds: 5 }, "sprite");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).not.toHaveBeenCalled();
    sharedBakedKeyIndex.restoreFrames("restored", new Set([0]));
    sharedBakedKeyIndex.finishHydration();
    expect(await pending).toMatchObject({ persisted: true, scaleDiv: 1 });
    expect(createImageBitmap).toHaveBeenCalledExactlyOnceWith(saved);
    expect(read).toHaveBeenCalledExactlyOnceWith("restored", 0, 1);
    expect(captureMotifFrameResult).not.toHaveBeenCalled();
  });
});
