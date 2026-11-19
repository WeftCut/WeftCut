import { describe, it, expect } from "vitest";
import { resolveSourceColor } from "./ffprobeColorSpace";

const BT601 = { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m" };
const BT709 = { primaries: "bt709", transfer: "bt709", matrix: "bt709" };

describe("resolveSourceColor", () => {
  it("reads an untagged SD original as SMPTE 170M, limited", () => {
    expect(resolveSourceColor({ height: 480 })).toEqual({ ...BT601, fullRange: false, matrixAssumed: true });
  });

  it("reads an untagged HD original as BT.709, limited", () => {
    expect(resolveSourceColor({ height: 1080 })).toEqual({ ...BT709, fullRange: false, matrixAssumed: true });
  });

  it("splits SD from HD at 720 lines of the original", () => {
    expect(resolveSourceColor({ height: 719 }).matrix).toBe("smpte170m");
    expect(resolveSourceColor({ height: 720 }).matrix).toBe("bt709");
  });

  it("reads an original of unknown height as HD", () => {
    expect(resolveSourceColor({ height: null }).matrix).toBe("bt709");
  });

  it("keeps every tag the source carries, whatever its height", () => {
    expect(resolveSourceColor({
      height: 1080,
      color_matrix: "smpte170m", color_primaries: "bt470bg", color_transfer: "smpte170m", color_range: "tv",
    })).toEqual({
      matrix: "smpte170m", primaries: "bt470bg", transfer: "smpte170m", fullRange: false, matrixAssumed: false,
    });
    expect(resolveSourceColor({
      height: 480,
      color_matrix: "bt709", color_primaries: "bt709", color_transfer: "bt709", color_range: "pc",
    })).toEqual({ ...BT709, fullRange: true, matrixAssumed: false });
  });

  it("fills only the fields a partial tag set leaves out", () => {
    expect(resolveSourceColor({ height: 480, color_matrix: "bt709" }))
      .toEqual({
        matrix: "bt709", primaries: "smpte170m", transfer: "smpte170m", fullRange: false, matrixAssumed: false,
      });
    expect(resolveSourceColor({ height: 1080, color_range: "pc" }))
      .toEqual({ ...BT709, fullRange: true, matrixAssumed: true });
    expect(resolveSourceColor({ height: 1080, color_range: "tv", color_matrix: null }))
      .toEqual({ ...BT709, fullRange: false, matrixAssumed: true });
  });

  it("treats a value it cannot map as absent", () => {
    // HDR/wide-gamut names have no lib.dom WebCodecs enum (SDR-only mapping).
    expect(resolveSourceColor({ height: 2160, color_matrix: "bt2020nc", color_transfer: "smpte2084" }))
      .toEqual({ ...BT709, fullRange: false, matrixAssumed: true });
    expect(resolveSourceColor({ height: 480, color_matrix: "fcc" }).matrix).toBe("smpte170m");
  });

  it("maps ffprobe's gbr matrix to WebCodecs rgb", () => {
    expect(resolveSourceColor({ height: 1080, color_matrix: "gbr" }).matrix).toBe("rgb");
  });
});
