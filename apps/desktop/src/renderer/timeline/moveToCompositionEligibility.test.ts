import { afterEach, describe, expect, it } from "vitest";

import {
  canMoveSelectionToRoot,
  moveDestinations,
  moveLandingUs,
  moveToCompositionForSelection,
  moveToCompositionSet,
  moveToRootTarget,
} from "./moveToCompositionEligibility";
import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
  ROOT_ID,
} from "../testing/summaryFixture";

const G1 = "comp-g1";
const G2 = "comp-g2";

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

/// The locale stub: keys through, except the derived `Group N` the naming
/// falls back to, which has to interpolate or two unlabelled compositions would
/// be indistinguishable in the ordering.
const t = (key: string, values: Record<string, unknown> = {}): string =>
  key === "timeline.group_derived_name" ? `Group ${values.n}` : key;

/// The name the root's row carries — the Panel kind's own title, since the root
/// has no name of its own.
const ROOT_NAME = "dock_workspace.panels.timeline";

/// `root ─(ref-g1 @ 2 s)→ g1 ─(ref-g2 @ 0)→ g2`, with a clip of its own in each
/// composition. Two labelled Groups so the by-name ordering has something to
/// order.
function nested(): ProjectSummary {
  return summaryFixture({
    root: {
      duration_us: 8_000_000,
      tracks: [
        track("t-root", [
          colorLayer("root-clip"),
          groupLayerFixture({
            id: "ref-g1",
            compositionId: G1,
            compositionLabel: "Beta",
            tStartUs: 2_000_000,
            tEndUs: 6_000_000,
          }),
        ]),
      ],
    },
    groups: [
      compositionFixture({
        id: G1,
        label: "Beta",
        duration_us: 4_000_000,
        tracks: [
          track("t-g1", [
            colorLayer("inner-a", { t_start_us: 500_000, t_end_us: 1_500_000 }),
            colorLayer("inner-b", { t_start_us: 2_000_000, t_end_us: 3_000_000 }),
            groupLayerFixture({
              id: "ref-g2",
              compositionId: G2,
              compositionLabel: "Alpha",
              tStartUs: 3_000_000,
              tEndUs: 4_000_000,
            }),
          ]),
        ],
      }),
      compositionFixture({
        id: G2,
        label: "Alpha",
        duration_us: 1_000_000,
        tracks: [track("t-g2", [colorLayer("deep")])],
      }),
    ],
  });
}

/// Seed a project and say which composition holds the keyboard. `apply(null)`
/// first so the anchor store reconciles from scratch — the fixtures share a
/// project id, and the same-project branch would keep the previous focus.
function seed(summary: ProjectSummary, focusedId: string = ROOT_ID): void {
  useProjectStore.getState().apply(null);
  useProjectStore.getState().apply(summary);
  useCompositionAnchorStore.setState({ focusedId });
}

afterEach(() => {
  clearLayerSelection();
  setPlayheadTimeUs(0);
  useProjectStore.getState().apply(null);
});

describe("moveToCompositionForSelection", () => {
  it("moves an unlocked selection that has somewhere to go", () => {
    seed(nested());
    setLayerSelection("root-clip", ["root-clip"]);
    expect(moveToCompositionForSelection()).toBe("move_to_composition");
  });

  it("needs a selection at all", () => {
    seed(nested());
    expect(moveToCompositionForSelection()).toBe("needs_selection");
  });

  it("refuses when a member or its lane is locked", () => {
    const locked = nested();
    locked.compositions[ROOT_ID]!.tracks[0]!.layers[0]!.locked = true;
    seed(locked);
    setLayerSelection("root-clip", ["root-clip"]);
    expect(moveToCompositionForSelection()).toBe("locked");

    const lockedLane = nested();
    lockedLane.compositions[ROOT_ID]!.tracks[0]!.locked = true;
    seed(lockedLane);
    setLayerSelection("root-clip", ["root-clip"]);
    expect(moveToCompositionForSelection()).toBe("locked");
  });

  // A refusal about the WHOLE selection, not about one member: taking the
  // unlocked half would leave a split set the user did not ask for.
  it("refuses the whole set when one member of it is locked", () => {
    const summary = nested();
    summary.compositions[G1]!.tracks[0]!.layers[1]!.locked = true;
    seed(summary, G1);
    setLayerSelection("inner-a", ["inner-a", "inner-b"]);
    expect(moveToCompositionForSelection()).toBe("locked");
  });

  // Nowhere to go is not a selection problem, so it is its own answer: the
  // project holds one composition and the clips are in it.
  it("answers no_destination when the project holds nowhere else", () => {
    seed(summaryFixture({ root: { tracks: [track("t-root", [colorLayer("a")])] } }));
    setLayerSelection("a", ["a"]);
    expect(moveToCompositionForSelection()).toBe("no_destination");
  });

  // "All in one composition" is structural, not checked: the walk covers the
  // FOCUSED composition only, so a layer selected elsewhere is not found and
  // the answer is the one the focused composition alone gives.
  it("ignores a selected layer that lives in another composition", () => {
    seed(nested(), G1);
    setLayerSelection("inner-a", ["inner-a", "root-clip"]);
    expect(moveToCompositionForSelection()).toBe("move_to_composition");
    expect(moveToCompositionSet()?.layerIds).toEqual(["inner-a"]);
  });
});

// The Edit menu row, the palette entry and any bound key carry no destination,
// so they mean the root and nothing else. Taking whichever Group sorted first
// would make the landing depend on alphabetical order.
describe("canMoveSelectionToRoot", () => {
  it("is live for a selection inside a Group, which is the direction it exists for", () => {
    seed(nested(), G1);
    setLayerSelection("inner-a", ["inner-a"]);
    expect(canMoveSelectionToRoot()).toBe(true);
    expect(moveToRootTarget()).toBe(ROOT_ID);
  });

  // The submenu still offers both Groups here; only the destination-less form
  // greys, because the one destination it can name is the one they are in.
  it("greys for a selection already in the root, even with Groups to move into", () => {
    seed(nested());
    setLayerSelection("root-clip", ["root-clip"]);
    expect(moveToCompositionForSelection()).toBe("move_to_composition");
    expect(canMoveSelectionToRoot()).toBe(false);
    expect(moveToRootTarget()).toBeNull();
    expect(
      moveDestinations(t).filter((d) => d.state === "eligible"),
    ).not.toHaveLength(0);
  });

  it("greys with no selection and when the selection is locked", () => {
    seed(nested(), G1);
    expect(canMoveSelectionToRoot()).toBe(false);

    const locked = nested();
    locked.compositions[G1]!.tracks[0]!.layers[0]!.locked = true;
    seed(locked, G1);
    setLayerSelection("inner-a", ["inner-a"]);
    expect(canMoveSelectionToRoot()).toBe(false);
  });

  // The cycle rule can never bar the ROOT: nothing may reference it
  // (`RootReferenced`), so no Group a member shows can reach it. A selected
  // Group clip therefore travels back into the film like any other layer, and
  // the only thing that ever greys this form is being there already.
  it("stays live for a selected Group clip, which no cycle can bar from the root", () => {
    seed(nested(), G1);
    setLayerSelection("ref-g2", ["ref-g2"]);
    expect(canMoveSelectionToRoot()).toBe(true);
  });
});

describe("moveDestinations", () => {
  it("lists every composition, the root first and the Groups by name", () => {
    seed(nested(), G1);
    setLayerSelection("inner-a", ["inner-a"]);
    expect(moveDestinations(t).map((d) => d.compositionId)).toEqual([
      ROOT_ID,
      G2,
      G1,
    ]);
    expect(moveDestinations(t).map((d) => d.name)).toEqual([
      ROOT_NAME,
      "Alpha",
      "Beta",
    ]);
  });

  // The root is an ordinary destination, and the one this gesture exists for:
  // carrying a clip back out of a Group and into the film.
  it("offers the root to a selection inside a Group", () => {
    seed(nested(), G1);
    setLayerSelection("inner-a", ["inner-a"]);
    const root = moveDestinations(t).find((d) => d.compositionId === ROOT_ID);
    expect(root?.state).toBe("eligible");
  });

  // Present and greyed, never absent: a row that says "already here" tells the
  // user where they are, and a missing one teaches nothing.
  it("keeps the selection's own composition in the list, marked already_there", () => {
    seed(nested(), G1);
    setLayerSelection("inner-a", ["inner-a"]);
    const rows = moveDestinations(t);
    expect(rows.find((d) => d.compositionId === G1)?.state).toBe("already_there");
    expect(rows.find((d) => d.compositionId === ROOT_ID)?.state).toBe("eligible");
  });

  // Reachable HERE where `addToGroupState` has no cycle state: this gesture
  // names its destination, so a MEMBER may be a Group clip.
  it("marks every composition a selected Group clip reaches as a cycle", () => {
    seed(nested());
    setLayerSelection("ref-g1", ["ref-g1"]);
    const byId = new Map(moveDestinations(t).map((d) => [d.compositionId, d]));
    // The composition the clip shows, and the one nested inside that: a Group
    // moved into either would end up containing itself.
    expect(byId.get(G1)?.state).toBe("cycle");
    expect(byId.get(G2)?.state).toBe("cycle");
    expect(byId.get(ROOT_ID)?.state).toBe("already_there");
    // Every row refused, so the catalogued form has nothing to run — the
    // submenu still shows all three, each saying why.
    expect(moveToCompositionForSelection()).toBe("no_destination");
  });

  it("leaves the other compositions alone when the Group clip is not selected", () => {
    seed(nested());
    setLayerSelection("root-clip", ["root-clip"]);
    const byId = new Map(moveDestinations(t).map((d) => [d.compositionId, d]));
    expect(byId.get(G1)?.state).toBe("eligible");
    expect(byId.get(G2)?.state).toBe("eligible");
  });
});

describe("moveLandingUs", () => {
  // The one moment (ADR 0053 decision 2) read on the destination's own clock:
  // the root reads it unchanged, a Group reads it through its placement.
  it("lands the set at the destination's reading of the playhead", () => {
    seed(nested(), G1);
    setPlayheadTimeUs(3_000_000);
    expect(moveLandingUs(ROOT_ID)).toEqual({
      tStartUs: 3_000_000,
      offScreen: false,
    });
    // g1's clip starts at 2 s untrimmed, so its own zero sits at root 2 s.
    expect(moveLandingUs(G1)).toEqual({ tStartUs: 1_000_000, offScreen: false });
  });

  // A Group placed nowhere at this moment has no reading, and refusing would
  // make a destination unreachable for the length of a scrub.
  it("falls back to the destination's own zero when it is off screen", () => {
    seed(nested());
    setPlayheadTimeUs(500_000);
    expect(moveLandingUs(ROOT_ID)).toEqual({ tStartUs: 500_000, offScreen: false });
    expect(moveLandingUs(G1)).toEqual({ tStartUs: 0, offScreen: true });
  });

  // Nothing places an orphan, so no root moment has a reading on its axis.
  it("falls back for a composition the root does not reach", () => {
    const orphaned = nested();
    orphaned.compositions[ROOT_ID]!.tracks[0]!.layers = [colorLayer("root-clip")];
    seed(orphaned);
    setPlayheadTimeUs(3_000_000);
    expect(moveLandingUs(G1)).toEqual({ tStartUs: 0, offScreen: true });
  });
});

describe("moveToCompositionSet", () => {
  // The earliest member anchors, so the set STARTS at the destination's
  // playhead and no other member can land before composition time 0.
  it("names the earliest-starting member as the anchor", () => {
    seed(nested(), G1);
    setLayerSelection("inner-b", ["inner-b", "inner-a"]);
    const set = moveToCompositionSet();
    expect(set?.anchorLayerId).toBe("inner-a");
    expect(set?.layerIds.slice().sort()).toEqual(["inner-a", "inner-b"]);
  });

  it("answers null with nothing selected", () => {
    seed(nested());
    expect(moveToCompositionSet()).toBeNull();
  });
});
