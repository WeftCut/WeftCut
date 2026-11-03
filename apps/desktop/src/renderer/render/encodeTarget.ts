// The EncodeTarget resolution seam (see docs/render.md §"Encode exits").
// Pure: the host's WebGL verdict is injected (`rendererCapability.ts`).

import { isIntermediateCodec, type ExportSettings, type WebCodecsCodecId } from "./exportSettings";

export type NativePixFmt = "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";

export interface WebCodecsTarget {
  engine: "webcodecs";
  /// Codec the worker's VideoEncoder actually encodes. Never a ProRes/DNxHR
  /// intermediate — those are native-only.
  workerCodec: WebCodecsCodecId;
}

export interface NativeTarget {
  engine: "native";
  /// rawvideo format the worker packs and the ffmpeg sink consumes.
  pixFmt: NativePixFmt;
}

export type EncodeTarget = WebCodecsTarget | NativeTarget;

/// rawvideo format the native sink consumes for these settings: ProRes →
/// yuv422p10le, DNxHR → yuv422p, everything else follows `bitDepth`.
export function nativePixFmtFor(settings: ExportSettings): NativePixFmt {
  if (settings.codec === "prores") return "yuv422p10le";
  if (settings.codec === "dnxhr") return "yuv422p";
  return settings.bitDepth === 10 ? "yuv420p10le" : "yuv420p";
}

/// The encoder a job runs on THIS host, or why none can. The native sink's
/// pack pass is a GL shader, so native needs WebGL (`RendererCapability.webgl`).
/// `auto` is native wherever WebGL exists and WebCodecs where it does not, for
/// the combos WebCodecs encodes (8-bit H.264/HEVC/AV1 at a bitrate). A
/// `webcodecs` pin is WebCodecs everywhere; a `native` pin, an intermediate, a
/// 10-bit or a constant-quality export has no path on a host without WebGL.
/// Chosen before anything runs, so the engine never swaps mid-export.
export type EncodeResolution = EncodeTarget | { engine: "unavailable" };

export function resolveEncodeTarget(settings: ExportSettings, webgl: boolean): EncodeResolution {
  const webcodecs = !isIntermediateCodec(settings.codec) &&
    (settings.encoderEngine === "webcodecs" ||
      (!webgl && settings.encoderEngine === "auto" && settings.bitDepth === 8 && settings.rateMode !== "quality"));
  // The cast is sound: `webcodecs` excludes the intermediates, so the codec
  // is a WebCodecsCodecId here.
  if (webcodecs) return { engine: "webcodecs", workerCodec: settings.codec as WebCodecsCodecId };
  if (!webgl) return { engine: "unavailable" };
  return { engine: "native", pixFmt: nativePixFmtFor(settings) };
}
