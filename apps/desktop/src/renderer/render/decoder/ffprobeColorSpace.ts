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
  /// The source declares no matrix; `matrix` is the rule's. Hardware
  /// WebCodecs decoders need to know (`decodesInSoftwareForColour`).
  matrixAssumed: boolean;
}

/// What the rule reads off a `MediaSummary`: the ffprobe tags and the
/// ORIGINAL's probed size.
export interface SourceColorProbe extends FfprobeColor {
  width: number | null;
  height: number | null;
}

/// An original that declares no colour is HD (BT.709) when it is at least this
/// wide or taller than `SD_MAX_HEIGHT`, and SD (SMPTE 170M) otherwise. Width
/// counts so that a cropped HD picture (1280x544, 1920x800) stays HD.
const HD_MIN_WIDTH = 1280;
const SD_MAX_HEIGHT = 576;

/// Whether an original of this size that declares no colour reads as HD. An
/// unknown size reads as HD. `VideoStreamMeta::undeclared_is_hd` in the native
/// crate is the same rule for the ffmpeg jobs; both are held to
/// `undeclaredColourGolden.fixture.json`.
export function undeclaredIsHd(width: number | null, height: number | null): boolean {
  if (width === null || height === null) return true;
  return width >= HD_MIN_WIDTH || height > SD_MAX_HEIGHT;
}

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
/// tag when there is one; otherwise BT.709 for an HD original and SMPTE 170M
/// for an SD one (`undeclaredIsHd`), and limited range.
///
/// Keyed on the ORIGINAL's probed size, never a decode target's or a
/// frame's: a proxy or a downscaled preview frame of the same source must
/// resolve the same colour.
///
/// The SD/HD split is a convention, not what every tool does: ffmpeg/swscale
/// read an unspecified matrix as BT.601 at every size, so the colour gates
/// hand the analyzer the intended matrix explicitly (docs/conformance.md).
export function resolveSourceColor(media: SourceColorProbe): SourceColor {
  const absent = undeclaredIsHd(media.width, media.height) ? "bt709" : "smpte170m";
  const matrix = mapped(MATRIX, media.color_matrix);
  return {
    primaries: mapped(PRIMARIES, media.color_primaries) ?? absent,
    transfer: mapped(TRANSFER, media.color_transfer) ?? absent,
    matrix: matrix ?? absent,
    fullRange: media.color_range === "pc",
    matrixAssumed: matrix === undefined,
  };
}

function mapped<T>(table: Record<string, T>, tag: string | null | undefined): T | undefined {
  return tag ? table[tag] : undefined;
}
