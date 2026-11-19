import { describe, expect, it } from "vitest";
import type { SourcePrimaries, YCbCrMatrix } from "../decoder/ffprobeColorSpace";
import {
  BT601, BT709, DISPLAY_GAMMA, coefForMatrix, columnMajor, displayRgb, inverseCoef, linearBt709, primariesToBt709,
  type CodeScale, type Mat3,
} from "./colourConversion";
import golden from "./colourConversionGolden.fixture.json";

// Shared with the decode crate's `color.rs`: the two implementations of the
// owned conversion are held to one list of numbers.

const SCALE: Record<string, CodeScale> = {
  "8 limited": { yOffset: 16, yScale: 219, cScale: 224, chromaZero: 128 },
  "8 full": { yOffset: 0, yScale: 255, cScale: 255, chromaZero: 128 },
  "10 limited": { yOffset: 64, yScale: 876, cScale: 896, chromaZero: 512 },
  "10 full": { yOffset: 0, yScale: 1023, cScale: 1023, chromaZero: 512 },
};
const scaleOf = (bits: number, fullRange: boolean) => SCALE[`${bits} ${fullRange ? "full" : "limited"}`]!;

const MATRICES: readonly YCbCrMatrix[] = ["bt709", "smpte170m", "bt470bg", "bt2020-ncl"];
const PRIMARIES: readonly SourcePrimaries[] = ["bt709", "smpte170m", "bt470bg", "bt2020"];

describe("matrix coefficients", () => {
  it("are the golden Kr/Kb and shader coefficients for every implemented matrix", () => {
    expect(golden.matrices.map((m) => m.matrix).sort()).toEqual([...MATRICES].sort());
    for (const m of golden.matrices) {
      const coef = coefForMatrix(m.matrix as YCbCrMatrix);
      expect([coef.kr, coef.kb], m.matrix).toEqual([m.kr, m.kb]);
      inverseCoef(coef).forEach((v, i) => expect(v, `${m.matrix}[${i}]`).toBeCloseTo(m.inverse[i]!, 12));
    }
  });

  it("gives the two BT.601 names one set and BT.2020 its own", () => {
    expect(coefForMatrix("smpte170m")).toBe(BT601);
    expect(coefForMatrix("bt470bg")).toBe(BT601);
    expect(coefForMatrix("bt709")).toBe(BT709);
    expect(coefForMatrix("bt2020-ncl")).not.toEqual(BT709);
  });
});

describe("primaries conversions", () => {
  it("are the golden matrices, and BT.709 converts nothing", () => {
    expect(golden.primaries.map((p) => p.primaries).sort()).toEqual([...PRIMARIES].sort());
    for (const p of golden.primaries) {
      const m = primariesToBt709(p.primaries as SourcePrimaries);
      if (p.toBt709 === null) {
        expect(m, p.primaries).toBeNull();
        continue;
      }
      m!.forEach((row, r) => row.forEach((v, c) => expect(v, `${p.primaries}[${r}][${c}]`).toBeCloseTo(p.toBt709![r]![c]!, 12)));
    }
  });

  it("matches the BT.2020 → BT.709 matrix published in ITU-R BT.2087", () => {
    // BT.2087-0 eq. for the linear RGB conversion, given to four decimals.
    const published = [
      [1.6605, -0.5876, -0.0728],
      [-0.1246, 1.1329, -0.0083],
      [-0.0182, -0.1006, 1.1187],
    ];
    const m = primariesToBt709("bt2020")!;
    m.forEach((row, r) => row.forEach((v, c) => expect(Math.abs(v - published[r]![c]!)).toBeLessThanOrEqual(5e-5)));
  });

  it("keeps white white: every row sums to one", () => {
    for (const p of PRIMARIES) {
      const m = primariesToBt709(p);
      if (!m) continue;
      for (const row of m) expect(row[0] + row[1] + row[2], p).toBeCloseTo(1, 12);
    }
  });

  it("is uploaded column-major, the way a shader's mat3 * vec3 reads it", () => {
    const m: Mat3 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    const cm = columnMajor(m);
    // GLSL / WGSL: (M * v)[r] = Σc M[c][r] * v[c], M[c] the c-th uploaded column.
    const v = [0.5, -2, 3];
    const shader = [0, 1, 2].map((r) => [0, 1, 2].reduce((sum, c) => sum + cm[3 * c + r]! * v[c]!, 0));
    expect(shader).toEqual(m.map((row) => row[0] * v[0]! + row[1] * v[1]! + row[2] * v[2]!));
  });
});

describe("displayRgb (CPU reference of the ingest shaders)", () => {
  it("shows the golden colours for every golden conversion", () => {
    expect(golden.conversions.length).toBeGreaterThan(0);
    expect(golden.displayGamma).toBe(DISPLAY_GAMMA);
    for (const c of golden.conversions) {
      const got = displayRgb(c.codes as [number, number, number], {
        matrix: c.matrix as YCbCrMatrix, primaries: c.primaries as SourcePrimaries, fullRange: c.fullRange,
      }, scaleOf(c.bits, c.fullRange));
      got.forEach((v, i) => expect(v, `${c.id}[${i}]`).toBeCloseTo(c.rgb[i]!, 9));
    }
  });

  it("leaves greys unchanged through every primaries conversion", () => {
    for (const bits of [8, 10]) {
      const scale = scaleOf(bits, false);
      for (let y = scale.yOffset; y <= scale.yOffset + scale.yScale; y += bits === 8 ? 1 : 4) {
        const codes = [y, scale.chromaZero, scale.chromaZero] as const;
        const plain = displayRgb(codes, { matrix: "bt2020-ncl", primaries: "bt709", fullRange: false }, scale);
        for (const primaries of PRIMARIES) {
          const got = displayRgb(codes, { matrix: "bt2020-ncl", primaries, fullRange: false }, scale);
          got.forEach((v, i) => expect(v, `${primaries} ${bits}-bit Y=${y}`).toBeCloseTo(plain[i]!, 9));
        }
      }
    }
  });

  it("puts each BT.2020 primary outside the BT.709 gamut and clips it there per channel", () => {
    const primaries = golden.conversions.filter((c) => /^bt2020 (red|green|blue),/.test(c.id));
    expect(primaries).toHaveLength(6);
    const toBt709 = primariesToBt709("bt2020")!;
    for (const c of primaries) {
      const conversion = { matrix: "bt2020-ncl" as const, primaries: "bt709" as const, fullRange: c.fullRange };
      const rgb = displayRgb(c.codes as [number, number, number], conversion, scaleOf(c.bits, c.fullRange));
      const linear = linearBt709(rgb, toBt709);
      // Outside: some channel below 0 or above 1 before the clip.
      expect(linear.some((v) => v < 0 || v > 1), c.id).toBe(true);
      // Clipped per channel in linear light, then encoded.
      const clipped = linear.map((v) => Math.min(1, Math.max(0, v)) ** (1 / DISPLAY_GAMMA));
      const shown = displayRgb(c.codes as [number, number, number], { ...conversion, primaries: "bt2020" }, scaleOf(c.bits, c.fullRange));
      shown.forEach((v, i) => expect(v, `${c.id}[${i}]`).toBeCloseTo(clipped[i]!, 12));
    }
  });

  it("converts a BT.709 source by its matrix alone", () => {
    // YCbCr -> R'G'B' and the final clip, nothing else.
    const matrixOnly = (codes: readonly number[], scale: CodeScale) => {
      const [crR, cbG, crG, cbB] = inverseCoef(BT709);
      const y = (codes[0]! - scale.yOffset) / scale.yScale;
      const cb = (codes[1]! - scale.chromaZero) / scale.cScale;
      const cr = (codes[2]! - scale.chromaZero) / scale.cScale;
      return [y + crR * cr, y - crG * cr - cbG * cb, y + cbB * cb].map((v) => Math.min(1, Math.max(0, v)));
    };
    const scale = scaleOf(8, false);
    for (let y = 0; y < 256; y += 15) {
      for (let cb = 0; cb < 256; cb += 17) {
        for (let cr = 0; cr < 256; cr += 17) {
          const codes = [y, cb, cr] as const;
          expect(displayRgb(codes, { matrix: "bt709", primaries: "bt709", fullRange: false }, scale))
            .toEqual(matrixOnly(codes, scale));
        }
      }
    }
  });
});
