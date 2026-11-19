// RGB → 10-bit limited-range YCbCr, the reference the pack shader
// (PackYuv420p10) is parity-tested against. Display-referred: NO transfer
// math here (ADR 0014: working space = gamma 709). The way back is the ingest
// reference, `displayRgb` (yuv/colourConversion.ts).

import type { YuvCoef } from "../yuv/colourConversion";

// GLSL twin: clamp(floor(x + 0.5), 0.0, 1023.0) — NOT round(), whose .5
// behavior is implementation-defined in GLSL ES. Math.round ≡ floor(x+0.5).
const clamp10 = (x: number) => Math.min(1023, Math.max(0, Math.round(x)));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/// r/g/b: gamma-encoded [0,1] (clamped). Returns 10-bit LIMITED-range codes (Y 64–940, C 64–960), clamped to [0,1023].
export function rgbToYuv10(
  r: number,
  g: number,
  b: number,
  c: YuvCoef,
): [number, number, number] {
  const kg = 1 - c.kr - c.kb;
  const y = c.kr * clamp01(r) + kg * clamp01(g) + c.kb * clamp01(b);
  const cb = (clamp01(b) - y) / (2 * (1 - c.kb));
  const cr = (clamp01(r) - y) / (2 * (1 - c.kr));
  return [clamp10(64 + 876 * y), clamp10(512 + 896 * cb), clamp10(512 + 896 * cr)];
}

/// CPU reference of the pack shader's byte layout: two samples per RGBA8
/// texel, u16LE each.
export function packTwoSamples(
  a10: number,
  b10: number,
): [number, number, number, number] {
  return [a10 & 255, a10 >> 8, b10 & 255, b10 >> 8];
}
