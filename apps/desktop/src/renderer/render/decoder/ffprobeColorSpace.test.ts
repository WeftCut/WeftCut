import { describe, it, expect } from "vitest";
import { isRgbCoded, nativePlaneColor, resolveSourceColor, undeclaredIsHd } from "./ffprobeColorSpace";
import golden from "./undeclaredColourGolden.fixture.json";

const BT601 = { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m" };
const BT709 = { primaries: "bt709", transfer: "bt709", matrix: "bt709" };

describe("resolveSourceColor", () => {
  it("reads an untagged SD original as SMPTE 170M, limited", () => {
    expect(resolveSourceColor({ width: 720, height: 480 })).toEqual({ ...BT601, fullRange: false, matrixAssumed: true });
  });

  it("reads an untagged HD original as BT.709, limited", () => {
    expect(resolveSourceColor({ width: 1920, height: 1080 })).toEqual({ ...BT709, fullRange: false, matrixAssumed: true });
  });

  it("splits SD from HD by the original's size, as the shared golden says", () => {
    expect(golden.cases.length).toBeGreaterThan(0);
    for (const c of golden.cases) {
      expect(undeclaredIsHd(c.width, c.height), `${c.width}x${c.height}`).toBe(c.hd);
      expect(resolveSourceColor({ width: c.width, height: c.height }).matrix, `${c.width}x${c.height}`)
        .toBe(c.hd ? "bt709" : "smpte170m");
    }
  });

  it("keeps a cropped HD picture HD", () => {
    expect(resolveSourceColor({ width: 1280, height: 544 }).matrix).toBe("bt709");
    expect(resolveSourceColor({ width: 1920, height: 800 }).matrix).toBe("bt709");
  });

  it("reads an original of unknown size as HD", () => {
    expect(resolveSourceColor({ width: null, height: null }).matrix).toBe("bt709");
    expect(resolveSourceColor({ width: 720, height: null }).matrix).toBe("bt709");
    expect(resolveSourceColor({ width: null, height: 480 }).matrix).toBe("bt709");
  });

  it("keeps every tag the source carries, whatever its height", () => {
    expect(resolveSourceColor({
      width: 1920, height: 1080,
      color_matrix: "smpte170m", color_primaries: "bt470bg", color_transfer: "smpte170m", color_range: "tv",
    })).toEqual({
      matrix: "smpte170m", primaries: "bt470bg", transfer: "smpte170m", fullRange: false, matrixAssumed: false,
    });
    expect(resolveSourceColor({
      width: 720, height: 480,
      color_matrix: "bt709", color_primaries: "bt709", color_transfer: "bt709", color_range: "pc",
    })).toEqual({ ...BT709, fullRange: true, matrixAssumed: false });
  });

  it("fills only the fields a partial tag set leaves out", () => {
    expect(resolveSourceColor({ width: 720, height: 480, color_matrix: "bt709" }))
      .toEqual({
        matrix: "bt709", primaries: "smpte170m", transfer: "smpte170m", fullRange: false, matrixAssumed: false,
      });
    expect(resolveSourceColor({ width: 1920, height: 1080, color_range: "pc" }))
      .toEqual({ ...BT709, fullRange: true, matrixAssumed: true });
    expect(resolveSourceColor({ width: 1920, height: 1080, color_range: "tv", color_matrix: null }))
      .toEqual({ ...BT709, fullRange: false, matrixAssumed: true });
  });

  it("treats a value it cannot map as absent", () => {
    // HDR/wide-gamut names have no lib.dom WebCodecs enum (SDR-only mapping).
    expect(resolveSourceColor({ width: 3840, height: 2160, color_matrix: "bt2020nc", color_transfer: "smpte2084" }))
      .toEqual({ ...BT709, fullRange: false, matrixAssumed: true });
    expect(resolveSourceColor({ width: 720, height: 480, color_matrix: "fcc" }).matrix).toBe("smpte170m");
  });

  it("maps ffprobe's gbr matrix to WebCodecs rgb", () => {
    expect(resolveSourceColor({ width: 1920, height: 1080, color_matrix: "gbr" }).matrix).toBe("rgb");
  });

  it("reads an RGB-coded original as rgb, full range, from its pixel format whatever its tags say", () => {
    const tagged = resolveSourceColor({ width: 1920, height: 1080, pix_fmt: "gbrp", color_matrix: "gbr", color_range: "pc" });
    const untagged = resolveSourceColor({ width: 1920, height: 1080, pix_fmt: "rgb24" });
    const mistagged = resolveSourceColor({ width: 720, height: 480, pix_fmt: "rgb24", color_matrix: "smpte170m", color_range: "tv" });
    for (const c of [tagged, untagged, mistagged]) {
      expect(c).toMatchObject({ matrix: "rgb", fullRange: true, matrixAssumed: false });
    }
    // Untagged primaries and transfer still follow the size rule.
    expect(untagged).toMatchObject({ primaries: "bt709", transfer: "bt709" });
    expect(mistagged).toMatchObject({ primaries: "smpte170m", transfer: "smpte170m" });
  });

  it("tells RGB-coded pixel formats from YCbCr ones, as the shared golden says", () => {
    expect(golden.pixFmts.length).toBeGreaterThan(0);
    for (const c of golden.pixFmts) expect(isRgbCoded(c.pix_fmt), c.pix_fmt).toBe(c.rgb);
    expect(isRgbCoded(null)).toBe(false);
  });
});

describe("nativePlaneColor", () => {
  it("is a YCbCr source's own colour", () => {
    for (const c of [
      resolveSourceColor({ width: 720, height: 480 }),
      resolveSourceColor({ width: 1920, height: 1080, color_matrix: "bt470bg", color_range: "pc" }),
    ]) expect(nativePlaneColor(c)).toEqual(c);
  });

  it("gives an RGB-coded source's planes a YCbCr matrix and keeps its primaries and transfer", () => {
    const rgb = resolveSourceColor({ width: 720, height: 480, pix_fmt: "gbrp", color_matrix: "gbr" });
    const planes = nativePlaneColor(rgb);
    expect(planes.matrix).not.toBe("rgb");
    expect(["bt709", "smpte170m", "bt470bg"]).toContain(planes.matrix);
    expect(planes).toMatchObject({ primaries: rgb.primaries, transfer: rgb.transfer });
  });
});
