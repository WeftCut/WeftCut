import { describe, expect, it } from "vitest";
import type { MediaSummary } from "../ipc";
import { EXPORT_DECODE_ENGINES } from "./exportSettings";
import {
  hwExportDecodeAllowed,
  proxyWaitScope,
  resolveExportDecodeRouting,
  routingSourceCounts,
  takesTenBitLane,
  type ExportRoutingInputs,
} from "./exportDecodeRouting";

// The setting × component × route × bit-depth matrix for the export decode
// resolver (docs/render.md §Export source resolution). Mirrors
// resolveDecodeEngine.test.ts's base-factory shape.

type Route = MediaSummary["decode_route"];
const ROUTES = {
  bypass: { route: "bypass" },
  "direct-export": { route: "direct-export", quick_proxy: null },
  proxied: {
    route: "proxied",
    quick_proxy: null,
    full_proxy: "C:\\proxies\\m.mp4",
    format_version: 7,
  },
  "native-sw": {
    route: "native-sw",
    quick_proxy: null,
    full_proxy: null,
    format_version: 7,
  },
} satisfies Record<string, Route>;

function vid(
  id: string,
  route: keyof typeof ROUTES,
  over: Partial<MediaSummary> = {},
): MediaSummary {
  return {
    id,
    label: id,
    path: `C:\\media\\${id}.mov`,
    kind: "Video",
    duration_us: 10_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 1,
    available: true,
    decode_route: ROUTES[route],
    codec: "prores",
    pix_fmt: "yuv422p10le",
    ...over,
  } as MediaSummary;
}

function base(over: Partial<ExportRoutingInputs> = {}): ExportRoutingInputs {
  return {
    setting: "auto",
    componentAvailable: true,
    bitDepth: 8,
    media: [vid("m1", "native-sw")],
    ...over,
  };
}

describe("resolveExportDecodeRouting", () => {
  it("auto + component: blind-spot (native-sw) routes native on the original", () => {
    const r = resolveExportDecodeRouting(base());
    expect(r.effectiveSetting).toBe("auto");
    expect(r.outFormat).toBe("NV12");
    expect(r.routes["m1"]).toEqual({
      engine: "native",
      sourcePath: "C:\\media\\m1.mov",
    });
  });

  it("auto + component: decodable routes stay in-worker WebCodecs", () => {
    const r = resolveExportDecodeRouting(
      base({
        media: [vid("b", "bypass"), vid("d", "direct-export"), vid("p", "proxied")],
      }),
    );
    expect(r.routes["b"]).toEqual({ engine: "webcodecs" });
    expect(r.routes["d"]).toEqual({ engine: "webcodecs" });
    // "proxied" = neither engine opens the original — full-proxy fallback.
    expect(r.routes["p"]).toEqual({ engine: "webcodecs" });
  });

  it("auto without the component: blind-spot falls back to the proxy path", () => {
    const r = resolveExportDecodeRouting(base({ componentAvailable: false }));
    expect(r.effectiveSetting).toBe("auto");
    expect(r.routes["m1"]).toEqual({ engine: "webcodecs" });
  });

  it("ffmpeg pin + component: EVERY source routes native", () => {
    const r = resolveExportDecodeRouting(
      base({
        setting: "ffmpeg",
        media: [
          vid("b", "bypass"),
          vid("d", "direct-export"),
          vid("p", "proxied"),
          vid("n", "native-sw"),
        ],
      }),
    );
    expect(r.effectiveSetting).toBe("ffmpeg");
    for (const id of ["b", "d", "p", "n"]) {
      expect(r.routes[id]).toMatchObject({ engine: "native" });
    }
    expect(r.routes["b"]).toMatchObject({ sourcePath: "C:\\media\\b.mov" });
  });

  it("ffmpeg pin without the component degrades to auto", () => {
    const r = resolveExportDecodeRouting(
      base({
        setting: "ffmpeg",
        componentAvailable: false,
        media: [vid("n", "native-sw"), vid("d", "direct-export")],
      }),
    );
    expect(r.effectiveSetting).toBe("auto");
    expect(r.routes["n"]).toEqual({ engine: "webcodecs" });
    expect(r.routes["d"]).toEqual({ engine: "webcodecs" });
  });

  it("webcodecs pin: today's behavior exactly — blind-spot via proxy", () => {
    const r = resolveExportDecodeRouting(base({ setting: "webcodecs" }));
    expect(r.effectiveSetting).toBe("webcodecs");
    expect(r.routes["m1"]).toEqual({ engine: "webcodecs" });
  });

  it("transport format follows the composite bit depth", () => {
    expect(resolveExportDecodeRouting(base()).outFormat).toBe("NV12");
    expect(resolveExportDecodeRouting(base({ bitDepth: 10 })).outFormat).toBe("I420P10");
  });

  it("10-bit exports route native over the I420P10 transport (auto AND ffmpeg pin)", () => {
    const auto = resolveExportDecodeRouting(base({ bitDepth: 10 }));
    expect(auto.outFormat).toBe("I420P10");
    expect(auto.routes["m1"]).toEqual({
      engine: "native",
      sourcePath: "C:\\media\\m1.mov",
    });
    const pinned = resolveExportDecodeRouting(base({ bitDepth: 10, setting: "ffmpeg" }));
    expect(pinned.routes["m1"]).toEqual({
      engine: "native",
      sourcePath: "C:\\media\\m1.mov",
    });
    expect(pinned.effectiveSetting).toBe("ffmpeg");
  });

  it("non-video media get no table entry", () => {
    const audio = vid("a", "bypass", { kind: "Audio", codec: null, pix_fmt: null });
    const r = resolveExportDecodeRouting(base({ media: [audio] }));
    expect(r.routes["a"]).toBeUndefined();
  });

  it("a video with no original path falls back to webcodecs", () => {
    const r = resolveExportDecodeRouting(base({ media: [vid("m1", "native-sw", { path: "" })] }));
    expect(r.routes["m1"]).toEqual({ engine: "webcodecs" });
  });
});

// The temporary HDR policy (hdrTakesWebCodecs): an HDR source exports through
// one decode engine whatever the setting says.
describe("HDR sources take one export decode engine", () => {
  const HDR = ["smpte2084", "arib-std-b67"];
  const WEBCODECS_DECODABLE = ["bypass", "direct-export", "proxied"] as const;
  const DEPTHS = [8, 10] as const;

  it("an HDR source WebCodecs can decode takes the WebCodecs engine under every setting and depth", () => {
    for (const setting of EXPORT_DECODE_ENGINES) for (const bitDepth of DEPTHS) {
      for (const transfer of HDR) for (const route of WEBCODECS_DECODABLE) {
        const r = resolveExportDecodeRouting(
          base({ setting, bitDepth, media: [vid("h", route, { color_transfer: transfer })] }),
        );
        expect(r.routes["h"], `${transfer} ${route} under ${setting} at ${bitDepth}-bit`)
          .toEqual({ engine: "webcodecs" });
      }
    }
  });

  it("an HDR source WebCodecs cannot decode keeps the route an SDR one gets", () => {
    for (const setting of EXPORT_DECODE_ENGINES) for (const bitDepth of DEPTHS) {
      for (const componentAvailable of [true, false]) for (const transfer of HDR) {
        const path = "C:\\media\\clip.mov";
        const hdr = vid("h", "native-sw", { path, color_transfer: transfer });
        const sdr = vid("s", "native-sw", { path, color_transfer: "bt709" });
        const r = resolveExportDecodeRouting(
          base({ setting, bitDepth, componentAvailable, media: [hdr, sdr] }),
        );
        expect(r.routes["h"], `${transfer} under ${setting}`).toEqual(r.routes["s"]);
      }
    }
  });

  it("an SDR source is not affected: the ffmpeg pin still decodes it native", () => {
    for (const transfer of ["bt709", "smpte170m", "bt2020-10", null]) {
      for (const route of WEBCODECS_DECODABLE) {
        const r = resolveExportDecodeRouting(
          base({ setting: "ffmpeg", media: [vid("s", route, { color_transfer: transfer })] }),
        );
        expect(r.routes["s"], `${transfer} ${route}`).toEqual({
          engine: "native",
          sourcePath: "C:\\media\\s.mov",
        });
      }
    }
  });
});

// The bit-depth half of the temporary HDR policy: the 10-bit lane would pass an
// HDR source's code values through, so an HDR source never takes it.
describe("takesTenBitLane", () => {
  const TEN_BIT_CAPABLE = [
    { codec: "h264", pix_fmt: "yuv420p10le" },
    { codec: "av1", pix_fmt: "yuv420p10le" },
  ];

  it("an HDR source that could take the 10-bit lane does not", () => {
    for (const shape of TEN_BIT_CAPABLE) for (const transfer of ["smpte2084", "arib-std-b67"]) {
      const m = vid("h", "proxied", { ...shape, color_transfer: transfer });
      expect(takesTenBitLane(m), `${shape.codec} ${transfer}`).toBe(false);
    }
  });

  it("an SDR 10-bit H.264 or AV1 source still takes it", () => {
    for (const shape of TEN_BIT_CAPABLE) for (const transfer of ["bt709", "bt2020-10", null]) {
      const m = vid("s", "proxied", { ...shape, color_transfer: transfer });
      expect(takesTenBitLane(m), `${shape.codec} ${transfer}`).toBe(true);
    }
  });
});

describe("proxyWaitScope", () => {
  it("drops native-routed media from the readiness gate's scope", () => {
    const media = [vid("n", "native-sw"), vid("d", "direct-export"), vid("p", "proxied")];
    const routing = resolveExportDecodeRouting(base({ media }));
    expect(proxyWaitScope(media, routing).map((m) => m.id)).toEqual(["d", "p"]);
  });

  it("keeps everything when nothing routes native (webcodecs pin keeps today's wait)", () => {
    const media = [vid("n", "native-sw"), vid("p", "proxied")];
    const routing = resolveExportDecodeRouting(base({ setting: "webcodecs", media }));
    expect(proxyWaitScope(media, routing).map((m) => m.id)).toEqual(["n", "p"]);
  });
});

// The dialog's routing-summary counts — semantics live on routingSourceCounts.
describe("routingSourceCounts", () => {
  const ALL = [
    vid("b", "bypass"),
    vid("d", "direct-export"),
    vid("p", "proxied"),
    vid("n", "native-sw"),
  ];

  it("auto + component: only 'proxied' feeds from the lossy proxy", () => {
    const routing = resolveExportDecodeRouting(base({ media: ALL }));
    // b/d decode originals in-worker, n decodes the original natively; only
    // p (neither engine opens it) exports off its full proxy.
    expect(routingSourceCounts(ALL, routing)).toEqual({ originals: 3, proxy: 1 });
  });

  it("webcodecs pin: blind spots join 'proxied' on the lossy-proxy side", () => {
    const routing = resolveExportDecodeRouting(base({ setting: "webcodecs", media: ALL }));
    expect(routingSourceCounts(ALL, routing)).toEqual({ originals: 2, proxy: 2 });
  });

  it("auto without the component: blind spots count as proxy-fed", () => {
    const media = [vid("n", "native-sw")];
    const routing = resolveExportDecodeRouting(
      base({ componentAvailable: false, media }),
    );
    expect(routingSourceCounts(media, routing)).toEqual({ originals: 0, proxy: 1 });
  });

  it("ffmpeg pin: every source counts as originals", () => {
    const routing = resolveExportDecodeRouting(base({ setting: "ffmpeg", media: ALL }));
    expect(routingSourceCounts(ALL, routing)).toEqual({ originals: 4, proxy: 0 });
  });

  it("non-video media are not counted", () => {
    const audio = vid("a", "bypass", { kind: "Audio", codec: null, pix_fmt: null });
    const media = [audio, vid("v", "bypass")];
    const routing = resolveExportDecodeRouting(base({ media }));
    expect(routingSourceCounts(media, routing)).toEqual({ originals: 1, proxy: 0 });
  });
});

// Why the allowlist exists: see the doc comment on `hwExportDecodeAllowed`.
describe("hwExportDecodeAllowed", () => {
  it("allows hardware decode on Windows and macOS only", () => {
    expect(hwExportDecodeAllowed("windows")).toBe(true);
    expect(hwExportDecodeAllowed("mac")).toBe(true);
    expect(hwExportDecodeAllowed("linux")).toBe(false);
  });
});
