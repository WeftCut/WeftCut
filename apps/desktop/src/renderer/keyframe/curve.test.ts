import { describe, expect, it } from "vitest";
import {
  EXTRAPOLATE_MODES, EXTRAP_GLYPH_GAP_PX, coeffToHandle, extrapolateClass, extrapolateGlyph,
  extrapolateLabelKey, handleToCoeff, interpGlyphClass, interpToCoeffs,
} from "./curve";
import en from "../i18n/locales/en-US";

describe("interpGlyphClass", () => {
  it("codes the segment class the NLE way: square = Hold, bare diamond = Linear, circle = every eased class", () => {
    expect(interpGlyphClass("Hold")).toBe("kf-interp-hold");
    expect(interpGlyphClass("Linear")).toBe("");
    expect(interpGlyphClass("Spline")).toBe("kf-interp-eased");
    expect(interpGlyphClass("Elastic")).toBe("kf-interp-eased");
    expect(interpGlyphClass("Bounce")).toBe("kf-interp-eased");
  });
});

describe("extrapolation marks", () => {
  it("lists the five modes with Hold first, and Hold alone draws no glyph", () => {
    expect(EXTRAPOLATE_MODES).toEqual(["Hold", "Loop", "PingPong", "Offset", "Continue"]);
    expect(extrapolateGlyph("Hold")).toBe("");
    expect(EXTRAPOLATE_MODES.filter((m) => m !== "Hold").map(extrapolateGlyph)).toEqual(["↻", "↔", "⤴", "→"]);
  });
  it("spells a mode one way in the class and the i18n key, and every key resolves", () => {
    for (const mode of EXTRAPOLATE_MODES) {
      const cls = extrapolateClass(mode);
      expect(cls.startsWith("kf-extrap kf-extrap-")).toBe(true);
      const id = cls.slice("kf-extrap kf-extrap-".length);
      expect(extrapolateLabelKey(mode)).toBe(`keyframe.extrapolate_${id}`);
      expect(typeof (en.keyframe as Record<string, unknown>)[`extrapolate_${id}`]).toBe("string");
    }
    expect(extrapolateClass("PingPong")).toBe("kf-extrap kf-extrap-ping_pong");
  });
  it("sits the mark clear of the 7px glyph inside a 24px row", () => {
    expect(EXTRAP_GLYPH_GAP_PX).toBe(8);
  });
});

describe("interpToCoeffs (spline-only)", () => {
  it("maps Linear and Hold to the identity diagonal", () => {
    expect(interpToCoeffs({ kind: "Linear" })).toEqual([0, 0, 1, 1]);
    expect(interpToCoeffs({ kind: "Hold" })).toEqual([0, 0, 1, 1]);
  });
  it("passes Bezier through", () => {
    expect(interpToCoeffs({ kind: "Bezier", p1: [0.2, 0.3], p2: [0.7, 0.9] }))
      .toEqual([0.2, 0.3, 0.7, 0.9]);
  });
});

describe("handle↔coeff (unit square, y inverted, px box of size 100)", () => {
  it("clamps handle x into [0,1] but leaves y free", () => {
    // a handle dragged past the right edge clamps x=1; above the top → y>1
    expect(handleToCoeff(150, -20, 100)).toEqual([1, 1.2]);
    expect(handleToCoeff(-30, 50, 100)).toEqual([0, 0.5]);
  });
  it("round-trips through coeffToHandle", () => {
    const [hx, hy] = coeffToHandle(0.42, 0, 100);
    expect(handleToCoeff(hx, hy, 100)).toEqual([0.42, 0]);
  });
});
