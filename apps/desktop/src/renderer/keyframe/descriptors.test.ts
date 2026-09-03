import { describe, expect, it } from "vitest";
import {
  animatableParams,
  readNumberTrack,
  readParamTrack,
  readRgbaTrack,
  readScaleLinked,
  COLOR_FILL,
  COLOR_TEXT,
  OPACITY,
} from "./descriptors";
import type { AnimTrack, LayerSummary, Rgba } from "../ipc";

describe("animatableParams", () => {
  // The anchor pair is part of "the complete transform": it is a keyframeable
  // Animated track on the wire like the rest (main/state/model.ts), so leaving
  // it out here would silently deny it a stopwatch, a timeline lane and a
  // curve — the whole point of storing it as a track.
  const TRANSFORM = [
    "x", "y", "scale_x", "scale_y", "rotation_deg", "anchor_x", "anchor_y", "opacity",
  ];
  it("visual layers expose the complete transform plus opacity", () => {
    for (const kind of ["VideoClip", "ImageOverlay", "Motif"]) {
      expect(animatableParams(kind).map((d) => d.paramKey)).toEqual(TRANSFORM);
    }
  });
  it("Text adds the glyph colour after opacity", () => {
    expect(animatableParams("Text").map((d) => d.paramKey)).toEqual([...TRANSFORM, "color"]);
  });
  it("Audio exposes gain_db + pan", () => {
    expect(animatableParams("Audio").map((d) => d.paramKey)).toEqual(["gain_db", "pan"]);
  });
  it("Color exposes its fill colour and nothing else", () => {
    expect(animatableParams("Color")).toEqual([COLOR_FILL]);
  });
  it("a kind with no animatable params at all still answers an empty list", () => {
    expect(animatableParams("Nonesuch")).toEqual([]);
  });
  it("scaleLinked collapses the pair into ONE composite Scale for every visual kind", () => {
    for (const kind of ["VideoClip", "ImageOverlay", "Text", "Motif"]) {
      const linked = animatableParams(kind, true).filter((d) => d.valueKind === "number");
      expect(linked.map((d) => d.paramKey)).toEqual([
        "x", "y", "scale_x", "rotation_deg", "anchor_x", "anchor_y", "opacity",
      ]);
      const scale = linked[2]!;
      expect(scale.labelKey).toBe("property_panel.scale");
      expect(scale.fanOutKeys).toEqual(["scale_x", "scale_y"]);
    }
    // Non-transform kinds ignore the flag.
    expect(animatableParams("Audio", true).map((d) => d.paramKey)).toEqual(["gain_db", "pan"]);
    expect(animatableParams("Color", true)).toEqual([COLOR_FILL]);
  });
});

describe("colour descriptors", () => {
  it("carry the rgba value kind and no numeric widget metadata", () => {
    for (const d of [COLOR_TEXT, COLOR_FILL]) {
      expect(d.valueKind).toBe("rgba");
      expect(d.paramKey).toBe("color");
      expect(d.labelKey).toBe("property_panel.color");
      expect(Object.keys(d).sort()).toEqual(["fallback", "labelKey", "paramKey", "valueKind"]);
    }
  });

  it("fall back to each kind's own default fill — white glyphs, a black plate", () => {
    expect(COLOR_TEXT.fallback).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(COLOR_FILL.fallback).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });
});

describe("readScaleLinked", () => {
  it("true only for an explicit true on the params view", () => {
    expect(readScaleLinked({ kind: "VideoClip", scale_linked: true } as unknown as LayerSummary["params"])).toBe(true);
    expect(readScaleLinked({ kind: "VideoClip", scale_linked: false } as unknown as LayerSummary["params"])).toBe(false);
    expect(readScaleLinked({ kind: "Color" } as unknown as LayerSummary["params"])).toBe(false);
  });
});

describe("readParamTrack", () => {
  it("reads the AnimTrack off the flattened params view", () => {
    const track: AnimTrack<number> = { mode: "Static", value: 0.5 };
    const params = { kind: "VideoClip", opacity: track } as unknown as LayerSummary["params"];
    expect(readParamTrack(params, "opacity")).toBe(track);
    expect(readParamTrack(params, "nope")).toBeNull();
  });

  it("the descriptor-typed reads answer the same track, each for its own value kind", () => {
    const opacity: AnimTrack<number> = { mode: "Static", value: 0.5 };
    const color: AnimTrack<Rgba> = { mode: "Static", value: { r: 1, g: 2, b: 3, a: 255 } };
    const params = { kind: "Text", opacity, color } as unknown as LayerSummary["params"];
    expect(readNumberTrack(params, OPACITY)).toBe(opacity);
    expect(readRgbaTrack(params, COLOR_TEXT)).toBe(color);
    // A kind that carries neither answers null on both, so a caller cannot mistake
    // an absent track for a static one.
    const bare = { kind: "Color" } as unknown as LayerSummary["params"];
    expect(readNumberTrack(bare, OPACITY)).toBeNull();
    expect(readRgbaTrack(bare, COLOR_FILL)).toBeNull();
  });
});

/// The numeric descriptor for a key — narrowing here is what makes the widget
/// assertions below type-check, and a colour key reaching this is the bug.
const byKey = (kind: string, key: string) => {
  const d = animatableParams(kind).find((x) => x.paramKey === key);
  if (!d || d.valueKind !== "number") throw new Error(`${kind}.${key} is not a numeric param`);
  return d;
};

describe("ParamDescriptor metadata", () => {
  it("opacity is a slider+readout, 0..1 step 0.01", () => {
    const d = byKey("VideoClip", "opacity");
    expect(d.step).toBe(0.01);
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
    expect(d.widgets).toEqual(["slider", "readout"]);
  });

  it("x/y are plain number fields, step 1", () => {
    const d = byKey("Text", "x");
    expect(d.step).toBe(1);
    expect(d.widgets).toEqual(["number"]);
  });

  it("scale is a number field, step 0.05", () => {
    expect(byKey("Motif", "scale_x").step).toBe(0.05);
    expect(byKey("Motif", "scale_x").widgets).toEqual(["number"]);
  });

  it("gain_db is a number field -30..20 step 0.5; pan is a slider -1..1 step 0.05", () => {
    const g = byKey("Audio", "gain_db");
    expect([g.step, g.min, g.max]).toEqual([0.5, -30, 20]);
    expect(g.widgets).toEqual(["number"]);
    const p = byKey("Audio", "pan");
    expect([p.step, p.min, p.max]).toEqual([0.05, -1, 1]);
    expect(p.widgets).toEqual(["slider"]);
  });
});
