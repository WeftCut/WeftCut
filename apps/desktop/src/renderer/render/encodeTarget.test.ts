import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "./exportSettings";
import { resolveEncodeTarget } from "./encodeTarget";

const s = (over: Partial<ExportSettings>): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  ...over,
});

describe("resolveEncodeTarget on a host with WebGL", () => {
  it("webcodecs pin → WebCodecs direct", () => {
    expect(resolveEncodeTarget(s({ codec: "h264", encoderEngine: "webcodecs" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "h264",
    });
    expect(resolveEncodeTarget(s({ codec: "av1", encoderEngine: "webcodecs" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "av1",
    });
  });

  it("10-bit HEVC/AV1 → native sink yuv420p10le", () => {
    for (const codec of ["hevc", "av1"] as const) {
      expect(resolveEncodeTarget(s({ codec, bitDepth: 10 }), true)).toEqual({ engine: "native", pixFmt: "yuv420p10le" });
    }
  });

  it("native pin → native sink with bit-depth-matched pixFmt", () => {
    expect(resolveEncodeTarget(s({ codec: "h264", encoderEngine: "native" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(resolveEncodeTarget(s({ codec: "hevc", bitDepth: 10, encoderEngine: "native" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p10le" });
  });

  it("auto prefers native for every codec", () => {
    expect(resolveEncodeTarget(s({ codec: "h264" }), true)).toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(resolveEncodeTarget(s({ codec: "hevc" }), true)).toEqual({ engine: "native", pixFmt: "yuv420p" });
  });

  it("intermediates route native with 422 formats", () => {
    expect(resolveEncodeTarget(s({ codec: "prores", bitDepth: 10, container: "mov" }), true)).toEqual({ engine: "native", pixFmt: "yuv422p10le" });
    expect(resolveEncodeTarget(s({ codec: "dnxhr", container: "mov" }), true)).toEqual({ engine: "native", pixFmt: "yuv422p" });
  });
});

describe("resolveEncodeTarget on a host without WebGL (L8, L12)", () => {
  it("auto picks WebCodecs for an 8-bit bitrate export of a WebCodecs codec", () => {
    expect(resolveEncodeTarget(s({ codec: "h264" }), false)).toEqual({ engine: "webcodecs", workerCodec: "h264" });
    expect(resolveEncodeTarget(s({ codec: "hevc", rateMode: "cbr" }), false)).toEqual({ engine: "webcodecs", workerCodec: "hevc" });
  });

  it("a webcodecs pin stays WebCodecs", () => {
    expect(resolveEncodeTarget(s({ codec: "av1", encoderEngine: "webcodecs" }), false)).toEqual({ engine: "webcodecs", workerCodec: "av1" });
  });

  it("what only the native sink encodes has no path", () => {
    for (const st of [
      s({ codec: "h264", encoderEngine: "native" }),
      s({ codec: "hevc", bitDepth: 10 }),
      s({ codec: "h264", rateMode: "quality" }),
      s({ codec: "prores", bitDepth: 10, container: "mov" }),
      s({ codec: "dnxhr", container: "mov" }),
    ]) expect(resolveEncodeTarget(st, false)).toEqual({ engine: "unavailable" });
  });
});
