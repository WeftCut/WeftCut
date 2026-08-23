import { describe, expect, it } from "vitest";

import { resolveSplitTargets } from "./splitAtPlayhead";
import type {
  GroupSummary,
  LayerSummary,
  ProjectSummary,
  TrackSummary,
} from "../ipc";

/// `Color` rather than a media kind: nothing here touches decode, and a
/// synthetic layer with no media id keeps the fixture to the fields the
/// resolver actually reads.
function layer(
  id: string,
  tStartUs: number,
  tEndUs: number,
  over: Partial<LayerSummary> = {},
): LayerSummary {
  return {
    id,
    kind: "Color",
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "Color" } as LayerSummary["params"],
    effects: [],
    ...over,
  };
}

function track(
  id: string,
  layers: LayerSummary[],
  over: Partial<TrackSummary> = {},
): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    // A role by default, so the A/B filter keeps the row visible unless a case
    // deliberately drops it (`role: null` is what AbRoll hides).
    role: "a-roll",
    transient: false,
    layers,
    ...over,
  };
}

function summary(
  tracks: TrackSummary[],
  groups: GroupSummary[] = [],
): ProjectSummary {
  return {
    project_id: "p",
    name: "p",
    composition: {
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: tracks.length,
    layer_count: tracks.reduce((n, t) => n + t.layers.length, 0),
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks,
    markers: [],
    transitions: [],
    groups,
    audio_roles: [],
  };
}

const ids = (
  targets: ReturnType<typeof resolveSplitTargets>,
): string[] => targets.map((t) => t.layerId);

const NOTHING_SELECTED: ReadonlySet<string> = new Set();

describe("resolveSplitTargets", () => {
  it("takes a clip the playhead is strictly inside", () => {
    const p = summary([track("t1", [layer("a", 0, 2_000_000)])]);
    expect(ids(resolveSplitTargets(p, 1_000_000, NOTHING_SELECTED, false))).toEqual(
      ["a"],
    );
  });

  // A cut on either edge is `SplitOutsideLayer` in the actor, and it is the
  // honest answer too: the playhead resting on a cut means there is nothing
  // there to split.
  it.each([
    ["the in point", 0],
    ["the out boundary", 2_000_000],
    ["before the clip", -1],
    ["after the clip", 3_000_000],
  ])("skips a clip when the playhead is at %s", (_label, tUs) => {
    const p = summary([track("t1", [layer("a", 0, 2_000_000)])]);
    expect(resolveSplitTargets(p, tUs, NOTHING_SELECTED, false)).toEqual([]);
  });

  it("skips a locked track and a locked layer", () => {
    const p = summary([
      track("t1", [layer("a", 0, 2_000_000)], { locked: true }),
      track("t2", [layer("b", 0, 2_000_000, { locked: true })]),
      track("t3", [layer("c", 0, 2_000_000)]),
    ]);
    expect(ids(resolveSplitTargets(p, 1_000_000, NOTHING_SELECTED, false))).toEqual(
      ["c"],
    );
  });

  // The one filter that exists for a reason no single layer can see:
  // `split_layer_grouped` with `escape_group: false` cuts every spanning group
  // sibling in the SAME commit, so sending the partner as well would ask the
  // actor to split an interval it had already closed. One entry per group is
  // also what keeps an auto-paired A/V couple to one commit and one undo.
  it("emits one target per group, not one per member", () => {
    const p = summary(
      [
        track("video", [layer("v", 0, 2_000_000)]),
        track("audio", [layer("a", 0, 2_000_000)]),
      ],
      [{ id: "g1", label: null, layer_ids: ["v", "a"] }],
    );
    const targets = resolveSplitTargets(p, 1_000_000, NOTHING_SELECTED, false);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.groupId).toBe("g1");
  });

  it("still emits both when two straddling clips are in different groups", () => {
    const p = summary(
      [
        track("t1", [layer("v1", 0, 2_000_000)]),
        track("t2", [layer("v2", 0, 2_000_000)]),
      ],
      [
        { id: "g1", label: null, layer_ids: ["v1"] },
        { id: "g2", label: null, layer_ids: ["v2"] },
      ],
    );
    expect(ids(resolveSplitTargets(p, 1_000_000, NOTHING_SELECTED, false))).toEqual(
      ["v1", "v2"],
    );
  });

  // Premiere's contract: a selection narrows the cut to what you picked, and
  // only an empty one falls through to "everything under the line".
  it("cuts the selection when it straddles, ignoring the rest", () => {
    const p = summary([
      track("t1", [layer("a", 0, 2_000_000)]),
      track("t2", [layer("b", 0, 2_000_000)]),
    ]);
    expect(
      ids(resolveSplitTargets(p, 1_000_000, new Set(["b"]), false)),
    ).toEqual(["b"]);
  });

  // A selection that is nowhere near the playhead must not silently become
  // "cut nothing" — the sweep is the fallback, and this is the case that says
  // so.
  it("falls back to the sweep when nothing selected straddles", () => {
    const p = summary([
      track("t1", [layer("a", 0, 2_000_000)]),
      track("t2", [layer("far", 5_000_000, 6_000_000)]),
    ]);
    expect(
      ids(resolveSplitTargets(p, 1_000_000, new Set(["far"]), false)),
    ).toEqual(["a"]);
  });

  describe("the A/B view filter", () => {
    const project = () =>
      summary([
        track("aroll", [layer("clip", 0, 2_000_000)]),
        // Role-less: exactly what AbRoll hides, and where auto-spawned
        // overlays and titles land.
        track("overlay", [layer("title", 0, 2_000_000)], { role: null }),
      ]);

    it("leaves a hidden row out of the sweep", () => {
      expect(
        ids(resolveSplitTargets(project(), 1_000_000, NOTHING_SELECTED, true)),
      ).toEqual(["clip"]);
    });

    it("sweeps every row in Show All", () => {
      expect(
        ids(resolveSplitTargets(project(), 1_000_000, NOTHING_SELECTED, false)),
      ).toEqual(["clip", "title"]);
    });

    // The selection path deliberately ignores the filter: a selected layer is
    // one the user reached on purpose, and the timeline's inline reveal is
    // already showing it.
    it("still cuts a hidden row when it is the selection", () => {
      expect(
        ids(resolveSplitTargets(project(), 1_000_000, new Set(["title"]), true)),
      ).toEqual(["title"]);
    });
  });
});
