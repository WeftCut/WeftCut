import { describe, expect, it } from "vitest";
import {
  IDENTITY_EDIT,
  applySegmentEasingKeys,
  batchParamTrackEntries,
  expandScaleFanOut,
  projectTracks,
  removeKeys,
  selectedKeysOf,
  setAutoKeys,
  setExtrapolationKeys,
  type KeyframeGroupEdit,
  type ParamTrackEntry,
} from "./keyframeBatch";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";
import type { AnimTrack, Keyframe, LayerSummary, Rgba, TrackSummary } from "../ipc";
import type { TrackValue } from "../keyframe/edits";
import type { SelectedKeyframe } from "../keyframe/selectionStore";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

const kf = (id: string, tUs: number, value: number): Keyframe<number> => ({
  id,
  t_us: tUs,
  value,
  in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" },
});

const keyed = (keys: Keyframe<number>[]): KeyframedTrack => ({
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: keys,
});

function layer(
  id: string,
  params: Record<string, unknown>,
  kind = "VideoClip",
): LayerSummary {
  return {
    id,
    kind,
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind, ...params } as unknown as LayerSummary["params"],
    effects: [],
  };
}

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

const sel = (layerId: string, paramKey: string, kfId: string): SelectedKeyframe => ({
  layerId,
  paramKey,
  kfId,
});

/// `[layerId, paramKey]` per entry — what the grouping produced, without the
/// tracks.
const addressed = (entries: ParamTrackEntry[]): [string, string][] =>
  entries.map(([layerId, paramKey]) => [layerId, paramKey]);

const keysOf = (t: AnimTrack<number>): string[] =>
  t.mode === "Keyframed" ? t.value.map((k) => k.id) : [];

/// Records what each group's edit was handed, and returns the track untouched.
/// Hand-rolled rather than `vi.fn`: an edit is polymorphic in the value type
/// and a mock's single call signature cannot stand in for one.
function spyEdit() {
  const seen: { kfIds: readonly string[]; fallback: TrackValue }[] = [];
  const edit: KeyframeGroupEdit = (t, kfIds, fallback) => {
    seen.push({ kfIds, fallback });
    return t;
  };
  return { edit, seen };
}

describe("batchParamTrackEntries — grouping", () => {
  const tracks = [
    track("t1", [
      layer("l1", {
        opacity: keyed([kf("a", 0, 1), kf("b", 500_000, 0.5)]),
        x: keyed([kf("c", 0, 10)]),
      }),
    ]),
    track("t2", [layer("l2", { opacity: keyed([kf("d", 0, 1)]) })]),
  ];

  it("folds each (layerId, paramKey) into ONE entry, in first-appearance order", () => {
    const { edit, seen } = spyEdit();
    const entries = batchParamTrackEntries({
      selected: [
        sel("l1", "opacity", "a"),
        sel("l2", "opacity", "d"),
        sel("l1", "x", "c"),
        sel("l1", "opacity", "b"),
      ],
      tracks,
      edit,
    });
    expect(addressed(entries)).toEqual([
      ["l1", "opacity"],
      ["l2", "opacity"],
      ["l1", "x"],
    ]);
    // Three groups, three calls — NOT one per selected key. One entry per key
    // would make the last of a group's entries the only one that survives the
    // op, silently dropping every earlier key's edit.
    expect(seen).toHaveLength(3);
    expect(seen[0]!.kfIds).toEqual(["a", "b"]);
  });

  it("drops a group with no keyframed track to fold into", () => {
    const withStatic = [
      track("t1", [
        layer("l1", { opacity: { mode: "Static", value: 1 }, x: keyed([kf("c", 0, 10)]) }),
      ]),
    ];
    const entries = batchParamTrackEntries({
      selected: [sel("l1", "opacity", "a"), sel("l1", "x", "c"), sel("gone", "x", "z")],
      tracks: withStatic,
      edit: removeKeys,
    });
    expect(addressed(entries)).toEqual([["l1", "x"]]);
  });
});

describe("batchParamTrackEntries — per-param fallbacks", () => {
  // Three params with three DIFFERENT descriptor fallbacks, so one shared value
  // cannot pass for all of them: x = 0, scale_x = 1, anchor_x = 0.5.
  const tracks = [
    track("t1", [
      layer("l1", {
        x: keyed([kf("x1", 0, 5)]),
        scale_x: keyed([kf("s1", 0, 2)]),
        anchor_x: keyed([kf("a1", 0, 0.25)]),
      }),
    ]),
  ];

  it("hands every group its OWN param's fallback", () => {
    const { edit, seen } = spyEdit();
    batchParamTrackEntries({
      selected: [sel("l1", "x", "x1"), sel("l1", "scale_x", "s1"), sel("l1", "anchor_x", "a1")],
      tracks,
      edit,
    });
    expect(seen.map((s) => s.fallback)).toEqual([0, 1, 0.5]);
  });

  it("collapses each emptied track to its own fallback when it carried no keys", () => {
    // A Keyframed track with an empty `value` is the one state where the
    // fallback is the answer rather than a surviving key's value.
    const empty = [
      track("t1", [
        layer("l1", { x: keyed([]), scale_x: keyed([]), anchor_x: keyed([]) }),
      ]),
    ];
    const entries = batchParamTrackEntries({
      selected: [sel("l1", "x", "x1"), sel("l1", "scale_x", "s1"), sel("l1", "anchor_x", "a1")],
      tracks: empty,
      edit: removeKeys,
    });
    expect(entries.map(([, , t]) => t)).toEqual([
      { mode: "Static", value: 0 },
      { mode: "Static", value: 1 },
      { mode: "Static", value: 0.5 },
    ]);
  });

  it("falls back to 0 for a param the layer kind does not animate", () => {
    // `gain_db` is an Audio param; on a VideoClip no descriptor names it, so the
    // fold gets 0 rather than some other param's number.
    const { edit, seen } = spyEdit();
    batchParamTrackEntries({
      selected: [sel("l1", "gain_db", "g1")],
      tracks: [track("t1", [layer("l1", { gain_db: keyed([kf("g1", 0, -3)]) })])],
      edit,
    });
    expect(seen).toEqual([{ kfIds: ["g1"], fallback: 0 }]);
  });
});

describe("removeKeys", () => {
  it("takes every selected key out in one pass over the track", () => {
    const t = keyed([kf("a", 0, 1), kf("b", 500_000, 0.5), kf("c", 1_000_000, 0)]);
    // Applied per key against this same original track, only the LAST removal
    // would survive and `a` would come back.
    expect(keysOf(removeKeys(t, ["a", "b"], 0))).toEqual(["c"]);
  });

  it("is order-independent — a sweep's direction cannot change the result", () => {
    const t = keyed([kf("a", 0, 1), kf("b", 500_000, 0.5), kf("c", 1_000_000, 0)]);
    expect(removeKeys(t, ["c", "a"], 0)).toEqual(removeKeys(t, ["a", "c"], 0));
  });

  it("collapses a fully emptied track to a Static holding the last key's value", () => {
    const t = keyed([kf("a", 0, 1), kf("b", 500_000, 0.25)]);
    expect(removeKeys(t, ["b", "a"], 9)).toEqual({ mode: "Static", value: 0.25 });
  });

  it("leaves the keys it was not given", () => {
    const t = keyed([kf("a", 0, 1), kf("b", 500_000, 0.5)]);
    expect(keysOf(removeKeys(t, ["missing"], 0))).toEqual(["a", "b"]);
  });
});

describe("applySegmentEasingKeys / setAutoKeys", () => {
  const tracks = [
    track("t1", [layer("l1", { opacity: keyed([kf("a", 0, 0), kf("b", 1_000_000, 1)]) })]),
    track("t2", [layer("l2", { opacity: keyed([kf("c", 0, 0), kf("d", 1_000_000, 1)]) })]),
  ];

  it("sets one easing on the segment leaving each selected key of every layer in the batch", () => {
    const entries = batchParamTrackEntries({
      selected: [sel("l1", "opacity", "a"), sel("l2", "opacity", "c"), sel("l2", "opacity", "d")],
      tracks,
      edit: applySegmentEasingKeys({ kind: "Hold" }),
    });
    expect(addressed(entries)).toEqual([
      ["l1", "opacity"],
      ["l2", "opacity"],
    ]);
    const classes = (t: AnimTrack<TrackValue>) =>
      t.mode === "Keyframed" ? t.value.map((k) => k.segment.kind) : [];
    // l1: only the selected `a` changed; l2: both selected keys did.
    expect(classes(entries[0]![2])).toEqual(["Hold", "Linear"]);
    expect(classes(entries[1]![2])).toEqual(["Hold", "Hold"]);
  });

  it("marks every selected key Auto and splines the segments between them", () => {
    const t = keyed([kf("a", 0, 0), kf("b", 500_000, 1), kf("c", 1_000_000, 2)]);
    const next = setAutoKeys(t, ["a", "b", "c"], 0);
    expect(next.mode).toBe("Keyframed");
    const keys = (next as KeyframedTrack).value;
    // Every key is Auto/Smooth; the last key's leaving class has no segment to
    // shape and stays as it was.
    expect(keys.map((k) => k.segment.kind)).toEqual(["Spline", "Spline", "Linear"]);
    expect(keys.every((k) => k.in.mode === "Auto" && k.out.mode === "Auto" && k.continuity === "Smooth")).toBe(true);
  });
});

describe("setExtrapolationKeys / IDENTITY_EDIT / selectedKeysOf", () => {
  const t = keyed([kf("a", 0, 0), kf("b", 1_000_000, 1)]);

  it("patches the track's extrapolation whatever keys name the group, leaving the keys alone", () => {
    const next = setExtrapolationKeys({ after: "Loop" })(t, ["b"], 0);
    expect(next.mode).toBe("Keyframed");
    expect((next as KeyframedTrack).extrapolate).toEqual({ before: "Hold", after: "Loop" });
    expect((next as KeyframedTrack).value).toBe(t.value);
    const both = setExtrapolationKeys({ before: "Continue", after: "Offset" })(t, ["a"], 0);
    expect((both as KeyframedTrack).extrapolate).toEqual({ before: "Continue", after: "Offset" });
  });

  it("the identity fold hands every group its committed track, unchanged and by reference", () => {
    expect(IDENTITY_EDIT(t, ["a"], 0)).toBe(t);
    const entries = batchParamTrackEntries({
      selected: [sel("l1", "opacity", "a")],
      tracks: [track("t1", [layer("l1", { opacity: t })])],
      edit: IDENTITY_EDIT,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]![2]).toBe(t);
  });

  it("selectedKeysOf reads a group's selected keys in track order, ignoring other groups' ids", () => {
    const entry: ParamTrackEntry = ["l1", "opacity", t];
    const selected = [sel("l1", "opacity", "b"), sel("l2", "opacity", "a"), sel("l1", "x", "a"), sel("l1", "opacity", "a")];
    expect(selectedKeysOf(entry, selected).map((k) => k.id)).toEqual(["a", "b"]);
    expect(selectedKeysOf(["l1", "opacity", { mode: "Static", value: 1 }], selected)).toEqual([]);
  });
});

describe("edits are generic over the value type", () => {
  const red: Rgba = { r: 255, g: 0, b: 0, a: 255 };
  const blue: Rgba = { r: 0, g: 0, b: 255, a: 255 };
  const colour: Extract<AnimTrack<Rgba>, { mode: "Keyframed" }> = {
    mode: "Keyframed",
    extrapolate: { before: "Hold", after: "Hold" },
    value: [
      { ...kf("a", 0, 0), value: red },
      { ...kf("b", 1_000_000, 0), value: blue },
    ],
  };

  it("removeKeys folds a colour group with a colour fallback", () => {
    const next = removeKeys(colour, ["a"], red);
    expect(next.mode).toBe("Keyframed");
    expect((next as Extract<AnimTrack<Rgba>, { mode: "Keyframed" }>).value.map((k) => k.value)).toEqual([blue]);
    expect(removeKeys(colour, ["a", "b"], red)).toEqual({ mode: "Static", value: blue });
    expect(removeKeys({ ...colour, value: [] }, ["a"], red)).toEqual({ mode: "Static", value: red });
  });

  it("applySegmentEasingKeys and setAutoKeys write the same record fields on a colour track", () => {
    const eased = applySegmentEasingKeys({ kind: "Hold" })(colour, ["a"], red);
    expect((eased as typeof colour).value[0]!.segment).toEqual({ kind: "Hold" });
    const auto = setAutoKeys(colour, ["a"], red);
    expect((auto as typeof colour).value[0]!.out.mode).toBe("Auto");
    expect((auto as typeof colour).value[0]!.value).toEqual(red);
  });
});

describe("projectTracks / expandScaleFanOut", () => {
  it("flattens every composition's tracks, since a layer id is unique project-wide", () => {
    const summary = summaryFixture({
      root: { tracks: [track("t1", [layer("l1", { opacity: keyed([kf("a", 0, 1)]) })]) ] },
      groups: [
        compositionFixture({
          id: "comp-group",
          tracks: [track("t2", [layer("l2", { opacity: keyed([kf("b", 0, 1)]) })])],
        }),
      ],
    });

    expect(projectTracks(summary).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(projectTracks(null)).toEqual([]);
  });

  it("writes both scale axes for a linked layer and leaves every other key alone", () => {
    const linked = layer("l1", { scale_x: keyed([kf("a", 0, 2)]), scale_linked: true });
    const entries = expandScaleFanOut(
      [
        ["l1", "scale_x", keyed([kf("a", 0, 2)])],
        ["l1", "opacity", keyed([kf("b", 0, 1)])],
      ],
      (id) => (id === "l1" ? linked : null),
    );

    expect(addressed(entries)).toEqual([
      ["l1", "scale_x"],
      ["l1", "scale_y"],
      ["l1", "opacity"],
    ]);
    // The twin is a structural copy under fresh ids — main's invariant compares
    // the tracks, not the identities.
    expect(keysOf(entries[1]![2] as AnimTrack<number>)).not.toEqual(["a"]);
  });

  it("leaves an UNLINKED layer's scale write on the one axis it names", () => {
    const unlinked = layer("l1", { scale_x: keyed([kf("a", 0, 2)]) });
    const entries = expandScaleFanOut(
      [["l1", "scale_x", keyed([kf("a", 0, 2)])]],
      () => unlinked,
    );

    expect(addressed(entries)).toEqual([["l1", "scale_x"]]);
  });
});
