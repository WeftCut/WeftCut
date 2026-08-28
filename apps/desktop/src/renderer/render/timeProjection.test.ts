import { describe, expect, it } from "vitest";

import { timeUsAtFrame } from "../frames";
import type { AnimTrack, CompositionSummary, LayerSummary, TrackSummary } from "../ipc";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import type { CompositionCrumb } from "../state/compositionAnchorStore";
import {
  anchorFrame,
  localClockUs,
  localToRoot,
  rootToLocal,
} from "./timeProjection";

// The playhead is one moment in root time and every Panel reads it through its
// own anchor (ADR 0053). What is pinned here is the part a Panel cannot
// re-derive: which root moments a Group is on screen at, where the same moment
// lands on its own clock, and — the reason the anchor exists at all — that two
// placements of one Group answer differently.

const S = 1_000_000;

const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });

const colorLayer = (id: string, tStartUs: number, tEndUs: number): LayerSummary => ({
  id,
  label: null,
  t_start_us: tStartUs,
  t_end_us: tEndUs,
  kind: "Color",
  color_hint: "#4488cc",
  enabled: true,
  locked: false,
  params: {
    kind: "Color",
    color: { mode: "Static", value: { r: 10, g: 20, b: 30, a: 255 } },
    width: 1920,
    height: 1080,
  },
  effects: [],
});

const refLayer = (
  id: string,
  compositionId: string,
  tStartUs: number,
  tEndUs: number,
  srcInUs = 0,
): LayerSummary => ({
  id,
  label: null,
  t_start_us: tStartUs,
  t_end_us: tEndUs,
  kind: "CompositionRef",
  color_hint: "#886644",
  enabled: true,
  locked: false,
  params: {
    kind: "CompositionRef",
    composition_id: compositionId,
    composition_label: null,
    src_in_us: srcInUs,
    src_out_us: srcInUs + (tEndUs - tStartUs),
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
  effects: [],
});

const track = (id: string, layers: LayerSummary[]): TrackSummary => ({
  id,
  kind: "Video",
  label: id,
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: null,
  transient: true,
  layers,
});

const comp = (
  id: string,
  layers: LayerSummary[],
  over: Partial<CompositionSummary> = {},
) => compositionFixture({ id, tracks: [track(`${id}-t`, layers)], ...over });

const crumb = (layerId: string | null, compositionId: string): CompositionCrumb => ({
  layerId,
  compositionId,
});

/// root ─(ref-g1 at 12 s)→ g1 ─(ref-g2 at 1 s)→ g2. Every placement is 4 s
/// long and starts at the child's own 0, so an offset is a plain shift.
function nested() {
  const g2 = comp("g2", [colorLayer("in-g2", 0, 4 * S)], { duration_us: 4 * S });
  const g1 = comp("g1", [refLayer("ref-g2", "g2", 1 * S, 5 * S)], {
    duration_us: 5 * S,
  });
  return summaryFixture({
    root: {
      duration_us: 20 * S,
      tracks: [track("root-t", [refLayer("ref-g1", "g1", 12 * S, 16 * S)])],
    },
    groups: [g1, g2],
  });
}

describe("anchorFrame", () => {
  it("is the identity on the root, on screen at every moment", () => {
    const frame = anchorFrame(nested(), [])!;
    expect(frame.offsetUs).toBe(0);
    expect(frame.windowStartUs).toBe(Number.NEGATIVE_INFINITY);
    expect(frame.windowEndUs).toBe(Number.POSITIVE_INFINITY);
  });

  it("narrows the window at every step and accumulates the offset", () => {
    const path = [crumb("ref-g1", "g1"), crumb("ref-g2", "g2")];
    const frame = anchorFrame(nested(), path)!;
    // g1's 0 sits at root 12 s; g2's own 0 sits 1 s further in, and its
    // placement ends where g1's does (root 16 s), not 4 s later.
    expect(frame.offsetUs).toBe(13 * S);
    expect(frame.windowStartUs).toBe(13 * S);
    expect(frame.windowEndUs).toBe(16 * S);
  });

  it("has no frame for an orphan — nothing places it, so it has no root time", () => {
    const summary = summaryFixture({
      root: { duration_us: 5 * S },
      groups: [comp("orphan", [colorLayer("in-orphan", 0, S)])],
    });
    expect(anchorFrame(summary, [crumb(null, "orphan")])).toBeNull();
  });

  it("has no frame for a crumb whose Group clip the summary has lost", () => {
    const summary = nested();
    summary.compositions[ROOT_ID]!.tracks[0]!.layers = [];
    expect(anchorFrame(summary, [crumb("ref-g1", "g1")])).toBeNull();
  });
});

describe("rootToLocal", () => {
  it("is the identity for the root", () => {
    expect(rootToLocal(nested(), [], 7 * S)).toBe(7 * S);
  });

  it("reads a nested Group's own clock", () => {
    const path = [crumb("ref-g1", "g1"), crumb("ref-g2", "g2")];
    // Root 14 s is 1 s into g2's placement, and g2's placement starts at its 0.
    expect(rootToLocal(nested(), path, 14 * S)).toBe(1 * S);
  });

  it("draws nothing outside the window it was anchored through", () => {
    const path = [crumb("ref-g1", "g1")];
    expect(rootToLocal(nested(), path, 11 * S)).toBeNull();
    expect(rootToLocal(nested(), path, 12 * S)).toBe(0);
    // The window is half-open: the moment the placement ends belongs to what
    // comes after it.
    expect(rootToLocal(nested(), path, 16 * S)).toBeNull();
  });

  it("re-snaps onto the lattice, so a projected moment is a frame the Group has", () => {
    // A Group entered on frame 2 at 30 fps: `anchor(4) − anchor(2)` misses
    // `anchor(2)` by a µs, and a child layer starting there would read as not
    // yet active for exactly that frame.
    const g = comp("g", [colorLayer("in-g", 0, S)], { duration_us: S });
    const summary = summaryFixture({
      root: {
        duration_us: 5 * S,
        tracks: [
          track("root-t", [
            refLayer("ref-g", "g", timeUsAtFrame(2, 30, 1), timeUsAtFrame(20, 30, 1)),
          ]),
        ],
      },
      groups: [g],
    });
    const local = rootToLocal(summary, [crumb("ref-g", "g")], timeUsAtFrame(4, 30, 1));
    expect(local).toBe(timeUsAtFrame(2, 30, 1));
  });

  it("tells two placements of one Group apart by the anchor alone", () => {
    const g = comp("g", [colorLayer("in-g", 0, 2 * S)], { duration_us: 2 * S });
    const summary = summaryFixture({
      root: {
        duration_us: 20 * S,
        tracks: [
          track("root-t", [
            refLayer("early", "g", 2 * S, 4 * S),
            refLayer("late", "g", 10 * S, 12 * S),
          ]),
        ],
      },
      groups: [g],
    });
    expect(rootToLocal(summary, [crumb("early", "g")], 3 * S)).toBe(1 * S);
    expect(rootToLocal(summary, [crumb("late", "g")], 3 * S)).toBeNull();
    expect(rootToLocal(summary, [crumb("late", "g")], 11 * S)).toBe(1 * S);
  });

  it("has no reading for an orphan", () => {
    const summary = summaryFixture({
      groups: [comp("orphan", [colorLayer("in-orphan", 0, S)])],
    });
    expect(rootToLocal(summary, [crumb(null, "orphan")], 0)).toBeNull();
  });
});

describe("localToRoot", () => {
  it("is the identity for the root", () => {
    expect(localToRoot(nested(), [], 7 * S)).toBe(7 * S);
  });

  it("inverts the projection through a nested anchor", () => {
    const path = [crumb("ref-g1", "g1"), crumb("ref-g2", "g2")];
    expect(localToRoot(nested(), path, 1 * S)).toBe(14 * S);
  });

  it("answers past the window — a Panel can point where its placement does not show", () => {
    // g1's placement ends at root 16 s, but g1 itself is 5 s long: a scrub to
    // its own 4.5 s is a position the Panel can hold, and the moment it names
    // is where the film would be if the placement ran that far.
    expect(localToRoot(nested(), [crumb("ref-g1", "g1")], 4_500_000)).toBe(16_500_000);
  });

  it("moves where the same local position sits when the anchor moves", () => {
    const g = comp("g", [colorLayer("in-g", 0, 2 * S)], { duration_us: 2 * S });
    const summary = summaryFixture({
      root: {
        duration_us: 20 * S,
        tracks: [
          track("root-t", [
            refLayer("early", "g", 2 * S, 4 * S),
            refLayer("late", "g", 10 * S, 12 * S),
          ]),
        ],
      },
      groups: [g],
    });
    expect(localToRoot(summary, [crumb("early", "g")], 1 * S)).toBe(3 * S);
    expect(localToRoot(summary, [crumb("late", "g")], 1 * S)).toBe(11 * S);
  });

  it("has nothing to write for an orphan", () => {
    const summary = summaryFixture({
      groups: [comp("orphan", [colorLayer("in-orphan", 0, S)])],
    });
    expect(localToRoot(summary, [crumb(null, "orphan")], S)).toBeNull();
  });
});

describe("localClockUs", () => {
  it("keeps running where the drawn playhead stops", () => {
    const frame = anchorFrame(nested(), [crumb("ref-g1", "g1")])!;
    expect(rootToLocal(nested(), [crumb("ref-g1", "g1")], 17 * S)).toBeNull();
    expect(localClockUs(frame, 17 * S)).toBe(5 * S);
  });
});
