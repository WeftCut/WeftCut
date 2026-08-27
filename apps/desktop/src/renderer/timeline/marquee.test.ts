import { describe, expect, it } from "vitest";
import { DEFAULT_TRACK_HEIGHT, type MeasuredTrackRow } from "./geometry";
import {
  marqueeHitClips,
  marqueeHitKeyframes,
  normalizeBox,
  resolveMarqueeSelection,
  type MarqueeBox,
  type MeasuredSubLaneRow,
} from "./marquee";
import type {
  LinkSummary,
  Interpolation,
  Keyframe,
  LayerSummary,
  TrackSummary,
} from "../ipc";
import type { SelectedKeyframe } from "../keyframe/selectionStore";

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
  const linked: LinkSummary[] = [
    { id: "g", label: null, layer_ids: ["in-box", "off-screen"] },
  ];
  const linkIndex = new Map([
    ["in-box", "g"],
    ["off-screen", "g"],
  ]);

  it("replaces the selection with nothing when the box hit nothing", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: "was-selected",
        hit: [],
        linkByLayerId: linkIndex,
        links: linked,
        mode: "replace",
      }),
    ).toEqual({ ids: [], primary: null });
  });

  it("pulls in link members the box never touched", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["in-box"],
        linkByLayerId: linkIndex,
        links: linked,
        mode: "replace",
      }),
    ).toEqual({ ids: ["in-box", "off-screen"], primary: "in-box" });
  });

  it("leaves an unlinked hit standing alone", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["loner"],
        linkByLayerId: linkIndex,
        links: linked,
        mode: "replace",
      }).ids,
    ).toEqual(["loner"]);
  });

  it("fans out to every id the link lists, including ones the hit-test excluded", () => {
    // The hit-test drops locked clips; fan-out does not re-apply that, because a
    // click on a linked clip selects its locked members too.
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["a"],
        linkByLayerId: new Map([
          ["a", "g"],
          ["locked", "g"],
        ]),
        links: [{ id: "g", label: null, layer_ids: ["a", "locked"] }],
        mode: "replace",
      }).ids,
    ).toEqual(["a", "locked"]);
  });

  it("names each id once when several members of one link are hit", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["in-box", "off-screen"],
        linkByLayerId: linkIndex,
        links: linked,
        mode: "replace",
      }).ids,
    ).toEqual(["in-box", "off-screen"]);
  });

  it("keeps a primary that survives into the new selection", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: "off-screen",
        hit: ["in-box"],
        linkByLayerId: linkIndex,
        links: linked,
        mode: "replace",
      }).primary,
    ).toBe("off-screen");
  });

  it("falls back to the first hit when the primary did not survive", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: "dropped",
        hit: ["second", "third"],
        linkByLayerId: new Map(),
        links: [],
        mode: "replace",
      }),
    ).toEqual({ ids: ["second", "third"], primary: "second" });
  });

  it("falls back to the first hit when there was no primary", () => {
    expect(
      resolveMarqueeSelection({
        snapshotPrimary: null,
        hit: ["second", "third"],
        linkByLayerId: new Map(),
        links: [],
        mode: "replace",
      }).primary,
    ).toBe("second");
  });
});

// A sub-lane row measured at `[SUB_TOP, SUB_TOP + its height)`. The heights are
// `KF_SUBLANE_H` / `KF_SUBLANE_EXPANDED_H`, as literals because the hit-test is
// HANDED a band and reads neither constant.
const SUB_TOP = 200;
const COLLAPSED_H = 24;
const EXPANDED_H = 72;

// Every expanded-row y literal below reads against the axis `computeValueRange`
// derives per curve — the key values, padded 10% each side — mapped onto the
// row's 72 px. For a two-key 0/1 curve that is [-0.1, 1.1], so the value-1 dot
// draws 6 px below the row's top and the value-0 dot 66 px below it: canvas 206
// and 266.

function kf(
  id: string,
  tUs: number,
  value: number,
  interp: Interpolation = { kind: "Linear" },
): Keyframe<number> {
  return { id, t_us: tUs, value, interp };
}

/// Params as the IPC view flattens them, with `paramKey` keyframed. `extra`
/// carries the sibling fields a rule reads — `scale_linked` for the twin axis.
function keyedParams(
  paramKey: string,
  keys: Keyframe<number>[],
  extra: Record<string, unknown> = {},
): LayerSummary["params"] {
  return {
    kind: "VideoClip",
    [paramKey]: { mode: "Keyframed", value: keys },
    ...extra,
  } as unknown as LayerSummary["params"];
}

/// A layer starting at 1 s, so its keys land a clean 100 px past the canvas's
/// left edge rather than on it.
function keyedLayer(
  id: string,
  keys: Keyframe<number>[],
  partial: Partial<LayerSummary> = {},
): LayerSummary {
  return layer({
    id,
    t_start_us: 1_000_000,
    t_end_us: 3_000_000,
    params: keyedParams("opacity", keys),
    ...partial,
  });
}

function subRow(
  trackId: string,
  expanded: boolean,
  extra: Partial<MeasuredSubLaneRow> = {},
): MeasuredSubLaneRow {
  return {
    trackId,
    paramKey: "opacity",
    expanded,
    top: SUB_TOP,
    bottom: SUB_TOP + (expanded ? EXPANDED_H : COLLAPSED_H),
    ...extra,
  };
}

function hitKeys(
  b: MarqueeBox,
  rows: readonly MeasuredSubLaneRow[],
  tracks: readonly TrackSummary[],
): SelectedKeyframe[] {
  return marqueeHitKeyframes({ box: b, rows, tracks, pxPerSec: PX_PER_SEC });
}

/// `layerId/kfId` per hit. The property is the row's, so naming it in every
/// expectation would bury the axis each test is about; the cross-property test
/// asserts the whole triple.
function hitNames(hits: readonly SelectedKeyframe[]): string[] {
  return hits.map((h) => `${h.layerId}/${h.kfId}`);
}

describe("marqueeHitKeyframes", () => {
  it("takes keys from every layer on a collapsed row, whatever their values", () => {
    const t = track({
      id: "t",
      layers: [
        keyedLayer("hi", [kf("hi-a", 0, 1), kf("hi-b", 1_000_000, 0.9)]),
        keyedLayer("lo", [kf("lo-a", 0, 0), kf("lo-b", 1_000_000, 0.1)]),
      ],
    });
    expect(
      hitNames(hitKeys(box(50, 205, 250, 215), [subRow("t", false)], [t])),
    ).toEqual(["hi/hi-a", "hi/hi-b", "lo/lo-a", "lo/lo-b"]);
  });

  it("takes a collapsed row's whole x range from 2px of vertical overlap", () => {
    // The 1D rule, stated as a test so nobody turns a collapsed row into 2D:
    // compressed onto 24 px the dots draw at canvas 202 and 222, both OUTSIDE
    // the box, and both are taken anyway.
    const t = track({
      id: "t",
      layers: [keyedLayer("v", [kf("high", 0, 1), kf("low", 1_000_000, 0)])],
    });
    expect(
      hitNames(hitKeys(box(50, 200, 250, 202), [subRow("t", false)], [t])),
    ).toEqual(["v/high", "v/low"]);
  });

  it("splits an expanded row by the drawn value", () => {
    const t = track({
      id: "t",
      layers: [keyedLayer("v", [kf("high", 0, 1), kf("low", 1_000_000, 0)])],
    });
    const rows = [subRow("t", true)];
    expect(hitNames(hitKeys(box(50, 200, 250, 236), rows, [t]))).toEqual([
      "v/high",
    ]);
    expect(hitNames(hitKeys(box(50, 236, 250, 272), rows, [t]))).toEqual([
      "v/low",
    ]);
    // Between the two dots, across the full x range of both.
    expect(hitKeys(box(50, 220, 250, 250), rows, [t])).toEqual([]);
  });

  it("reads each layer on an expanded row against its own value axis", () => {
    // "a" spans 0..1 and "b" spans 1..2, so one 72 px band overlays two axes:
    // the value-1 key sits at the TOP of a's and at the BOTTOM of b's.
    const t = track({
      id: "t",
      layers: [
        keyedLayer("a", [kf("a-0", 0, 0), kf("a-1", 1_000_000, 1)]),
        keyedLayer("b", [kf("b-1", 0, 1), kf("b-2", 1_000_000, 2)]),
      ],
    });
    const rows = [subRow("t", true)];
    expect(hitNames(hitKeys(box(50, 200, 250, 236), rows, [t]))).toEqual([
      "a/a-1",
      "b/b-2",
    ]);
    expect(hitNames(hitKeys(box(50, 236, 250, 272), rows, [t]))).toEqual([
      "a/a-0",
      "b/b-1",
    ]);
  });

  it("keeps an eased overshoot inside the row, leaving an extreme dot reachable", () => {
    // Elastic Out swings past the end value and `computeValueRange` samples it,
    // which pushes the value-1 dot from canvas 206 down to ~222. So the row's
    // top 15 px take NOTHING — with the overshoot ignored that dot would be in
    // there — while the band below them takes it.
    const t = track({
      id: "t",
      layers: [
        keyedLayer("v", [
          kf("start", 0, 0, {
            kind: "Elastic",
            dir: "Out",
            amplitude: 1,
            period: 0.3,
          }),
          kf("end", 1_000_000, 1),
        ]),
      ],
    });
    const rows = [subRow("t", true)];
    expect(hitKeys(box(50, 200, 250, 215), rows, [t])).toEqual([]);
    expect(hitNames(hitKeys(box(50, 215, 250, 240), rows, [t]))).toEqual([
      "v/end",
    ]);
    expect(hitNames(hitKeys(box(50, 200, 250, 272), rows, [t]))).toEqual([
      "v/start",
      "v/end",
    ]);
  });

  it("puts a single-key and an all-equal curve's dots at the row's middle", () => {
    // `computeValueRange` widens a degenerate curve to a band CENTRED on the
    // value, so the dot lands at height/2 — canvas 236 — rather than through
    // `valueToY`'s zero-span guard.
    const t = track({
      id: "t",
      layers: [
        keyedLayer("one", [kf("only", 0, 0.5)]),
        keyedLayer("flat", [kf("flat-a", 0, 3), kf("flat-b", 1_000_000, 3)]),
      ],
    });
    const rows = [subRow("t", true)];
    expect(hitNames(hitKeys(box(50, 230, 250, 240), rows, [t]))).toEqual([
      "one/only",
      "flat/flat-a",
      "flat/flat-b",
    ]);
    expect(hitKeys(box(50, 200, 250, 212), rows, [t])).toEqual([]);
  });

  it("crosses properties and tracks in one tall box", () => {
    const t1 = track({
      id: "t1",
      layers: [
        layer({
          id: "l1",
          t_start_us: 1_000_000,
          t_end_us: 3_000_000,
          params: keyedParams("opacity", [kf("o1", 0, 1)], {
            x: { mode: "Keyframed", value: [kf("x1", 0, 5)] },
          }),
        }),
      ],
    });
    const t2 = track({ id: "t2", layers: [keyedLayer("l2", [kf("o2", 0, 1)])] });
    const rows: MeasuredSubLaneRow[] = [
      subRow("t1", true),
      subRow("t1", true, { paramKey: "x", top: 272, bottom: 344 }),
      subRow("t2", true, { top: 344, bottom: 416 }),
    ];
    expect(hitKeys(box(50, 200, 250, 416), rows, [t1, t2])).toEqual([
      { layerId: "l1", paramKey: "opacity", kfId: "o1" },
      { layerId: "l1", paramKey: "x", kfId: "x1" },
      { layerId: "l2", paramKey: "opacity", kfId: "o2" },
    ]);
  });

  it("treats the box as half-open on both axes of an expanded row", () => {
    // A 0..10 curve draws its dots at exactly canvas 206 and 266, and 1 s at
    // exactly x 100, so an edge can be named without floating-point slack.
    const t = track({
      id: "t",
      layers: [keyedLayer("v", [kf("top", 0, 10), kf("bottom", 1_000_000, 0)])],
    });
    const rows = [subRow("t", true)];
    expect(hitNames(hitKeys(box(100, 206, 150, 240), rows, [t]))).toEqual([
      "v/top",
    ]);
    expect(hitKeys(box(50, 200, 100, 240), rows, [t])).toEqual([]);
    expect(hitKeys(box(50, 200, 150, 206), rows, [t])).toEqual([]);
    expect(hitKeys(box(100, 206, 100, 240), rows, [t])).toEqual([]);
  });

  it("takes nothing from a hidden twin axis, and the same key once unlinked", () => {
    const keys = [kf("sy", 0, 1)];
    const twin = (linked: boolean) =>
      track({
        id: "t",
        layers: [
          layer({
            id: "v",
            t_start_us: 1_000_000,
            t_end_us: 3_000_000,
            params: keyedParams("scale_y", keys, { scale_linked: linked }),
          }),
        ],
      });
    const rows = [subRow("t", false, { paramKey: "scale_y" })];
    const b = box(50, 205, 250, 215);
    expect(hitKeys(b, rows, [twin(true)])).toEqual([]);
    expect(hitNames(hitKeys(b, rows, [twin(false)]))).toEqual(["v/sy"]);
  });

  it("takes nothing from a param a layer does not animate", () => {
    const t = track({
      id: "t",
      layers: [
        layer({
          id: "static",
          t_start_us: 1_000_000,
          t_end_us: 3_000_000,
          params: {
            kind: "VideoClip",
            opacity: { mode: "Static", value: 1 },
          } as unknown as LayerSummary["params"],
        }),
        keyedLayer("keyed", [kf("k", 0, 1)]),
      ],
    });
    expect(
      hitNames(hitKeys(box(50, 205, 250, 215), [subRow("t", false)], [t])),
    ).toEqual(["keyed/k"]);
  });

  it("excludes a locked track, and a locked layer on an unlocked one", () => {
    const keys = [kf("k", 0, 1)];
    const rows = [subRow("t", false)];
    const b = box(50, 205, 250, 215);
    expect(
      hitKeys(b, rows, [
        track({ id: "t", locked: true, layers: [keyedLayer("v", keys)] }),
      ]),
    ).toEqual([]);
    expect(
      hitNames(
        hitKeys(b, rows, [
          track({
            id: "t",
            layers: [
              keyedLayer("v", keys, { locked: true }),
              keyedLayer("free", keys),
            ],
          }),
        ]),
      ),
    ).toEqual(["free/k"]);
  });

  it("never sees a collapsed clip's chip diamonds", () => {
    // Structural rather than a filter: a collapsed track renders no sub-lane
    // rows, so the chip's compressed diamonds are not in `rows` to be taken.
    const t = track({ id: "t", layers: [keyedLayer("v", [kf("k", 0, 1)])] });
    expect(hitKeys(box(50, 100, 250, 400), [], [t])).toEqual([]);
  });

  it("takes nothing from a row whose track the caller did not pass", () => {
    const t = track({
      id: "rendered",
      layers: [keyedLayer("v", [kf("k", 0, 1)])],
    });
    expect(
      hitKeys(box(50, 205, 250, 215), [subRow("gone", false)], [t]),
    ).toEqual([]);
  });
});
