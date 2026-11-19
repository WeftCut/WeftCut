// A media's decode colour: its ffprobe tags mapped to WebCodecs enums, with
// every absent field filled by one rule (`resolveSourceColor`). Every decode
// lane takes its colour from here and none has a fallback of its own.
export interface FfprobeColor {
  color_matrix?: string | null;
  color_range?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
}

/// The YCbCr matrices the owned conversions implement, by WebCodecs name
/// (`coefForMatrix`). BT.601 has two names, one per line count.
export type YCbCrMatrix = "bt709" | "smpte170m" | "bt470bg" | "bt2020-ncl";

/// The primaries the owned conversions convert from (`primariesToBt709`).
export type SourcePrimaries = "bt709" | "smpte170m" | "bt470bg" | "bt2020";

/// The transfers the rule reads: the SDR ones (all the BT.709 curve, and
/// sRGB) and the two HDR ones, which no owned conversion handles
/// (`planeConversion`).
export type SourceTransfer = "bt709" | "smpte170m" | "iec61966-2-1" | "pq" | "hlg";

/// A complete colour description: every field set, so a lane never has to
/// pick a value of its own. WebCodecs names; lib.dom's unions lack the
/// wide-gamut and HDR ones Chromium accepts (`asVideoColorSpace`).
export interface SourceColor {
  primaries: SourcePrimaries;
  transfer: SourceTransfer;
  matrix: YCbCrMatrix | "rgb";
  fullRange: boolean;
  /// The source declares no matrix, or one the rule does not map; `matrix`
  /// is the rule's. Hardware
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

// ffprobe names → WebCodecs names. An unmapped value counts as absent, so the
// size rule fills it: a matrix no owned conversion implements (constant-
// luminance BT.2020, ICtCp, YCgCo, SMPTE 240M) reads as the matrix an
// untagged source of that size has, and `matrixAssumed` says so. Refusing
// such a source would leave it unplayable for the sake of matrices that are
// rare (SMPTE 240M is obsolete; constant-luminance BT.2020 and ICtCp come with
// HDR transfers no lane converts).
const MATRIX: Record<string, YCbCrMatrix | "rgb"> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
  bt2020nc: "bt2020-ncl",
  rgb: "rgb",
  gbr: "rgb",
};
const PRIMARIES: Record<string, SourcePrimaries> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
  bt2020: "bt2020",
};
const TRANSFER: Record<string, SourceTransfer> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  // BT.2020's SDR transfers are the BT.709 curve at higher precision.
  "bt2020-10": "bt709",
  "bt2020-12": "bt709",
  "iec61966-2-1": "iec61966-2-1",
  smpte2084: "pq",
  "arib-std-b67": "hlg",
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

/// `c` for a WebCodecs API: the same names, which lib.dom's unions do not all
/// carry (`bt2020-ncl`, `bt2020`, `pq`, `hlg`) though Chromium accepts them.
export function asVideoColorSpace(c: SourceColor): {
  primaries: VideoColorPrimaries;
  transfer: VideoTransferCharacteristics;
  matrix: VideoMatrixCoefficients;
  fullRange: boolean;
} {
  return {
    primaries: c.primaries as VideoColorPrimaries,
    transfer: c.transfer as VideoTransferCharacteristics,
    matrix: c.matrix as VideoMatrixCoefficients,
    fullRange: c.fullRange,
  };
}

/// A frame's colour as its producer stamped it: a native frame carries
/// `nativePlaneColor`, a WebCodecs-decoded 10-bit frame what Chromium
/// reports (`copyToTenBit`), which can be any name or none.
export interface ColourStamp {
  readonly matrix?: string | null;
  readonly primaries?: string | null;
  readonly transfer?: string | null;
  readonly fullRange?: boolean | null;
}

/// What an owned conversion (the ingest shaders, the d3d11va shader) does to
/// a frame's planes: YCbCr → R'G'B' with `matrix` and `fullRange`, then, when
/// `primaries` is not BT.709, a conversion into BT.709 primaries.
export interface PlaneConversion {
  matrix: YCbCrMatrix;
  primaries: SourcePrimaries;
  fullRange: boolean;
}

const YCBCR_MATRICES: ReadonlySet<string> = new Set<YCbCrMatrix>(["bt709", "smpte170m", "bt470bg", "bt2020-ncl"]);
/// The primaries whose frames take the primaries step: only those Chromium
/// converts on the WebCodecs lanes too (its 2D `drawImage`, observed on macOS
/// and Windows), so converting them brings the lanes together: within 4–5
/// steps on BT.2020, within 12–13 on EBU, where Chromium re-encodes with the
/// sRGB curve and this step with BT.1886.
///
/// LANDMINE: `smpte170m` (SMPTE C) is left out on purpose and only for now,
/// not because it equals BT.709: Chromium leaves it alone, so converting it on
/// the native lanes alone would part them from the WebCodecs lanes by up to
/// ~48 steps on common SD material. It joins this set when the WebCodecs
/// lanes stop delegating colour to Chromium. Primaries the rule fills in for
/// an untagged source are only ever `bt709` or `smpte170m`, so an untagged
/// source never takes the step; lifting this exclusion must keep that true.
const CONVERTED_PRIMARIES: ReadonlySet<string> = new Set<SourcePrimaries>(["bt470bg", "bt2020"]);
const HDR_TRANSFERS: ReadonlySet<string> = new Set<SourceTransfer>(["pq", "hlg"]);

/// The one decision of how an owned conversion converts a frame stamped `c`:
/// its own matrix and range, and the primaries step for the primaries in
/// `CONVERTED_PRIMARIES`, BT.709 (no step) for any other. The matrix does not
/// depend on the primaries: a BT.2020 matrix converts as BT.2020 whatever
/// they are. Two further cases:
///
/// - An HDR transfer (PQ, HLG) is out of scope: no lane tone-maps, so its
///   frames take no primaries step and a BT.2020 matrix converts with BT.709
///   coefficients. The right matrix without a tone map would change its
///   colours without making them right.
/// - A stamp naming a matrix no conversion implements, or none, converts as
///   BT.709: only Chromium's stamp on a WebCodecs-decoded 10-bit frame can
///   carry one, and BT.709 is the working space that lane has always fallen
///   back to.
export function planeConversion(c: ColourStamp | null | undefined): PlaneConversion {
  const fullRange = c?.fullRange === true;
  const matrix = implemented<YCbCrMatrix>(YCBCR_MATRICES, c?.matrix) ?? "bt709";
  if (HDR_TRANSFERS.has(c?.transfer ?? "")) {
    return { matrix: matrix === "bt2020-ncl" ? "bt709" : matrix, primaries: "bt709", fullRange };
  }
  const primaries = implemented<SourcePrimaries>(CONVERTED_PRIMARIES, c?.primaries) ?? "bt709";
  return { matrix, primaries, fullRange };
}

function implemented<T extends string>(names: ReadonlySet<string>, name: string | null | undefined): T | undefined {
  return name && names.has(name) ? (name as T) : undefined;
}

function mapped<T>(table: Record<string, T>, tag: string | null | undefined): T | undefined {
  return tag ? table[tag] : undefined;
}
