import { describe, it, expect } from "vitest";
import {
  asVideoColorSpace, isRgbCoded, nativePlaneColor, planeConversion, resolveSourceColor, undeclaredIsHd,
} from "./ffprobeColorSpace";
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
    // Matrices no owned conversion implements read as an untagged source's.
    for (const color_matrix of ["bt2020c", "smpte240m", "ycgco", "ictcp", "fcc"]) {
      expect(resolveSourceColor({ width: 720, height: 480, color_matrix }), color_matrix)
        .toMatchObject({ matrix: "smpte170m", matrixAssumed: true });
      expect(resolveSourceColor({ width: 1920, height: 1080, color_matrix }), color_matrix)
        .toMatchObject({ matrix: "bt709", matrixAssumed: true });
    }
    expect(resolveSourceColor({ width: 720, height: 480, color_primaries: "smpte432", color_transfer: "linear" }))
      .toMatchObject({ primaries: "smpte170m", transfer: "smpte170m" });
  });

  it("reads a BT.2020 SDR source as BT.2020, its transfer as the BT.709 curve", () => {
    for (const color_transfer of ["bt2020-10", "bt2020-12", "bt709"]) {
      expect(resolveSourceColor({
        width: 1920, height: 1080,
        color_matrix: "bt2020nc", color_primaries: "bt2020", color_transfer, color_range: "tv",
      }), color_transfer).toEqual({
        matrix: "bt2020-ncl", primaries: "bt2020", transfer: "bt709", fullRange: false, matrixAssumed: false,
      });
    }
  });

  it("names an HDR transfer, which the owned conversions leave alone", () => {
    expect(resolveSourceColor({
      width: 3840, height: 2160, color_matrix: "bt2020nc", color_primaries: "bt2020", color_transfer: "smpte2084",
    })).toMatchObject({ matrix: "bt2020-ncl", primaries: "bt2020", transfer: "pq" });
    expect(resolveSourceColor({ width: 3840, height: 2160, color_transfer: "arib-std-b67" }).transfer).toBe("hlg");
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

describe("planeConversion", () => {
  const hd = (tags: Record<string, string>) => resolveSourceColor({ width: 1920, height: 1080, ...tags });

  it("converts declared BT.2020 and EBU primaries into BT.709, with the source's own matrix and range", () => {
    for (const color_range of ["tv", "pc"]) {
      expect(planeConversion(hd({ color_matrix: "bt2020nc", color_primaries: "bt2020", color_transfer: "bt2020-10", color_range })))
        .toEqual({ matrix: "bt2020-ncl", primaries: "bt2020", fullRange: color_range === "pc" });
      expect(planeConversion(resolveSourceColor({
        width: 720, height: 576, color_matrix: "bt470bg", color_primaries: "bt470bg", color_transfer: "smpte170m", color_range,
      }))).toEqual({ matrix: "bt470bg", primaries: "bt470bg", fullRange: color_range === "pc" });
    }
  });

  it("gives declared SMPTE C primaries no primaries step, as the WebCodecs lanes give them none", () => {
    expect(planeConversion(hd({ color_matrix: "smpte170m", color_primaries: "smpte170m", color_transfer: "smpte170m" })))
      .toEqual({ matrix: "smpte170m", primaries: "bt709", fullRange: false });
    expect(planeConversion(resolveSourceColor({
      width: 720, height: 480, color_matrix: "smpte170m", color_primaries: "smpte170m", color_range: "tv",
    }))).toEqual({ matrix: "smpte170m", primaries: "bt709", fullRange: false });
  });

  it("never converts the primaries of a source that declares none, at any size", () => {
    for (const c of golden.cases) {
      const conversion = planeConversion(resolveSourceColor({ width: c.width, height: c.height }));
      expect(conversion.primaries, `${c.width}x${c.height}`).toBe("bt709");
    }
    expect(planeConversion(resolveSourceColor({ width: 720, height: 480 })))
      .toEqual({ matrix: "smpte170m", primaries: "bt709", fullRange: false });
  });

  it("converts a declared BT.2020 matrix as BT.2020 whatever the primaries", () => {
    for (const color_primaries of [undefined, "bt709", "smpte170m", "bt2020"]) {
      const tags: Record<string, string> = { color_matrix: "bt2020nc", color_transfer: "bt2020-10" };
      if (color_primaries) tags.color_primaries = color_primaries;
      expect(planeConversion(hd(tags)).matrix, String(color_primaries)).toBe("bt2020-ncl");
    }
  });

  it("converts an RGB-coded source's planes as BT.709 limited, in the source's primaries", () => {
    const rgb = resolveSourceColor({ width: 1920, height: 1080, pix_fmt: "gbrp", color_primaries: "bt470bg" });
    expect(planeConversion(nativePlaneColor(rgb))).toEqual({ matrix: "bt709", primaries: "bt470bg", fullRange: false });
  });

  it("converts an HDR source with BT.709 coefficients and no primaries step", () => {
    for (const color_transfer of ["smpte2084", "arib-std-b67"]) {
      const c = resolveSourceColor({
        width: 3840, height: 2160, color_matrix: "bt2020nc", color_primaries: "bt2020", color_transfer,
      });
      expect(planeConversion(c), color_transfer).toEqual({ matrix: "bt709", primaries: "bt709", fullRange: false });
    }
    // Any other matrix it keeps.
    expect(planeConversion({ matrix: "smpte170m", primaries: "bt2020", transfer: "pq" }).matrix).toBe("smpte170m");
  });

  it("converts a stamp naming nothing it implements as BT.709", () => {
    expect(planeConversion(null)).toEqual({ matrix: "bt709", primaries: "bt709", fullRange: false });
    expect(planeConversion({ matrix: "rgb", primaries: "smpte432", transfer: "linear", fullRange: true }))
      .toEqual({ matrix: "bt709", primaries: "bt709", fullRange: true });
  });
});

describe("asVideoColorSpace", () => {
  it("hands WebCodecs the same names, the wide-gamut ones included", () => {
    const c = resolveSourceColor({ width: 1920, height: 1080, color_matrix: "bt2020nc", color_primaries: "bt2020" });
    expect(asVideoColorSpace(c)).toEqual({ matrix: "bt2020-ncl", primaries: "bt2020", transfer: "bt709", fullRange: false });
  });
});
