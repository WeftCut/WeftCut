import { describe, expect, it } from "vitest";
import type { AnimTrack, EffectView, LayerSummary, TrackSummary } from "../ipc";
import { HOLD_EXTRAPOLATION, inIdentity, outIdentity } from "../../shared/keyframe";
import { effectParamDescriptor, keyframedParams, layerParams, readLayerParamTrack } from "./channels";
import { resolveNavLayer } from "./nav";
import { batchParamTrackEntries, removeKeys, selectionGroups } from "../timeline/keyframeBatch";
import { keyframeSnapshot, pasteEntriesFor } from "./clipboard";
import { marqueeHitKeyframes } from "../timeline/marquee";

const keyed = <T,>(value: T): AnimTrack<T> => ({
  mode: "Keyframed", extrapolate: HOLD_EXTRAPOLATION,
  value: [{ id: "k", t_us: 0, value, in: inIdentity(), out: outIdentity(),
    continuity: "Broken", segment: { kind: "Linear" } }],
});
const effect = (id = "blur-a", params: EffectView["params"] = { strength: keyed(23) }): EffectView =>
  ({ id, kind: "blur", enabled: true, params });
const layer = (effects: EffectView[], params = {}): LayerSummary => ({
  id: "layer-a", kind: "VideoClip", label: "Clip A", enabled: true, locked: false,
  t_start_us: 0, t_end_us: 2_000_000, color_hint: "#888",
  params: { kind: "VideoClip", ...params } as LayerSummary["params"], effects,
});
const track = (layers: LayerSummary[]): TrackSummary => ({
  id: "track-a", kind: "Video", label: null, enabled: true, locked: false,
  muted: false, solo: false, role: null, transient: false, layers,
});
const paramKey = "effects[blur-a].params[strength]";
const selected = [{ layerId: "layer-a", paramKey, kfId: "k" }];

describe("layer animation channels", () => {
  it("discovers animated effects and path progress without a timeline whitelist", () => {
    const l = layer([effect()], { position: { mode: "Path" }, path_progress: keyed(0.5), x: keyed(1) });
    expect(keyframedParams([l]).map((d) => d.paramKey)).toEqual(["path_progress", paramKey]);
    expect(readLayerParamTrack(l, "x")).toBeNull();
  });

  it("exposes absent defaults for editing without manufacturing a keyframed row", () => {
    const l = layer([effect("blur-a", {})]);
    const d = effectParamDescriptor(l.effects[0]!, "strength")!;
    expect(d).toMatchObject({ fallback: 8, min: 0, max: 100, step: 1 });
    expect(layerParams(l).some((p) => p.paramKey === d.paramKey)).toBe(true);
    expect(readLayerParamTrack(l, d)).toEqual({ mode: "Static", value: 8 });
    expect(keyframedParams([l])).toEqual([]);
  });

  it("keeps identical effect kinds isolated and follows identities across reorder/removal", () => {
    const a = effect(), b = effect("blur-b");
    const l = layer([a, b]);
    expect(keyframedParams([l]).map((d) => d.paramKey)).toEqual([paramKey, "effects[blur-b].params[strength]"]);
    expect(readLayerParamTrack(layer([b, a]), paramKey)).toBe(a.params.strength);
    expect(keyframedParams([layer([b, a])])[1]!.owner).toMatchObject({ ordinal: 2, layerLabel: "Clip A" });
    expect(readLayerParamTrack(layer([b]), paramKey)).toBeNull();
  });

  it("keeps disabled visual animation editable, but omits audio and unknown effects", () => {
    const l = layer([
      { ...effect(), enabled: false },
      { ...effect("audio"), kind: "audio.denoise" },
      { ...effect("future"), kind: "future-filter" },
    ]);
    expect(keyframedParams([l]).map((d) => d.paramKey)).toEqual([paramKey]);
    expect(readLayerParamTrack(l, "effects[audio].params[strength]")).toBeNull();
    expect(readLayerParamTrack(l, "effects[blur-a].params[typo]")).toBeNull();
  });

  it("orders by definitions even when the first layer keys only a later property", () => {
    expect(keyframedParams([
      layer([], { opacity: keyed(0.5) }), layer([], { x: keyed(10) }),
    ]).map((d) => d.paramKey)).toEqual(["x", "opacity"]);
  });

  it("uses the same effect track for navigation, selection, deletion, copying and pasting", () => {
    const l = layer([effect()]), tracks = [track([l])];
    expect(resolveNavLayer(tracks[0]!, paramKey, null)).toBe(l);
    expect(selectionGroups({ tracks, selected })[0]).toMatchObject({ fallback: 8, track: l.effects[0]!.params.strength });
    expect(batchParamTrackEntries({ tracks, selected, edit: removeKeys })).toEqual([
      [l.id, paramKey, { mode: "Static", value: 23 }],
    ]);
    const groups = keyframeSnapshot({ tracks, selected });
    const pasted = pasteEntriesFor({ groups, layers: [l], atUs: 1_000_000, mkId: () => "pasted" });
    expect(pasted.entries[0]).toMatchObject([l.id, paramKey, {
      mode: "Keyframed", value: [{ id: "k" }, { id: "pasted", t_us: 1_000_000, value: 23 }],
    }]);
    expect(pasted.skipped).toEqual([]);
    // Copying does not guess which other effect instance the user means.
    expect(pasteEntriesFor({ groups, layers: [layer([effect("blur-b")])], atUs: 0 }).entries).toEqual([]);
    expect(selectionGroups({ tracks: [track([layer([])])], selected })).toEqual([]);
  });

  it("marquee takes effect keys and the centre-line diamonds of expanded colour rows", () => {
    const color = { r: 255, g: 0, b: 0, a: 255 };
    const l = { ...layer([effect()], { color: keyed(color) }), kind: "Text" };
    const tracks = [track([l])];
    expect(marqueeHitKeyframes({ tracks, pxPerSec: 100,
      rows: [{ trackId: "track-a", paramKey, top: 0, bottom: 24, expanded: false }],
      box: { x0: -1, x1: 1, y0: 0, y1: 24 },
    })).toEqual(selected);
    const rows = [{ trackId: "track-a", paramKey: "color", top: 24, bottom: 96, expanded: true }];
    expect(marqueeHitKeyframes({ tracks, rows, pxPerSec: 100,
      box: { x0: -1, x1: 1, y0: 59, y1: 61 },
    })).toEqual([{ layerId: l.id, paramKey: "color", kfId: "k" }]);
    expect(marqueeHitKeyframes({ tracks, rows, pxPerSec: 100,
      box: { x0: -1, x1: 1, y0: 24, y1: 40 },
    })).toEqual([]);
  });
});
