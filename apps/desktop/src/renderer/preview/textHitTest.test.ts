import { describe, expect, it } from "vitest";

import type { CompositionSummary, LayerSummary } from "../ipc";
import { hitTestTextLayer, pointInQuad } from "./textHitTest";

const stat = (value: number) => ({ mode: "Static" as const, value });

/// A Text layer centred on (x, y) — the anchor point, per ADR 0049 — with the
/// transform fields a hit test reads. Everything else is the fixture the editor
/// tests use.
function text(
  id: string,
  over: Partial<{
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    locked: boolean;
    enabled: boolean;
    t_start_us: number;
    t_end_us: number;
  }> = {},
): LayerSummary {
  return {
    id,
    kind: "Text",
    label: null,
    enabled: over.enabled ?? true,
    locked: over.locked ?? false,
    t_start_us: over.t_start_us ?? 0,
    t_end_us: over.t_end_us ?? 5_000_000,
    color_hint: "#ffffff",
    effects: [],
    params: {
      kind: "Text",
      content: id,
      font_family: "Liberation Sans",
      font_size_px: 48,
      weight: 400,
      italic: false,
      align: "Center",
      valign: "Middle",
      color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
      x: stat(over.x ?? 640),
      y: stat(over.y ?? 360),
      anchor_x: stat(0.5),
      anchor_y: stat(0.5),
      scale_x: stat(over.scaleX ?? 1),
      scale_y: stat(1),
      scale_linked: true,
      rotation_deg: stat(over.rotation ?? 0),
      opacity: stat(1),
      outline: null,
      shadow: null,
      box_w: null,
      box_h: null,
      line_height: 0,
      letter_spacing: 0,
    },
  } as unknown as LayerSummary;
}

function color(id: string): LayerSummary {
  return {
    id,
    kind: "Color",
    label: null,
    enabled: true,
    locked: false,
    t_start_us: 0,
    t_end_us: 5_000_000,
    color_hint: "#000000",
    effects: [],
    params: { kind: "Color", color: stat(0), width: 1280, height: 720 },
  } as unknown as LayerSummary;
}

function composition(
  ...tracks: Array<{ layers: LayerSummary[]; locked?: boolean; enabled?: boolean }>
): Pick<CompositionSummary, "tracks"> {
  return {
    tracks: tracks.map((t, i) => ({
      id: `track-${i}`,
      locked: t.locked ?? false,
      enabled: t.enabled ?? true,
      layers: t.layers,
    })),
  } as unknown as Pick<CompositionSummary, "tracks">;
}

/// Every Text layer measures 200 × 40 — wide and short, so a rotation can be
/// told from its bounding box.
const SIZE = { w: 200, h: 40 };
const staged = () => SIZE;

describe("pointInQuad", () => {
  const quad: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("accepts interior points and edges, rejects the outside", () => {
    expect(pointInQuad({ x: 5, y: 5 }, quad)).toBe(true);
    expect(pointInQuad({ x: 0, y: 5 }, quad)).toBe(true);
    expect(pointInQuad({ x: 10.01, y: 5 }, quad)).toBe(false);
    expect(pointInQuad({ x: 5, y: -0.01 }, quad)).toBe(false);
  });

  // A flipped layer reverses the corner order; the test must not care.
  it("is winding-agnostic", () => {
    const reversed = [quad[0], quad[3], quad[2], quad[1]] as typeof quad;
    expect(pointInQuad({ x: 5, y: 5 }, reversed)).toBe(true);
    expect(pointInQuad({ x: 11, y: 5 }, reversed)).toBe(false);
  });
});

describe("hitTestTextLayer", () => {
  const at = (
    comp: Pick<CompositionSummary, "tracks">,
    x: number,
    y: number,
    tUs = 1_000_000,
    naturalSizeOf: (id: string) => { w: number; h: number } | null = staged,
  ) => hitTestTextLayer({ composition: comp, tUs, point: { x, y }, naturalSizeOf })?.id ?? null;

  it("hits the text under the point and misses beside it", () => {
    const comp = composition({ layers: [text("title")] });
    // 200 × 40 centred on (640, 360) spans x 540..740, y 340..380.
    expect(at(comp, 640, 360)).toBe("title");
    expect(at(comp, 545, 345)).toBe("title");
    expect(at(comp, 745, 360)).toBeNull();
    expect(at(comp, 640, 385)).toBeNull();
  });

  it("returns the topmost — the later track — where two overlap", () => {
    const comp = composition(
      { layers: [text("under")] },
      { layers: [text("over", { x: 700 })] },
    );
    // Both cover (650, 360); the later track paints over the earlier one.
    expect(at(comp, 650, 360)).toBe("over");
    // Only `under` covers x = 560.
    expect(at(comp, 560, 360)).toBe("under");
  });

  it("looks through locked and disabled layers, and locked and disabled tracks", () => {
    const base = { layers: [text("under")] };
    expect(at(composition(base, { layers: [text("top", { locked: true })] }), 640, 360)).toBe("under");
    expect(at(composition(base, { layers: [text("top", { enabled: false })] }), 640, 360)).toBe("under");
    expect(at(composition(base, { layers: [text("top")], locked: true }), 640, 360)).toBe("under");
    expect(at(composition(base, { layers: [text("top")], enabled: false }), 640, 360)).toBe("under");
    // ...all the way to empty frame when nothing editable is under the point.
    expect(at(composition({ layers: [text("only", { locked: true })] }), 640, 360)).toBeNull();
  });

  it("ignores Text outside its span and every other kind", () => {
    const comp = composition({ layers: [color("bg"), text("late", { t_start_us: 2_000_000 })] });
    expect(at(comp, 640, 360, 1_000_000)).toBeNull();
    expect(at(comp, 640, 360, 2_000_000)).toBe("late");
    // The end is exclusive, as the compositor's span test is.
    expect(at(comp, 640, 360, 5_000_000)).toBeNull();
  });

  it("skips a layer the compositor has not measured", () => {
    const comp = composition({ layers: [text("title")] });
    expect(at(comp, 640, 360, 1_000_000, () => null)).toBeNull();
    expect(at(comp, 640, 360, 1_000_000, () => ({ w: 0, h: 40 }))).toBeNull();
  });

  // The quad, not its bounding box: a rotated title is hit where its glyphs
  // are, which is exactly where the gizmo draws its box.
  it("tests against the rotated footprint", () => {
    const comp = composition({ layers: [text("tilted", { rotation: 90 })] });
    // Rotated 90° about its centre the 200 × 40 block spans x 620..660,
    // y 260..460 — tall, not wide.
    expect(at(comp, 640, 450)).toBe("tilted");
    expect(at(comp, 730, 360)).toBeNull();
  });

  it("handles a flipped layer", () => {
    const comp = composition({ layers: [text("mirror", { scaleX: -1 })] });
    expect(at(comp, 640, 360)).toBe("mirror");
    expect(at(comp, 745, 360)).toBeNull();
  });
});
