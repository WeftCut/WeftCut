import { afterEach, describe, expect, it } from "vitest";

import {
  addToGroupForSelection,
  addToGroupTarget,
  canAddToGroupSelection,
  canGroupSelection,
  canUngroupSelection,
  groupForSelection,
  groupNotPlainReason,
  selectedGroupLayer,
  ungroupForSelection,
} from "./groupEligibility";
import type { AnimTrack, LayerSummary, TrackSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });

function colorLayer(id: string, over: Partial<LayerSummary> = {}): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "Color",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    ...over,
    params: {
      kind: "Color",
      color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
      width: 640,
      height: 360,
    },
  };
}

function track(id: string, layers: LayerSummary[], locked = false): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

function seed(tracks: TrackSummary[]): void {
  useProjectStore.getState().apply(summaryFixture({ root: { tracks } }));
}

afterEach(() => {
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

// The gate mirrors `main/state/mutations/groups.ts`'s `groupNotPlainReason` over
// the WIRE shape, minus its `blend_mode` arm. A drift here does not throw — it
// greys Ungroup out on a plain Group, or offers it on one the actor refuses —
// which is why each field gets its own case.
describe("groupNotPlainReason", () => {
  it("answers null for an identity Group layer", () => {
    expect(groupNotPlainReason(groupLayerFixture())).toBeNull();
  });

  it.each([
    ["x", { x: num(12) }],
    ["y", { y: num(-1) }],
    ["scale_x", { scale_x: num(2), scale_y: num(2) }],
    ["scale_y", { scale_y: num(0.5), scale_x: num(0.5) }],
    ["rotation_deg", { rotation_deg: num(90) }],
    ["anchor_x", { anchor_x: num(0) }],
    ["anchor_y", { anchor_y: num(1) }],
  ])("names the transform for an authored %s", (_field, over) => {
    expect(groupNotPlainReason(groupLayerFixture(over))).toBe("transform");
  });

  // Keyframed at the identity VALUE is still authored animation: the members
  // have no shared track to carry it onto.
  it("names the transform for a keyframed axis, whatever its values", () => {
    const keyed: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [{ id: "k", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
    };
    expect(groupNotPlainReason(groupLayerFixture({ x: keyed }))).toBe("transform");
  });

  // Unlinking the axes is an authored intent even at scale 1, and it is part of
  // the identity main compares against.
  it("names the transform for unlinked scale axes", () => {
    expect(groupNotPlainReason(groupLayerFixture({ scale_linked: false }))).toBe(
      "transform",
    );
  });

  it("names the opacity, then the effects, in that order", () => {
    expect(groupNotPlainReason(groupLayerFixture({ opacity: num(0.5) }))).toBe(
      "opacity",
    );
    expect(
      groupNotPlainReason(
        groupLayerFixture({
          effects: [{ id: "e", kind: "chromakey", enabled: true, params: {} }],
        }),
      ),
    ).toBe("effects");
    // Both wrong: opacity is named first, because it is the cheaper thing to
    // reset and the check order is the order the instructions get harder.
    expect(
      groupNotPlainReason(
        groupLayerFixture({
          opacity: num(0.5),
          effects: [{ id: "e", kind: "chromakey", enabled: true, params: {} }],
        }),
      ),
    ).toBe("opacity");
  });

  it("answers null for a layer that is not a Group at all", () => {
    expect(groupNotPlainReason(colorLayer("a"))).toBeNull();
  });
});

describe("groupForSelection", () => {
  // AE allows one — wrapping a single layer in a Group is how you give it a
  // transform of its own — so the floor is one, not two.
  it("groups one or more selected layers", () => {
    seed([track("t1", [colorLayer("a"), colorLayer("b")])]);
    expect(groupForSelection()).toBe("needs_selection");
    setLayerSelection("a", ["a"]);
    expect(groupForSelection()).toBe("group");
    setLayerSelection("a", ["a", "b"]);
    expect(groupForSelection()).toBe("group");
    expect(canGroupSelection()).toBe(true);
  });

  // The actor refuses the WHOLE set on any locked member rather than grouping
  // the rest, so the gate has to be as strict — otherwise the button is live and
  // the op refuses.
  it("refuses when any selected layer is locked", () => {
    seed([track("t1", [colorLayer("a"), colorLayer("b", { locked: true })])]);
    setLayerSelection("a", ["a", "b"]);
    expect(groupForSelection()).toBe("locked");
    expect(canGroupSelection()).toBe(false);
    setLayerSelection("a", ["a"]);
    expect(groupForSelection()).toBe("group");
  });

  it("refuses when the selected layer's lane is locked", () => {
    seed([track("t1", [colorLayer("a")], true)]);
    setLayerSelection("a", ["a"]);
    expect(groupForSelection()).toBe("locked");
  });

  // Both stores are read LIVE — the same rule `appCommands.ts` states for
  // `clearRange`. A summary that dropped the clips must not leave the button
  // reading "Group".
  it("follows the project store, not a snapshot", () => {
    seed([track("t1", [colorLayer("a")])]);
    setLayerSelection("a", ["a"]);
    expect(groupForSelection()).toBe("group");
    seed([]);
    setLayerSelection("a", ["a"]);
    expect(groupForSelection()).toBe("needs_selection");
  });
});

describe("ungroupForSelection", () => {
  it("ungroups exactly one selected plain Group layer", () => {
    seed([track("t1", [groupLayerFixture({ id: "g" })])]);
    expect(ungroupForSelection()).toBe("needs_one_group");
    setLayerSelection("g", ["g"]);
    expect(ungroupForSelection()).toBe("ungroup");
    expect(canUngroupSelection()).toBe(true);
  });

  // One instruction covers every shape failure — "select exactly one group clip"
  // — so they share one state rather than spending three strings saying it.
  it("collapses every shape failure into one reason", () => {
    seed([
      track("t1", [
        groupLayerFixture({ id: "g" }),
        groupLayerFixture({ id: "g2", compositionId: "comp-two" }),
        colorLayer("a"),
      ]),
    ]);
    setLayerSelection("a", ["a"]);
    expect(ungroupForSelection()).toBe("needs_one_group");
    setLayerSelection("g", ["g", "g2"]);
    expect(ungroupForSelection()).toBe("needs_one_group");
    setLayerSelection("g", ["g", "a"]);
    expect(ungroupForSelection()).toBe("needs_one_group");
    expect(canUngroupSelection()).toBe(false);
  });

  it("names the lock before the plainness", () => {
    seed([
      track("t1", [groupLayerFixture({ id: "g", locked: true, opacity: num(0.5) })]),
    ]);
    setLayerSelection("g", ["g"]);
    expect(ungroupForSelection()).toBe("locked");
  });

  // The tooltip has to name WHICH condition failed, and each of these names a
  // different field to reset.
  it("names which field blocks the expansion", () => {
    seed([track("t1", [groupLayerFixture({ id: "g", opacity: num(0.5) })])]);
    setLayerSelection("g", ["g"]);
    expect(ungroupForSelection()).toBe("not_plain_opacity");

    seed([track("t1", [groupLayerFixture({ id: "g", x: num(40) })])]);
    setLayerSelection("g", ["g"]);
    expect(ungroupForSelection()).toBe("not_plain_transform");

    seed([
      track("t1", [
        groupLayerFixture({
          id: "g",
          effects: [{ id: "e", kind: "chromakey", enabled: true, params: {} }],
        }),
      ]),
    ]);
    setLayerSelection("g", ["g"]);
    expect(ungroupForSelection()).toBe("not_plain_effects");
  });
});

describe("addToGroupForSelection", () => {
  it("adds every other selected layer to the one selected Group", () => {
    seed([
      track("t1", [
        groupLayerFixture({ id: "g" }),
        colorLayer("a"),
        colorLayer("b"),
      ]),
    ]);
    setLayerSelection("g", ["g", "a", "b"]);
    expect(addToGroupForSelection()).toBe("add_to_group");
    expect(canAddToGroupSelection()).toBe(true);
  });

  it("needs a selection at all", () => {
    seed([track("t1", [groupLayerFixture({ id: "g" }), colorLayer("a")])]);
    expect(addToGroupForSelection()).toBe("needs_selection");
    expect(canAddToGroupSelection()).toBe(false);
  });

  // Zero and two-or-more are one state, unlike the member half: both are fixed
  // by picking the destination. With two, nothing says which one it is.
  it("needs exactly one Group clip, whether none or two are selected", () => {
    seed([
      track("t1", [
        groupLayerFixture({ id: "g" }),
        groupLayerFixture({ id: "g2", compositionId: "comp-two" }),
        colorLayer("a"),
      ]),
    ]);
    setLayerSelection("a", ["a"]);
    expect(addToGroupForSelection()).toBe("needs_one_group");
    setLayerSelection("g", ["g", "g2", "a"]);
    expect(addToGroupForSelection()).toBe("needs_one_group");
  });

  // The other half of the shape, and its own state: the destination is there,
  // the thing to put in it is not.
  it("needs a member besides the Group itself", () => {
    seed([track("t1", [groupLayerFixture({ id: "g" })])]);
    setLayerSelection("g", ["g"]);
    expect(addToGroupForSelection()).toBe("needs_member");
  });

  it("refuses when a member or its lane is locked", () => {
    seed([
      track("t1", [
        groupLayerFixture({ id: "g" }),
        colorLayer("a", { locked: true }),
      ]),
    ]);
    setLayerSelection("g", ["g", "a"]);
    expect(addToGroupForSelection()).toBe("locked");

    seed([track("t1", [groupLayerFixture({ id: "g" }), colorLayer("a")], true)]);
    setLayerSelection("g", ["g", "a"]);
    expect(addToGroupForSelection()).toBe("locked");
  });

  // The destination is the one selected layer whose lock does NOT block the
  // gesture, because the op never writes it. A gate stricter than the actor
  // would grey out a move the actor accepts.
  it("lets a locked Group clip take members", () => {
    seed([
      track("t1", [groupLayerFixture({ id: "g", locked: true }), colorLayer("a")]),
    ]);
    setLayerSelection("g", ["g", "a"]);
    expect(addToGroupForSelection()).toBe("add_to_group");
  });

  // The gesture-side half of the actor's `InvalidArgument`. The destination's
  // zero is `t_start - src_in`, so a trimmed-in Group answers differently from
  // an untrimmed one at the same placement — which is exactly the case a single
  // `t_start` comparison would get wrong.
  it("refuses a member that would land before the destination's zero", () => {
    seed([
      track("t1", [
        groupLayerFixture({ id: "g", tStartUs: 2_000_000, tEndUs: 4_000_000 }),
        colorLayer("a", { t_start_us: 1_000_000, t_end_us: 1_500_000 }),
      ]),
    ]);
    setLayerSelection("g", ["g", "a"]);
    expect(addToGroupForSelection()).toBe("starts_before_group");
    expect(canAddToGroupSelection()).toBe(false);

    // Same placement, trimmed in by 1 s: the composition's 0 is now a second
    // earlier on this clock, and the member fits.
    seed([
      track("t1", [
        groupLayerFixture({
          id: "g",
          tStartUs: 2_000_000,
          tEndUs: 4_000_000,
          srcInUs: 1_000_000,
          srcOutUs: 3_000_000,
        }),
        colorLayer("a", { t_start_us: 1_000_000, t_end_us: 1_500_000 }),
      ]),
    ]);
    setLayerSelection("g", ["g", "a"]);
    expect(addToGroupForSelection()).toBe("add_to_group");
  });

  // "All in one composition" is structural, not checked: `selectedWithTracks`
  // walks the FOCUSED composition only, so a layer selected elsewhere is not
  // found and the answer is the one the focused composition alone gives.
  it("ignores a selected layer that lives in another composition", () => {
    useProjectStore.getState().apply(
      summaryFixture({
        root: { tracks: [track("t1", [groupLayerFixture({ id: "g" }), colorLayer("a")])] },
        groups: [
          compositionFixture({
            id: "comp-group",
            tracks: [track("t2", [colorLayer("inner")])],
          }),
        ],
      }),
    );
    setLayerSelection("g", ["g", "a", "inner"]);
    expect(addToGroupForSelection()).toBe("add_to_group");
  });
});

describe("addToGroupTarget", () => {
  // Unlike `selectedGroupLayer`, the rest of the selection is tolerated — it is
  // what would move — and a destination is named even when the gesture is not
  // live, so a greyed row can still say which Group it meant.
  it("answers the one selected Group whatever else is selected", () => {
    seed([
      track("t1", [
        groupLayerFixture({ id: "g" }),
        groupLayerFixture({ id: "g2", compositionId: "comp-two" }),
        colorLayer("a", { locked: true }),
      ]),
    ]);
    expect(addToGroupTarget()).toBeNull();
    setLayerSelection("g", ["g", "a"]);
    expect(addToGroupTarget()?.id).toBe("g");
    // Named even though the gesture is refused — the locked member is what the
    // greyed row would have to explain.
    expect(addToGroupForSelection()).toBe("locked");
    setLayerSelection("g", ["g", "g2", "a"]);
    expect(addToGroupTarget()).toBeNull();
  });
});

describe("selectedGroupLayer", () => {
  it("answers the one selected Group layer, and null otherwise", () => {
    seed([track("t1", [groupLayerFixture({ id: "g" }), colorLayer("a")])]);
    expect(selectedGroupLayer()).toBeNull();
    setLayerSelection("g", ["g"]);
    expect(selectedGroupLayer()?.id).toBe("g");
    setLayerSelection("a", ["a"]);
    expect(selectedGroupLayer()).toBeNull();
    setLayerSelection("g", ["g", "a"]);
    expect(selectedGroupLayer()).toBeNull();
  });

  // A non-plain Group is still a Group: entering one is always allowed, and only
  // the expansion is gated.
  it("answers a non-plain Group too", () => {
    seed([track("t1", [groupLayerFixture({ id: "g", opacity: num(0.25) })])]);
    setLayerSelection("g", ["g"]);
    expect(selectedGroupLayer()?.id).toBe("g");
  });
});
