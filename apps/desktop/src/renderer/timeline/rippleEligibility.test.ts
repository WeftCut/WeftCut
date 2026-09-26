// @vitest-environment jsdom
//
// The prediction the four Ripple delete surfaces share. Two halves are covered
// here and nowhere else: that the verdict is the PLANNER's — so the row greys on
// exactly the cases the actor refuses — and that a refused verdict comes back
// out as the curated sentence with the entity names resolved, which is what the
// tooltip and the status bar have to agree on.

import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";

import type { CompositionSummary, LayerSummary, ProjectSummary } from "../ipc";
import { clearKeyframeSelection, selectKeyframe } from "../keyframe/selectionStore";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  setGapSelection,
  setLayerSelection,
  type Selection,
} from "../state/selectionStore";
import { ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import {
  canRippleDeleteSelection,
  rippleDeleteReason,
  rippleDeleteState,
  rippleDeleteStateOf,
} from "./rippleEligibility";

const t = (key: string, values: Record<string, unknown>): string =>
  i18n.getFixedT("en-US")(key, values);

function layer(over: Partial<LayerSummary> & { id: string }): LayerSummary {
  return {
    label: null,
    t_start_us: 0,
    t_end_us: 2_000_000,
    kind: "VideoClip",
    color_hint: "",
    enabled: true,
    locked: false,
    params: { kind: "VideoClip", media_id: "m-1", media_label: "Aurora.mp4" },
    effects: [],
    ...over,
  } as LayerSummary;
}

function track(
  id: string,
  layers: LayerSummary[],
  locked = false,
): CompositionSummary["tracks"][number] {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

/// Two abutting clips on one lane. Deleting the first vacates `[0, 2s)`, which
/// is the hole every case below is built around.
function baseTracks(): CompositionSummary["tracks"] {
  return [
    track("t-video", [
      layer({ id: "l-a", label: "Interview A" }),
      layer({ id: "l-b", label: "Interview B", t_start_us: 2_000_000, t_end_us: 4_000_000 }),
    ]),
  ];
}

function seed(tracks: CompositionSummary["tracks"]): ProjectSummary {
  const summary = summaryFixture({ root: { duration_us: 4_000_000, tracks } });
  useProjectStore.getState().apply(summary);
  return summary;
}

function rootOf(summary: ProjectSummary): CompositionSummary {
  return summary.compositions[ROOT_ID]!;
}

/// The `Selection` shapes the predicate takes, built the way the store builds
/// them: a Layer set carries its first id as primary.
const NONE: Selection = { kind: "none" };
const layers = (ids: string[]): Selection => ({
  kind: "layers",
  primary: ids[0]!,
  ids: new Set(ids),
});
const gap = (trackId: string, s: number, e: number): Selection => ({
  kind: "gap",
  trackId,
  s,
  e,
});

afterEach(() => {
  useProjectStore.getState().apply(null);
  clearLayerSelection();
  clearKeyframeSelection();
});

describe("rippleDeleteStateOf", () => {
  it("offers the ripple for a plain selection whose span closes cleanly", () => {
    const root = rootOf(seed(baseTracks()));
    expect(rippleDeleteStateOf(layers(["l-a"]), root, false)).toEqual({
      kind: "ripple",
    });
  });

  it("asks for a selection when there is none", () => {
    const root = rootOf(seed(baseTracks()));
    expect(rippleDeleteStateOf(NONE, root, false)).toEqual({
      kind: "needs_selection",
    });
  });

  // Structural, not checked: the walk only visits this composition's tracks, so
  // a selection left over from another one is simply not found.
  it("asks for a selection when the selected ids live in another composition", () => {
    const root = rootOf(seed(baseTracks()));
    expect(rippleDeleteStateOf(layers(["elsewhere"]), root, false)).toEqual({
      kind: "needs_selection",
    });
  });

  // The precedence rule, not a refusal: the key is about to delete keys.
  it("reports the keyframe precedence ahead of everything else", () => {
    const root = rootOf(seed(baseTracks()));
    expect(rippleDeleteStateOf(layers(["l-a"]), root, true)).toEqual({
      kind: "keyframes",
    });
  });

  it("refuses with the planner's own error when a layer starts inside the span", () => {
    const tracks = baseTracks();
    tracks.push(
      track("t-text", [
        layer({
          id: "l-title",
          label: "Lower third",
          kind: "Text",
          params: { kind: "Text", content: "Chapter one" } as LayerSummary["params"],
          t_start_us: 1_000_000,
          t_end_us: 1_500_000,
        }),
      ]),
    );
    const state = rippleDeleteStateOf(layers(["l-a"]), rootOf(seed(tracks)), false);
    expect(state).toEqual({
      kind: "refused",
      refusal: {
        error: "RippleInsideHole",
        layer: "l-title",
        hole: { s: 0, e: 2_000_000 },
      },
    });
  });

  // The lenient lock reading: the lane blocks only because it holds a layer that
  // would actually shift.
  it("refuses when a locked lane holds a downstream layer", () => {
    const tracks = baseTracks();
    tracks.push(
      track("t-locked", [layer({ id: "l-music", t_start_us: 2_000_000, t_end_us: 3_000_000 })], true),
    );
    const state = rippleDeleteStateOf(layers(["l-a"]), rootOf(seed(tracks)), false);
    expect(state).toEqual({
      kind: "refused",
      refusal: { error: "TrackLocked", track: "t-locked" },
    });
  });

  // The gap kind (ADR 0069): the same planner through its gap entry, so the
  // verdict is the closing's and the refusals are the ripple's own.
  it("offers the ripple for a selected gap that closes cleanly", () => {
    const tracks = baseTracks();
    tracks[0]!.layers[1]!.t_start_us = 3_000_000;
    const root = rootOf(seed(tracks));
    expect(rippleDeleteStateOf(gap("t-video", 2_000_000, 3_000_000), root, false)).toEqual({
      kind: "ripple",
    });
  });

  it("refuses a gap with the planner's own error when a clip on another lane starts inside it", () => {
    const tracks = baseTracks();
    tracks[0]!.layers[1]!.t_start_us = 3_000_000;
    tracks.push(
      track("t-text", [
        layer({ id: "l-title", label: "Lower third", t_start_us: 2_500_000, t_end_us: 4_000_000 }),
      ]),
    );
    expect(rippleDeleteStateOf(gap("t-video", 2_000_000, 3_000_000), rootOf(seed(tracks)), false)).toEqual({
      kind: "refused",
      refusal: { error: "RippleInsideHole", layer: "l-title", hole: { s: 2_000_000, e: 3_000_000 } },
    });
  });

  it("refuses a gap the mirror no longer holds, and asks for a selection for a gap on a lane elsewhere", () => {
    const root = rootOf(seed(baseTracks()));
    // Two abutting clips: the span between them is not a gap.
    expect(rippleDeleteStateOf(gap("t-video", 2_000_000, 3_000_000), root, false)).toEqual({
      kind: "refused",
      refusal: { error: "GapNotFound", track: "t-video", s: 2_000_000, e: 3_000_000 },
    });
    expect(rippleDeleteStateOf(gap("elsewhere", 2_000_000, 3_000_000), root, false)).toEqual({
      kind: "needs_selection",
    });
  });

  it("lets a locked lane with nothing downstream through", () => {
    const tracks = baseTracks();
    tracks.push(track("t-locked", [], true));
    expect(rippleDeleteStateOf(layers(["l-a"]), rootOf(seed(tracks)), false)).toEqual({
      kind: "ripple",
    });
  });
});

describe("rippleDeleteReason", () => {
  it("says nothing while the gesture is live — the row's label already does", () => {
    expect(rippleDeleteReason({ kind: "ripple" }, t)).toBeUndefined();
  });

  it("names the precondition for the two states that have one", () => {
    expect(rippleDeleteReason({ kind: "needs_selection" }, t)).toBe(
      "Select the clips to remove and close the gap after, or click a gap to close it",
    );
    expect(rippleDeleteReason({ kind: "keyframes" }, t)).toContain("Keyframes");
  });

  // The whole point of routing through `formatCommandError`: the tooltip reads
  // as the status bar reads, with the uuid resolved to the name on the clip.
  it("renders a refusal as the curated sentence with the layer's display name", () => {
    const tracks = baseTracks();
    tracks.push(
      track("t-text", [
        layer({
          id: "l-title",
          label: "Lower third",
          kind: "Text",
          params: { kind: "Text", content: "Chapter one" } as LayerSummary["params"],
          t_start_us: 1_000_000,
          t_end_us: 1_500_000,
        }),
      ]),
    );
    const state = rippleDeleteStateOf(layers(["l-a"]), rootOf(seed(tracks)), false);
    expect(rippleDeleteReason(state, t)).toBe(
      "Ripple delete blocked: Lower third starts inside the span being closed — add it to the selection, or delete without ripple.",
    );
  });

  it("renders a locked lane as the lane's own header name", () => {
    const tracks = baseTracks();
    tracks.push(
      track("t-locked", [layer({ id: "l-music", t_start_us: 2_000_000, t_end_us: 3_000_000 })], true),
    );
    const state = rippleDeleteStateOf(layers(["l-a"]), rootOf(seed(tracks)), false);
    // `TrackLocked`'s own curated line, reused rather than restated — the lane
    // is locked, whichever op ran into it.
    expect(rippleDeleteReason(state, t)).toBe("Track 2 is locked.");
  });

  it("resolves a link straddle to the link's members when it has no label", () => {
    const tracks = baseTracks();
    const summary = summaryFixture({
      root: {
        duration_us: 4_000_000,
        tracks,
        links: [{ id: "lk-1", layer_ids: ["l-a", "l-b"] }],
      },
    });
    useProjectStore.getState().apply(summary);
    expect(
      rippleDeleteReason(
        {
          kind: "refused",
          refusal: { error: "RippleLinkStraddles", link: "lk-1", hole: { s: 0, e: 1 } },
        },
        t,
      ),
    ).toBe(
      "Ripple delete blocked: link Interview A + Interview B has members on both sides of the cut.",
    );
  });
});

// The imperative form the App handler, `CommandDef.enabled` and the strip's
// snapshot all reach for — it reads the same three stores the hook subscribes
// to, so a divergence here would grey a row the key still fires.
describe("rippleDeleteState — the live read", () => {
  it("follows the selection store", () => {
    seed(baseTracks());
    expect(rippleDeleteState()).toEqual({ kind: "needs_selection" });
    expect(canRippleDeleteSelection()).toBe(false);
    setLayerSelection("l-a", ["l-a"]);
    expect(rippleDeleteState()).toEqual({ kind: "ripple" });
    expect(canRippleDeleteSelection()).toBe(true);
  });

  it("follows a gap selection through the same read", () => {
    const tracks = baseTracks();
    tracks[0]!.layers[1]!.t_start_us = 3_000_000;
    seed(tracks);
    setGapSelection("t-video", 2_000_000, 3_000_000);
    expect(rippleDeleteState()).toEqual({ kind: "ripple" });
    expect(canRippleDeleteSelection()).toBe(true);
  });

  it("yields to a keyframe selection", () => {
    seed(baseTracks());
    setLayerSelection("l-a", ["l-a"]);
    selectKeyframe({ layerId: "l-a", paramKey: "opacity", kfId: "k-1" });
    expect(rippleDeleteState()).toEqual({ kind: "keyframes" });
    expect(canRippleDeleteSelection()).toBe(false);
  });
});
