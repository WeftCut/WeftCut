// The numbers of the owned YCbCr → display conversion: matrix coefficients,
// primaries conversions, the display transfer, and a CPU reference of the
// ingest shaders (`PlaneIngest`). Which matrix and primaries a frame converts
// with is the rule's (`planeConversion`). Twin of the decode crate's
// `color.rs`; both are held to `colourConversionGolden.fixture.json`.

import type { PlaneConversion, SourcePrimaries, YCbCrMatrix } from "../decoder/ffprobeColorSpace";

export interface YuvCoef {
  /// Kr, Kb of the matrix (Kg = 1 − Kr − Kb).
  kr: number;
  kb: number;
}
export const BT709: YuvCoef = { kr: 0.2126, kb: 0.0722 };
export const BT601: YuvCoef = { kr: 0.299, kb: 0.114 };
/// BT.2020 non-constant luminance.
export const BT2020_NCL: YuvCoef = { kr: 0.2627, kb: 0.0593 };

const COEF: Record<YCbCrMatrix, YuvCoef> = {
  bt709: BT709,
  smpte170m: BT601,
  bt470bg: BT601,
  "bt2020-ncl": BT2020_NCL,
};

export function coefForMatrix(matrix: YCbCrMatrix): YuvCoef {
  return COEF[matrix];
}

/// Shader coefficients [crR, cbG, crG, cbB]: R = Y + crR·Cr,
/// G = Y − crG·Cr − cbG·Cb, B = Y + cbB·Cb.
export function inverseCoef(c: YuvCoef): [number, number, number, number] {
  const kg = 1 - c.kr - c.kb;
  const crR = 2 * (1 - c.kr);
  const cbB = 2 * (1 - c.kb);
  return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
}

type Vec3 = readonly [number, number, number];
/// Row-major 3x3.
export type Mat3 = readonly [Vec3, Vec3, Vec3];
type Xy = readonly [number, number];

/// CIE xy chromaticities of red, green and blue. Every one of these standards
/// uses the D65 white below.
const CHROMATICITIES: Record<SourcePrimaries, readonly [Xy, Xy, Xy]> = {
  // ITU-R BT.709.
  bt709: [[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]],
  // ITU-R BT.2020.
  bt2020: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]],
  // ITU-R BT.470 System B/G (EBU Tech 3213), BT.601 625 lines.
  bt470bg: [[0.640, 0.330], [0.290, 0.600], [0.150, 0.060]],
  // SMPTE 170M (SMPTE C), BT.601 525 lines.
  smpte170m: [[0.630, 0.340], [0.310, 0.595], [0.155, 0.070]],
};
const D65: Xy = [0.3127, 0.3290];

const xyz = ([x, y]: Xy): Vec3 => [x / y, 1, (1 - x - y) / y];

function invert(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const apply = (m: Mat3, v: Vec3): [number, number, number] => {
  const row = ([a, b, c]: Vec3) => a * v[0] + b * v[1] + c * v[2];
  return [row(m[0]), row(m[1]), row(m[2])];
};

const transpose = ([[a, b, c], [d, e, f], [g, h, i]]: Mat3): Mat3 => [[a, d, g], [b, e, h], [c, f, i]];

function multiply(a: Mat3, b: Mat3): Mat3 {
  const bt = transpose(b);
  return transpose([apply(a, bt[0]), apply(a, bt[1]), apply(a, bt[2])]);
}

/// Linear RGB in `p` → CIE XYZ: the primaries' XYZ columns scaled so RGB white
/// lands on D65.
function rgbToXyz(p: SourcePrimaries): Mat3 {
  const [r, g, b] = CHROMATICITIES[p];
  const m = transpose([xyz(r), xyz(g), xyz(b)]);
  const [sr, sg, sb] = apply(invert(m), xyz(D65));
  const scale = ([x, y, z]: Vec3): Vec3 => [x * sr, y * sg, z * sb];
  return [scale(m[0]), scale(m[1]), scale(m[2])];
}

const TO_BT709 = new Map<SourcePrimaries, Mat3 | null>();

/// The matrix taking linear RGB in `p` to linear BT.709 RGB, or `null` for
/// BT.709 itself, whose frames take no primaries step at all.
export function primariesToBt709(p: SourcePrimaries): Mat3 | null {
  if (!TO_BT709.has(p)) {
    TO_BT709.set(p, p === "bt709" ? null : multiply(invert(rgbToXyz("bt709")), rgbToXyz(p)));
  }
  return TO_BT709.get(p)!;
}

/// The display transfer both ways around the primaries conversion: BT.1886's
/// pure 2.4 power, for every SDR source. The conversion is display-referred
/// (the picture as an SDR display shows it, re-shown in BT.709 primaries);
/// inverting the camera OETF instead would change the tone of every converted
/// picture. HDR frames never reach the step (`planeConversion`).
export const DISPLAY_GAMMA = 2.4;

/// `m` as the shaders' `mat3` / `mat3x3<f32>` take it: column-major.
export function columnMajor(m: Mat3): Float32Array {
  return new Float32Array(transpose(m).flat());
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/// The primaries step on R'G'B' in [0, 1], before the clip: linear BT.709 RGB,
/// outside [0, 1] where the colour lies outside the BT.709 gamut.
export function linearBt709([r, g, b]: Vec3, toBt709: Mat3): [number, number, number] {
  const linear = (v: number) => clamp01(v) ** DISPLAY_GAMMA;
  return apply(toBt709, [linear(r), linear(g), linear(b)]);
}

/// The range constants an ingest lane normalises code values with
/// (`IngestLayout`).
export interface CodeScale {
  readonly yOffset: number;
  readonly yScale: number;
  readonly cScale: number;
  readonly chromaZero: number;
}

/// CPU reference of the ingest shaders: (Y, Cb, Cr) code values → displayed
/// BT.709 R'G'B' in [0, 1]. Out-of-gamut colours clip per channel in linear
/// light.
export function displayRgb(codes: Vec3, conversion: PlaneConversion, scale: CodeScale): [number, number, number] {
  const [crR, cbG, crG, cbB] = inverseCoef(coefForMatrix(conversion.matrix));
  const y = (codes[0] - scale.yOffset) / scale.yScale;
  const cb = (codes[1] - scale.chromaZero) / scale.cScale;
  const cr = (codes[2] - scale.chromaZero) / scale.cScale;
  const rgb: Vec3 = [y + crR * cr, y - crG * cr - cbG * cb, y + cbB * cb];
  const toBt709 = primariesToBt709(conversion.primaries);
  if (!toBt709) return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  const [r, g, b] = linearBt709(rgb, toBt709);
  const encode = (v: number) => clamp01(v) ** (1 / DISPLAY_GAMMA);
  return [encode(r), encode(g), encode(b)];
}
