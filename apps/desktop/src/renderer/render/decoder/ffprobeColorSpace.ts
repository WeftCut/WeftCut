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

/// What the rule reads off a `MediaSummary`: the ffprobe tags, the ORIGINAL's
/// probed size and its pixel format.
export interface SourceColorProbe extends FfprobeColor {
  width: number | null;
  height: number | null;
  pix_fmt?: string | null;
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

/// Whether an ffmpeg pixel format holds RGB (or palette) samples rather than
/// YCbCr: packed (`rgb24`, `bgra`, `x2rgb10le`), planar (`gbrp`) and
/// palettised. `VideoStreamMeta::is_rgb_pix_fmt` in the native crate is the
/// same test for the ffmpeg jobs; both are held to
/// `undeclaredColourGolden.fixture.json`.
export function isRgbCoded(pixFmt: string | null | undefined): boolean {
  if (!pixFmt) return false;
  return pixFmt.includes("rgb") || pixFmt.includes("bgr") || pixFmt.startsWith("gbr") || pixFmt === "pal8";
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
/// An RGB-coded original (`isRgbCoded`, or tagged `gbr`) has matrix `rgb` and
/// full range whatever its tags say: its samples are RGB, so the pixel format
/// declares it.
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
  const matrix = isRgbCoded(media.pix_fmt) ? "rgb" : mapped(MATRIX, media.color_matrix);
  return {
    primaries: mapped(PRIMARIES, media.color_primaries) ?? absent,
    transfer: mapped(TRANSFER, media.color_transfer) ?? absent,
    matrix: matrix ?? absent,
    fullRange: matrix === "rgb" || media.color_range === "pc",
    matrixAssumed: matrix === undefined,
  };
}

/// Whether an ffprobe transfer tag is an HDR one: PQ (`smpte2084`) or HLG
/// (`arib-std-b67`). No decode lane converts HDR itself; export decode routing
/// sends such a source to one engine (`exportDecodeRouting.ts`).
export function isHdrTransfer(transfer: string | null | undefined): boolean {
  return transfer === "smpte2084" || transfer === "arib-std-b67";
}

/// The YCbCr an RGB-coded source's frames become in WeftCut's own native
/// decode: BT.709, limited range.
const RGB_PLANE_COLOR = { matrix: "bt709", fullRange: false } as const;

/// The colour of the YCbCr planes the native decode lanes (the software pack,
/// the copy-back hardware lanes, d3d11va, native export decode) deliver for a
/// source of colour `c`: its own for a YCbCr source, `RGB_PLANE_COLOR` for an
/// RGB-coded one. Each lane is handed this value when it opens and its frames
/// are read back with the same value, so the two cannot disagree.
export function nativePlaneColor(c: SourceColor): SourceColor {
  return c.matrix === "rgb" ? { ...c, ...RGB_PLANE_COLOR } : c;
}

function mapped<T>(table: Record<string, T>, tag: string | null | undefined): T | undefined {
  return tag ? table[tag] : undefined;
}
