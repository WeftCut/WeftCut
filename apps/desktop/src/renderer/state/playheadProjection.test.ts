import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnimTrack, CompositionSummary, LayerSummary, TrackSummary } from "../ipc";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import {
  openComposition,
  orphanPlayheadUs,
  previewRenderTargetId,
  setPreviewRenderTarget,
  switchAnchor,
  syncOpenCompositions,
  useCompositionAnchorStore,
} from "./compositionAnchorStore";
import {
  focusedPlayheadUs,
  focusedRootUs,
  playheadClockUs,
  playheadLocalUs,
  previewClockUs,
  previewLocalUs,
  seekLocalUs,
  seekPreviewLocalUs,
  setPlayheadFromPreview,
} from "./playheadProjection";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";

// One moment, many coordinate systems (ADR 0053 decision 2). These pin the half
// the pure projection cannot: which store the answer comes out of, which store a
// scrub goes into, and the one composition that has neither — an orphan, whose
// Panel runs on an axis of its own and must leave the film alone.

const S = 1_000_000;

const stat = <T,>(value: T): AnimTrack<T> => ({ mode: "Static", value });

function colorLayer(id: string, tEndUs: number): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: tEndUs,
    kind: "Color",
    color_hint: "#000000",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Color",
      color: stat({ r: 0, g: 0, b: 0, a: 255 }),
      width: 16,
      height: 9,
    },
  };
}

function refLayer(id: string, compositionId: string, tStartUs: number): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: tStartUs,
    t_end_us: tStartUs + 4 * S,
    kind: "CompositionRef",
    color_hint: "#000000",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "CompositionRef",
      composition_id: compositionId,
      composition_label: null,
      src_in_us: 0,
      src_out_us: 4 * S,
      x: stat(0),
      y: stat(0),
      scale_x: stat(1),
      scale_y: stat(1),
      scale_linked: true,
      rotation_deg: stat(0),
      opacity: stat(1),
      anchor_x: stat(0.5),
      anchor_y: stat(0.5),
    },
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
    transient: true,
    layers,
  };
}

const G1 = "comp-g1";
const ORPHAN = "comp-orphan";

/// A 20 s root holding the same 5 s Group twice — at 2 s and at 12 s, each
/// placement 4 s long — plus a composition nothing references at all.
function project() {
  const g1: CompositionSummary = compositionFixture({
    id: G1,
    label: "Lower third",
    duration_us: 5 * S,
    tracks: [track("t-g1", [colorLayer("inner-g1", 5 * S)])],
  });
  const orphan: CompositionSummary = compositionFixture({
    id: ORPHAN,
    label: "Nobody's",
    duration_us: 3 * S,
    tracks: [track("t-orphan", [colorLayer("inner-orphan", 3 * S)])],
  });
  return summaryFixture({
    project_id: "p-projection",
    root: {
      duration_us: 20 * S,
      tracks: [
        track("t-root", [
          colorLayer("root-color", 20 * S),
          refLayer("early", G1, 2 * S),
          refLayer("late", G1, 12 * S),
        ]),
      ],
    },
    groups: [g1, orphan],
  });
}

beforeEach(() => {
  useProjectStore.getState().apply(null);
  setPlayheadTimeUs(0);
  useProjectStore.getState().apply(project());
});

afterEach(() => {
  useProjectStore.getState().apply(null);
  setPlayheadTimeUs(0);
});

describe("reading the moment", () => {
  it("gives the root's Panel the film's own clock", () => {
    setPlayheadTimeUs(3 * S);
    expect(playheadLocalUs(ROOT_ID)).toBe(3 * S);
    // The unbound row the Dock builds before a root is named reads the same.
    expect(playheadLocalUs(null)).toBe(3 * S);
  });

  it("gives a Group's Panel the anchor's offset of it", () => {
    openComposition(G1, "late");
    setPlayheadTimeUs(13 * S);
    expect(playheadLocalUs(G1)).toBe(1 * S);
  });

  it("draws no playhead where the anchored placement is not on screen", () => {
    openComposition(G1, "late");
    setPlayheadTimeUs(3 * S);
    expect(playheadLocalUs(G1)).toBeNull();
  });

  it("still answers an EDIT there, because a composition's clock never stops", () => {
    openComposition(G1, "late");
    setPlayheadTimeUs(17 * S);
    expect(playheadLocalUs(G1)).toBeNull();
    expect(playheadClockUs(G1)).toBe(5 * S);
  });

  it("reads the editing target, whichever Panel holds the keyboard", () => {
    openComposition(G1, "late");
    setPlayheadTimeUs(13 * S);
    expect(focusedPlayheadUs()).toBe(1 * S);
    expect(focusedRootUs(2 * S)).toBe(14 * S);
  });
});

describe("writing the moment", () => {
  it("turns a scrub inside a Group into the one moment", () => {
    openComposition(G1, "late");
    seekLocalUs(G1, 1 * S);
    expect(playheadTimeUs()).toBe(13 * S);
  });

  it("clamps against the film's length, not the anchored placement's", () => {
    // g1 is 5 s long and its placement covers only 4 s of that, so its own
    // 4.5 s lies past the window — a position the Panel can still point at, and
    // one the root is long enough to hold.
    openComposition(G1, "late");
    seekLocalUs(G1, 4_500_000);
    expect(playheadTimeUs()).toBe(16_500_000);
  });

  it("sends the same local position elsewhere once the anchor moves", () => {
    openComposition(G1, "late");
    seekLocalUs(G1, 1 * S);
    expect(playheadTimeUs()).toBe(13 * S);

    expect(switchAnchor(G1, "early")).toBe(true);
    seekLocalUs(G1, 1 * S);
    expect(playheadTimeUs()).toBe(3 * S);
  });
});

describe("an orphan composition", () => {
  it("scrubs on its own axis and leaves the film where it is", () => {
    openComposition(ORPHAN, null);
    setPlayheadTimeUs(2 * S);

    seekLocalUs(ORPHAN, 500_000);

    expect(playheadTimeUs()).toBe(2 * S);
    expect(orphanPlayheadUs(ORPHAN)).toBe(500_000);
    expect(playheadLocalUs(ORPHAN)).toBe(500_000);
  });

  it("clamps to its own last frame, the only timeline its playhead is on", () => {
    openComposition(ORPHAN, null);
    seekLocalUs(ORPHAN, 99 * S);
    // 3 s @ 30 fps → last frame anchor is frame 89 at 2 966 667 µs.
    expect(orphanPlayheadUs(ORPHAN)).toBe(2_966_667);
  });

  it("opens at 0 — an axis nothing places has no other opening position", () => {
    openComposition(ORPHAN, null);
    setPlayheadTimeUs(2 * S);
    expect(playheadLocalUs(ORPHAN)).toBe(0);
  });
});

describe("the preview's clock", () => {
  it("lifts the engine's emit into root time and hands back the engine's own", () => {
    openComposition(G1, "late");

    setPlayheadFromPreview(1 * S);

    expect(playheadTimeUs()).toBe(13 * S);
    expect(previewLocalUs(playheadTimeUs())).toBe(1 * S);
  });

  it("is the identity while the root is what the preview draws", () => {
    setPlayheadFromPreview(4 * S);
    expect(playheadTimeUs()).toBe(4 * S);
    expect(previewLocalUs(4 * S)).toBe(4 * S);
  });
});

/// The pain this feature answers: edit inside a Group and watch the film.
describe("a locked render target", () => {
  it("scrubs the film with a drag on the Group's own playhead", () => {
    setPreviewRenderTarget(ROOT_ID);
    openComposition(G1, "late");

    seekLocalUs(G1, 1 * S);

    expect(playheadTimeUs()).toBe(13 * S);
    expect(previewLocalUs(playheadTimeUs())).toBe(13 * S);
  });

  // A lock is not a tab, so closing the film's own timeline leaves it standing.
  it("still draws the film once the root's own tab is closed", () => {
    setPreviewRenderTarget(ROOT_ID);
    openComposition(G1, "late");
    syncOpenCompositions([G1]);
    setPlayheadTimeUs(13 * S);

    expect(previewRenderTargetId()).toBe(ROOT_ID);
    expect(previewLocalUs(13 * S)).toBe(13 * S);
  });

  // A lock opens no tab, so the target has no anchor to read: its path comes
  // from the project instead, which is the shortest one from the root.
  it("reads a Group with no timeline open through its own path from the root", () => {
    setPreviewRenderTarget(G1);
    setPlayheadTimeUs(3 * S);

    expect(previewLocalUs(3 * S)).toBe(1 * S);
    expect(previewClockUs()).toBe(1 * S);
  });

  it("runs on the target's own clock past the placement that shows it", () => {
    setPreviewRenderTarget(G1);
    // The early placement covers root [2 s, 6 s); 8 s reads as 6 s on a
    // composition only 5 s long, which is a moment it has nothing to draw at.
    expect(previewLocalUs(8 * S)).toBe(6 * S);
  });

  it("lifts the target's emit into root time, whichever timeline has the keyboard", () => {
    setPreviewRenderTarget(G1);

    setPlayheadFromPreview(1 * S);

    expect(useCompositionAnchorStore.getState().focusedId).toBe(ROOT_ID);
    expect(playheadTimeUs()).toBe(3 * S);
  });

  it("takes the preview transport's own seeks on the target's clock", () => {
    setPreviewRenderTarget(G1);

    seekPreviewLocalUs(1 * S);

    expect(playheadTimeUs()).toBe(3 * S);
  });

  // An orphan runs on an axis of its own, so nothing it does reaches the film —
  // and a target locked elsewhere simply holds at the last root moment.
  it("holds where it is while an orphan's Panel scrubs", () => {
    setPreviewRenderTarget(ROOT_ID);
    openComposition(ORPHAN, null);
    setPlayheadTimeUs(5 * S);

    seekLocalUs(ORPHAN, 1 * S);

    expect(playheadTimeUs()).toBe(5 * S);
    expect(previewLocalUs(playheadTimeUs())).toBe(5 * S);
  });

  // The engine's clock floors at zero and then emits the floor back; taken for
  // the film's own moment it would make everything before the target
  // unreachable while the lock stands.
  it("does not let the engine's zero floor pull the film to the target's start", () => {
    setPreviewRenderTarget(G1);
    setPlayheadTimeUs(0);

    // What the transport hands the engine for a moment before the placement...
    expect(previewLocalUs(0)).toBe(-2 * S);
    // ...and what the engine emits back once its clock has floored it.
    setPlayheadFromPreview(0);

    expect(playheadTimeUs()).toBe(0);
  });

  it("still writes the film's moment when the target genuinely reads zero", () => {
    setPreviewRenderTarget(G1);
    setPlayheadTimeUs(2 * S);

    setPlayheadFromPreview(0);

    expect(playheadTimeUs()).toBe(2 * S);
  });

  it("parks an ORPHAN target on its own axis instead of moving the film", () => {
    setPreviewRenderTarget(ORPHAN);
    setPlayheadTimeUs(2 * S);

    setPlayheadFromPreview(500_000);

    expect(playheadTimeUs()).toBe(2 * S);
    expect(orphanPlayheadUs(ORPHAN)).toBe(500_000);
    expect(previewLocalUs(playheadTimeUs())).toBe(500_000);
  });
});

describe("the anchor store's own reset", () => {
  it("forgets every orphan position when the project changes", () => {
    openComposition(ORPHAN, null);
    seekLocalUs(ORPHAN, 500_000);
    useProjectStore.getState().apply(summaryFixture({ project_id: "p-other" }));
    expect(useCompositionAnchorStore.getState().orphanPlayheads.size).toBe(0);
  });
});
