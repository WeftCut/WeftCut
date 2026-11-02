import { describe, expect, it } from "vitest";

import type { AnimTrack, CompositionSummary, LayerSummary, TrackSummary } from "../ipc";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import { cannotDraw, capabilityOf, drawNeeds, rendererNameOf } from "./rendererCapability";

// What the canvas fallback cannot draw is decided per span of content, so a
// GPU-less host can still render plain frames (spec D1). Pinned here: which
// content counts, where it is found (inside Groups, on the Group itself, in a
// transition window), and that only the canvas renderer refuses.

const S = 1_000_000;
const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });

const layer = (id: string, t0: number, t1: number, over: Partial<LayerSummary> = {}): LayerSummary => ({
  id, label: null, t_start_us: t0, t_end_us: t1, kind: "Color", color_hint: "#456", enabled: true, locked: false,
  params: { kind: "Color", color: { mode: "Static", value: { r: 1, g: 2, b: 3, a: 255 } }, width: 1920, height: 1080 },
  effects: [], ...over,
});
const fx = (kind: string, enabled = true) => ({ id: `fx-${kind}`, kind, enabled, params: {} });
const ref = (id: string, compositionId: string, t0: number, t1: number, over: Partial<LayerSummary> = {}): LayerSummary => layer(id, t0, t1, {
  kind: "CompositionRef",
  params: {
    kind: "CompositionRef", composition_id: compositionId, composition_label: null, src_in_us: 0, src_out_us: t1 - t0,
    x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), scale_linked: true, rotation_deg: stat(0), opacity: stat(1),
    anchor_x: stat(0.5), anchor_y: stat(0.5),
  },
  ...over,
});
const track = (id: string, layers: LayerSummary[]): TrackSummary => ({
  id, kind: "Video", label: id, enabled: true, locked: false, muted: false, solo: false, role: null, transient: false, layers,
});
const project = (layers: LayerSummary[], over: Partial<CompositionSummary> = {}, groups: CompositionSummary[] = []) =>
  summaryFixture({ root: { duration_us: 10 * S, tracks: [track("t", layers)], ...over }, groups });

const CANVAS = capabilityOf("canvas", false);
const WEBGPU = capabilityOf("webgpu", true);
const ids = (n: ReturnType<typeof drawNeeds>) => Object.fromEntries([...n].map(([f, s]) => [f, [...s].sort()]));

describe("drawNeeds", () => {
  it("names a layer with an enabled visual effect, in range only", () => {
    const p = project([layer("plain", 0, 10 * S), layer("dark", 2 * S, 4 * S, { effects: [fx("brightness")] })]);
    expect(ids(drawNeeds(p, ROOT_ID, 3 * S, 3 * S + 1))).toEqual({ effects: ["dark"] });
    expect(ids(drawNeeds(p, ROOT_ID, 5 * S, 5 * S + 1))).toEqual({});
  });

  it("skips disabled effects, audio effects, and effects when the caller has them off", () => {
    const p = project([
      layer("off", 0, 10 * S, { effects: [fx("blur", false)] }),
      layer("audio", 0, 10 * S, { effects: [fx("audio.denoise")] }),
      layer("on", 0, 10 * S, { effects: [fx("blur")] }),
    ]);
    expect(ids(drawNeeds(p, ROOT_ID, 0, 1))).toEqual({ effects: ["on"] });
    expect(ids(drawNeeds(p, ROOT_ID, 0, 1, undefined, false))).toEqual({});
  });

  it("names a cropped clip", () => {
    const clip = layer("clip", 0, 10 * S, { kind: "VideoClip", params: { kind: "VideoClip", crop: { x: 0.1, y: 0, w: 0.9, h: 1 } } as never });
    expect(ids(drawNeeds(project([clip]), ROOT_ID, 0, 1))).toEqual({ crop: ["clip"] });
  });

  it("names both sides of a transition only inside its window", () => {
    const p = project([layer("a", 0, 5 * S), layer("b", 4 * S, 10 * S)], {
      transitions: [{ id: "tr", from_layer: "a", to_layer: "b", duration_us: 1 * S, kind: { kind: "Crossfade" }, extended_us: 0 }],
    });
    expect(ids(drawNeeds(p, ROOT_ID, 4.5 * S, 4.5 * S + 1))).toEqual({ transitions: ["a", "b"] });
    expect(ids(drawNeeds(p, ROOT_ID, 6 * S, 6 * S + 1))).toEqual({});
  });

  it("looks inside Groups and at the Group layer itself", () => {
    const inner = compositionFixture({ id: "g", duration_us: 4 * S, tracks: [track("gt", [layer("inside", 0, 4 * S, { effects: [fx("saturation")] })])] });
    const p = project([ref("group", "g", 2 * S, 6 * S, { effects: [fx("contrast")] })], {}, [inner]);
    expect(ids(drawNeeds(p, ROOT_ID, 3 * S, 3 * S + 1))).toEqual({ effects: ["group", "inside"] });
    expect(ids(drawNeeds(p, ROOT_ID, 7 * S, 7 * S + 1))).toEqual({});
  });
});

describe("cannotDraw", () => {
  const p = project([layer("plain", 0, 10 * S), layer("dark", 2 * S, 4 * S, { effects: [fx("brightness")] })]);

  it("refuses on canvas with the typed reason", () => {
    expect(cannotDraw(CANVAS, drawNeeds(p, ROOT_ID, 3 * S, 3 * S + 1))).toEqual({
      error: "RendererCannotDraw", renderer: "canvas", missing: ["effects"], layer_ids: ["dark"], needs: "WebGPU or WebGL2",
    });
  });

  it("lets a plain frame through on canvas, and everything through on a GPU renderer", () => {
    expect(cannotDraw(CANVAS, drawNeeds(p, ROOT_ID, 5 * S, 5 * S + 1))).toBeNull();
    expect(cannotDraw(WEBGPU, drawNeeds(p, ROOT_ID, 3 * S, 3 * S + 1))).toBeNull();
    expect(cannotDraw(capabilityOf("webgl", true), drawNeeds(p, ROOT_ID, 3 * S, 3 * S + 1))).toBeNull();
  });

  it("reads an unknown Pixi renderer name as the canvas fallback", () => {
    expect(rendererNameOf("webgpu")).toBe("webgpu");
    expect(rendererNameOf("canvas")).toBe("canvas");
    expect(rendererNameOf("something")).toBe("canvas");
  });
});
