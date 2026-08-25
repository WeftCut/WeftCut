import { describe, expect, it } from "vitest";
import { DEFAULT_TRACK_HEIGHT, type MeasuredTrackRow } from "./geometry";
import {
  marqueeHitClips,
  normalizeBox,
  resolveMarqueeSelection,
  type MarqueeBox,
} from "./marquee";
import type { GroupSummary, LayerSummary, TrackSummary } from "../ipc";

function layer(partial: Partial<LayerSummary>): LayerSummary {
  return {
    id: "L",
    kind: "VideoClip",
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "VideoClip" } as LayerSummary["params"],
    effects: [],
    ...partial,
  };
}

function audioLayer(partial: Partial<LayerSummary>): LayerSummary {
  return layer({
    kind: "Audio",
    params: { kind: "Audio" } as LayerSummary["params"],
    ...partial,
  });
}

function track(partial: Partial<TrackSummary>): TrackSummary {
  return {
    id: "T",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [],
    ...partial,
  };
}

// Every y literal below reads against the bands `layerSliceRect` derives for a
// lane measured at `[ROW_TOP, ROW_TOP + DEFAULT_TRACK_HEIGHT)`:
//   full   [104, 152)
//   top    [104, 127)      midline gap [127, 128)
//   bottom [128, 152)
// and every x literal against `PX_PER_SEC`, so the default 1 s layer spans
// [0, 100).
const ROW_TOP = 100;
const PX_PER_SEC = 100;

function row(trackId: string): MeasuredTrackRow {
  return { trackId, top: ROW_TOP, bottom: ROW_TOP + DEFAULT_TRACK_HEIGHT };
}

function box(x0: number, y0: number, x1: number, y1: number): MarqueeBox {
  return { x0, y0, x1, y1 };
}

/// A track whose visual and audio layers overlap in time, which is the
/// combined-row trigger `computeLayerSlices` looks for.
function combinedRow(): TrackSummary {
  return track({
    id: "t",
    layers: [layer({ id: "v" }), audioLayer({ id: "a" })],
  });
}

function hit(b: MarqueeBox, tracks: readonly TrackSummary[]): string[] {
  return marqueeHitClips({
    box: b,
    rows: tracks.map((t) => row(t.id)),
    tracks,
    pxPerSec: PX_PER_SEC,
  });
}

describe("normalizeBox", () => {
  it("orders a drag in either direction into ascending bounds", () => {
    expect(normalizeBox(box(80, 60, 20, 10))).toEqual(box(20, 10, 80, 60));
    expect(normalizeBox(box(20, 10, 80, 60))).toEqual(box(20, 10, 80, 60));
  });
});

describe("marqueeHitClips", () => {
  it("takes the visual layer alone when the box stays in a combined row's top half", () => {
    expect(hit(box(10, 110, 20, 120), [combinedRow()])).toEqual(["v"]);
  });

  it("takes the audio layer alone when the box stays in a combined row's bottom half", () => {
    expect(hit(box(10, 135, 20, 145), [combinedRow()])).toEqual(["a"]);
  });

  it("takes both halves when the box spans the midline", () => {
    expect(hit(box(10, 110, 20, 145), [combinedRow()])).toEqual(["v", "a"]);
  });

  it("takes neither half from inside the 1px midline gap", () => {
    expect(hit(box(10, 127, 20, 128), [combinedRow()])).toEqual([]);
  });

  it("reaches an unpaired layer across the whole lane interior", () => {
    const tracks = [track({ id: "t", layers: [layer({ id: "v" })] })];
    // 148 sits below the midline a paired layer would respect, and inside the
    // full-height band this one gets instead.
    expect(hit(box(10, 148, 20, 150), tracks)).toEqual(["v"]);
    expect(hit(box(10, 104, 20, 105), tracks)).toEqual(["v"]);
  });

  it("derives the chip's band from the row's own measured height", () => {
    const tracks = [track({ id: "t", layers: [layer({ id: "v" })] })];
    const tall: MeasuredTrackRow = {
      trackId: "t",
      top: ROW_TOP,
      bottom: ROW_TOP + 2 * DEFAULT_TRACK_HEIGHT,
    };
    // Below the interior of a default-height lane, inside a doubled one.
    const reachedOnlyWhenTall = box(10, 200, 20, 205);
    expect(
      marqueeHitClips({
        box: reachedOnlyWhenTall,
        rows: [tall],
        tracks,
        pxPerSec: PX_PER_SEC,
      }),
    ).toEqual(["v"]);
    expect(hit(reachedOnlyWhenTall, tracks)).toEqual([]);
  });

  it("takes a clip far wider than the box", () => {
    const tracks = [
      track({
        id: "t",
        layers: [layer({ id: "long", t_end_us: 60_000_000 })],
      }),
    ];
    expect(hit(box(3000, 110, 3010, 120), tracks)).toEqual(["long"]);
  });

  it("takes nothing from a box that only abuts a chip's edge, on either axis", () => {
    const tracks = [track({ id: "t", layers: [layer({ id: "v" })] })];
    expect(hit(box(100, 110, 120, 120), tracks)).toEqual([]);
    expect(hit(box(-20, 110, 0, 120), tracks)).toEqual([]);
    expect(hit(box(10, 152, 20, 160), tracks)).toEqual([]);
    expect(hit(box(10, 90, 20, 104), tracks)).toEqual([]);
    // One pixel of real overlap on the same edges does take it.
    expect(hit(box(99, 110, 120, 120), tracks)).toEqual(["v"]);
    expect(hit(box(10, 151, 20, 160), tracks)).toEqual(["v"]);
  });

  it("takes nothing from a zero-width or zero-height box", () => {
    const tracks = [track({ id: "t", layers: [layer({ id: "v" })] })];
    expect(hit(box(50, 110, 50, 120), tracks)).toEqual([]);
    expect(hit(box(10, 110, 20, 110), tracks)).toEqual([]);
  });

  it("excludes every clip on a locked track", () => {
    const tracks = [
      track({ id: "t", locked: true, layers: [layer({ id: "v" })] }),
    ];
    expect(hit(box(10, 110, 20, 120), tracks)).toEqual([]);
  });

  it("excludes a locked layer while taking its unlocked neighbour on the same lane", () => {
    const tracks = [
      track({
        id: "t",
        layers: [
          layer({ id: "unlocked" }),
          layer({
            id: "locked",
            locked: true,
            t_start_us: 1_000_000,
            t_end_us: 2_000_000,
          }),
        ],
      }),
    ];
    expect(hit(box(50, 110, 150, 120), tracks)).toEqual(["unlocked"]);
  });

  it("takes nothing from a track the caller passed no row for", () => {
    const rendered = track({ id: "rendered", layers: [layer({ id: "v" })] });
    const filteredOut = track({
      id: "filtered-out",
      layers: [layer({ id: "hidden" })],
    });
    expect(
      marqueeHitClips({
        box: box(10, 110, 20, 120),
        rows: [row(rendered.id)],
        tracks: [rendered, filteredOut],
        pxPerSec: PX_PER_SEC,
      }),
    ).toEqual(["v"]);
  });

  it("returns hits in track-then-layer order regardless of row registration order", () => {
    const first = track({
      id: "first",
      layers: [layer({ id: "l2" }), layer({ id: "l1", t_start_us: 500_000 })],
    });
    const second = track({ id: "second", layers: [layer({ id: "l0" })] });
    expect(
      marqueeHitClips({
        box: box(10, 110, 60, 120),
        rows: [row(second.id), row(first.id)],
        tracks: [first, second],
        pxPerSec: PX_PER_SEC,
      }),
    ).toEqual(["l2", "l1", "l0"]);
  });

  it("gives a right-to-left, bottom-to-top drag the identical result", () => {
    const tracks = [combinedRow()];
    expect(hit(box(20, 145, 10, 110), tracks)).toEqual(
      hit(box(10, 110, 20, 145), tracks),
    );
  });
});

describe("resolveMarqueeSelection", () => {
  const grouped: GroupSummary[] = [
    { id: "g", label: null, layer_ids: ["in-box", "off-screen"] },
  ];
  const groupIndex = new Map([
    ["in-box", "g"],
    ["off-screen", "g"],
  ]);

  it("replaces the selection with nothing when the box hit nothing", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: "was-selected",
        hit: [],
        groupByLayerId: groupIndex,
        groups: grouped,
        mode: "replace",
      }),
    ).toEqual({ ids: [], primary: null });
  });

  it("pulls in group members the box never touched", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["in-box"],
        groupByLayerId: groupIndex,
        groups: grouped,
        mode: "replace",
      }),
    ).toEqual({ ids: ["in-box", "off-screen"], primary: "in-box" });
  });

  it("leaves an ungrouped hit standing alone", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["loner"],
        groupByLayerId: groupIndex,
        groups: grouped,
        mode: "replace",
      }).ids,
    ).toEqual(["loner"]);
  });

  it("fans out to every id the group lists, including ones the hit-test excluded", () => {
    // The hit-test drops locked clips; fan-out does not re-apply that, because a
    // click on a grouped clip selects its locked members too.
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["a"],
        groupByLayerId: new Map([
          ["a", "g"],
          ["locked", "g"],
        ]),
        groups: [{ id: "g", label: null, layer_ids: ["a", "locked"] }],
        mode: "replace",
      }).ids,
    ).toEqual(["a", "locked"]);
  });

  it("names each id once when several members of one group are hit", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["in-box", "off-screen"],
        groupByLayerId: groupIndex,
        groups: grouped,
        mode: "replace",
      }).ids,
    ).toEqual(["in-box", "off-screen"]);
  });

  it("keeps a primary that survives into the new selection", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: "off-screen",
        hit: ["in-box"],
        groupByLayerId: groupIndex,
        groups: grouped,
        mode: "replace",
      }).primary,
    ).toBe("off-screen");
  });

  it("falls back to the first hit when the primary did not survive", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: "dropped",
        hit: ["second", "third"],
        groupByLayerId: new Map(),
        groups: [],
        mode: "replace",
      }),
    ).toEqual({ ids: ["second", "third"], primary: "second" });
  });

  it("falls back to the first hit when there was no primary", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["second", "third"],
        groupByLayerId: new Map(),
        groups: [],
        mode: "replace",
      }).primary,
    ).toBe("second");
  });
});
