// A media's decode colour: its ffprobe tags mapped to WebCodecs enums, with
// every absent field filled by one rule (`resolveSourceColor`). Every decode
// lane takes its colour from here and none has a fallback of its own.
export interface FfprobeColor {
  color_matrix?: string | null;
  color_range?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
}

/// A complete colour description: every field set, so a lane never has to
/// pick a value of its own. Assignable to `VideoColorSpaceInit`.
export interface SourceColor {
  primaries: VideoColorPrimaries;
  transfer: VideoTransferCharacteristics;
  matrix: VideoMatrixCoefficients;
  fullRange: boolean;
}

/// What the rule reads off a `MediaSummary`: the ffprobe tags and the
/// ORIGINAL's probed height.
export interface SourceColorProbe extends FfprobeColor {
  height: number | null;
}

/// Originals shorter than this read an absent tag as SMPTE 170M (BT.601),
/// the rest as BT.709.
const HD_MIN_HEIGHT = 720;

// SDR-only mapping: TS's lib.dom WebCodecs unions carry no HDR/wide-gamut enum
// values, and such sources are 10-bit and take WeftCut's proxy path anyway.
// Unmapped values count as absent.
const MATRIX: Record<string, VideoMatrixCoefficients> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
  rgb: "rgb",
  gbr: "rgb",
};
const PRIMARIES: Record<string, VideoColorPrimaries> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
};
const TRANSFER: Record<string, VideoTransferCharacteristics> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  "iec61966-2-1": "iec61966-2-1",
};

/// The colour every lane decodes `media` with. Per field: the mapped ffprobe
/// tag when there is one; otherwise SMPTE 170M below 720 lines and BT.709 at
/// or above, and limited range.
///
/// Keyed on the ORIGINAL's probed height, never a decode target's or a
/// frame's: a proxy or a downscaled preview frame of the same source must
/// resolve the same colour. An unknown height reads as HD.
///
/// The SD/HD split is a convention, not what every tool does: ffmpeg/swscale
/// read an unspecified matrix as BT.601 at every size, so the colour gates
/// hand the analyzer the intended matrix explicitly (docs/conformance.md).
export function resolveSourceColor(media: SourceColorProbe): SourceColor {
  const absent = media.height !== null && media.height < HD_MIN_HEIGHT ? "smpte170m" : "bt709";
  return {
    primaries: mapped(PRIMARIES, media.color_primaries) ?? absent,
    transfer: mapped(TRANSFER, media.color_transfer) ?? absent,
    matrix: mapped(MATRIX, media.color_matrix) ?? absent,
    fullRange: media.color_range === "pc",
  };
}

function mapped<T>(table: Record<string, T>, tag: string | null | undefined): T | undefined {
  return tag ? table[tag] : undefined;
}
