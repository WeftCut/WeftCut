import { describe, expect, it } from "vitest";
import {
  buildPeekItems,
  formatPeekDelta,
  peekCategory,
  peekDeltaLabels,
  restackMenuTargets,
  restackTargetForGap,
  splitPeekSections,
  type PeekItem,
} from "./peek";
import type { LayerSummary, TrackSummary } from "../ipc";

function item(
  id: string,
  kind: string,
  opts: { trackIndex?: number; spansPlayhead?: boolean } = {},
): PeekItem {
  const spans = opts.spansPlayhead ?? true;
  return {
    layer: {
      id,
      kind,
      label: null,
      t_start_us: 0,
      t_end_us: 1_000_000,
      enabled: true,
      locked: false,
      color_hint: "#888",
      params: { kind } as LayerSummary["params"],
      effects: [],
    },
    trackId: `track-${id}`,
    trackLabel: id,
    trackKind: kind,
    trackIndex: opts.trackIndex ?? 0,
    offsetUs: spans ? 0 : 100_000,
    // The fixture layer runs 0 → 1s, so a spanning row has all of itself left.
    remainingUs: spans ? 1_000_000 : 0,
    spansPlayhead: spans,
  };
}

describe("peekCategory", () => {
  it("maps Audio to audio", () => expect(peekCategory("Audio")).toBe("audio"));
  it("maps Text to text", () => {
    expect(peekCategory("Text")).toBe("text");
  });
  it("maps every visual kind to video", () => {
    for (const k of ["VideoClip", "ImageOverlay", "Color", "Motif"]) {
      expect(peekCategory(k)).toBe("video");
    }
  });
});

/// Interpolating stub. These assertions are about WHICH key fires and what
/// values reach it, never about the English copy — the copy is the locale's
/// business, and pinning it here would turn every wording change into a
/// failure in a file that has no opinion on wording.
const FMT = (key: string, values: Record<string, unknown>): string =>
  `${key}(${Object.entries(values)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",")})`;

describe("formatPeekDelta", () => {
  // Below a second there is nothing but frames to report, so no `0s` is
  // printed — `15f` is the whole value.
  it("reports frames alone below one second", () => {
    expect(formatPeekDelta(500_000, 30, 1, FMT)).toBe("peek.delta_frames(f=15)");
  });

  // The frame field survives at zero on purpose: a bare `1s` would read as a
  // rounded value in a column whose point is that it is not one.
  it("pairs seconds with frames below a minute, zero frames included", () => {
    expect(formatPeekDelta(3_400_000, 30, 1, FMT)).toBe(
      "peek.delta_sec_frames(s=3,f=12)",
    );
    expect(formatPeekDelta(1_000_000, 30, 1, FMT)).toBe(
      "peek.delta_sec_frames(s=1,f=0)",
    );
  });

  // Frames stop being an edit decision at this distance, so they stop being
  // printed rather than filling the column with digits nobody reads.
  it("coarsens past a minute, and again past an hour", () => {
    expect(formatPeekDelta(90_000_000, 30, 1, FMT)).toBe(
      "peek.delta_min_sec(m=1,s=30)",
    );
    expect(formatPeekDelta(7_384_000_000, 30, 1, FMT)).toBe(
      "peek.delta_hour_min(h=2,m=3)",
    );
  });

  // Direction is the caller's phrase (`peekDeltaLabels`), so the value is
  // always a magnitude — no row prints a lone minus for a reader to decode.
  it("formats a negative distance exactly like its positive twin", () => {
    expect(formatPeekDelta(-3_400_000, 30, 1, FMT)).toBe(
      formatPeekDelta(3_400_000, 30, 1, FMT),
    );
  });

  it("falls back to 30 fps rather than dividing by a bad rate", () => {
    expect(formatPeekDelta(500_000, 0, 0, FMT)).toBe("peek.delta_frames(f=15)");
  });
});

describe("peekDeltaLabels", () => {
  // An At-playhead row's distance to its nearest edge is zero by definition,
  // so the number worth showing there is what remains. That it is playing at
  // all is the section header's job — a LIVE badge would only repeat it, and
  // would spend this slot to do so.
  it("asks what is left of an At-playhead row, not whether it is playing", () => {
    const labels = peekDeltaLabels(
      item("live", "VideoClip", { spansPlayhead: true }),
      30,
      1,
      FMT,
    );
    expect(labels.text).toBe(
      "peek.delta_remaining(value=peek.delta_sec_frames(s=1,f=0))",
    );
    expect(labels.aria).toBe(
      "peek.delta_remaining_aria(value=peek.delta_sec_frames(s=1,f=0))",
    );
  });

  // Text and aria come back together because they must agree: the printed
  // value is terse, which makes the accessible name the only place the field
  // name exists at all.
  it("phrases a future row as a wait and a past row as a memory", () => {
    const soon: PeekItem = {
      ...item("soon", "VideoClip", { spansPlayhead: false }),
      offsetUs: 500_000,
    };
    const gone: PeekItem = {
      ...item("gone", "VideoClip", { spansPlayhead: false }),
      offsetUs: -500_000,
    };

    expect(peekDeltaLabels(soon, 30, 1, FMT).text).toBe(
      "peek.delta_future(value=peek.delta_frames(f=15))",
    );
    expect(peekDeltaLabels(soon, 30, 1, FMT).aria).toBe(
      "peek.delta_future_aria(value=peek.delta_frames(f=15))",
    );
    expect(peekDeltaLabels(gone, 30, 1, FMT).text).toBe(
      "peek.delta_past(value=peek.delta_frames(f=15))",
    );
    expect(peekDeltaLabels(gone, 30, 1, FMT).aria).toBe(
      "peek.delta_past_aria(value=peek.delta_frames(f=15))",
    );
  });
});

describe("splitPeekSections", () => {
  it("splits on the playhead: spanning items go At-playhead, the rest Nearby", () => {
    const sections = splitPeekSections(
      [
        item("live", "VideoClip", { spansPlayhead: true }),
        item("soon", "VideoClip", { spansPlayhead: false }),
      ],
      new Set(),
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual(["live"]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["soon"]);
  });

  it("orders At-playhead visuals top-of-stack first, merging every visual kind", () => {
    // `Project.tracks` is ordered bottom-of-z-stack first, so the highest
    // track index composites on top and must render first. Visual kinds
    // (video / image / color / motif / text) interleave in one list.
    const sections = splitPeekSections(
      [
        item("bottom-video", "VideoClip", { trackIndex: 1 }),
        item("top-text", "Text", { trackIndex: 5 }),
        item("mid-motif", "Motif", { trackIndex: 3 }),
      ],
      new Set(),
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "top-text",
      "mid-motif",
      "bottom-video",
    ]);
    // All-visual stack: the reorderable prefix is the whole section.
    expect(sections.atPlayheadVisual).toEqual(sections.atPlayhead);
  });

  it("sinks spanning audio rows to the section tail in their input order", () => {
    // Audio never sorts by z (it mixes by role, ADR 0023): even from the
    // topmost track it trails every visual, in the order it arrived.
    const sections = splitPeekSections(
      [
        item("a1", "Audio", { trackIndex: 9 }),
        item("v", "VideoClip", { trackIndex: 1 }),
        item("a2", "Audio", { trackIndex: 4 }),
      ],
      new Set(),
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "v",
      "a1",
      "a2",
    ]);
    // The exposed visual prefix ends exactly where the audio tail begins —
    // the panel's draggable stack, taken as-is.
    expect(sections.atPlayheadVisual.map((i) => i.layer.id)).toEqual(["v"]);
    expect(sections.atPlayheadVisual).toEqual(
      sections.atPlayhead.slice(0, sections.atPlayheadVisual.length),
    );
  });

  it("keeps the Nearby section in the existing proximity order", () => {
    // Nearby's sort is buildPeekItems' business; the split must not
    // rearrange it, whatever the track indices say.
    const sections = splitPeekSections(
      [
        item("n1", "VideoClip", { spansPlayhead: false, trackIndex: 7 }),
        item("n2", "Text", { spansPlayhead: false, trackIndex: 2 }),
        item("n3", "Audio", { spansPlayhead: false, trackIndex: 5 }),
      ],
      new Set(),
    );
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("applies a category filter to both sections", () => {
    const sections = splitPeekSections(
      [
        item("live-v", "VideoClip"),
        item("live-a", "Audio"),
        item("near-v", "VideoClip", { spansPlayhead: false }),
        item("near-a", "Audio", { spansPlayhead: false }),
      ],
      new Set(["audio"]),
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual(["live-a"]);
    // An audio-only stack has an empty visual prefix: nothing is draggable.
    expect(sections.atPlayheadVisual).toEqual([]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["near-a"]);
  });

  // Two kinds in, the third out — the filter is a union, not a single choice.
  it("keeps every checked category and drops the rest", () => {
    const sections = splitPeekSections(
      [
        item("live-v", "VideoClip"),
        item("live-t", "Text"),
        item("live-a", "Audio"),
        item("near-a", "Audio", { spansPlayhead: false }),
        item("near-t", "Text", { spansPlayhead: false }),
      ],
      new Set(["video", "text"]),
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "live-v",
      "live-t",
    ]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["near-t"]);
  });

  // No category checked is NOT "keep nothing", it is "no filter" — read the
  // other way, the unfiltered view becomes unreachable once every chip is off.
  it("treats an empty filter as no filter at all", () => {
    const sections = splitPeekSections(
      [item("v", "VideoClip"), item("a", "Audio"), item("t", "Text")],
      new Set(),
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual(["v", "t", "a"]);
  });

  it("a filter matching nothing leaves both sections empty", () => {
    const sections = splitPeekSections(
      [item("v", "VideoClip")],
      new Set(["text"]),
    );
    expect(sections.atPlayhead).toEqual([]);
    expect(sections.atPlayheadVisual).toEqual([]);
    expect(sections.nearby).toEqual([]);
  });
});

describe("restackTargetForGap", () => {
  // Visible rows top-of-stack first, the At-playhead render order. The
  // dragged row is rows[fromIndex]; a gap g sits directly above rows[g].
  const rows = () => [
    item("top", "ImageOverlay", { trackIndex: 5 }),
    item("mid", "Text", { trackIndex: 3 }),
    item("bottom", "VideoClip", { trackIndex: 1 }),
  ];

  it("maps an interior gap to 'directly above the visible row below it'", () => {
    // Dragging the top row to the gap between mid and bottom.
    expect(restackTargetForGap(rows(), 0, 2)).toEqual({
      anchorId: "bottom",
      position: "above",
    });
  });

  it("maps the top gap to above the first visible row", () => {
    expect(restackTargetForGap(rows(), 2, 0)).toEqual({
      anchorId: "top",
      position: "above",
    });
  });

  it("maps the section-bottom gap to below the last visible row", () => {
    expect(restackTargetForGap(rows(), 0, 3)).toEqual({
      anchorId: "bottom",
      position: "below",
    });
  });

  it("reports the row's own gap and its following gap as no-ops", () => {
    expect(restackTargetForGap(rows(), 1, 1)).toBeNull();
    expect(restackTargetForGap(rows(), 1, 2)).toBeNull();
  });

  it("a single-row list has only no-op gaps", () => {
    const solo = [item("only", "VideoClip", { trackIndex: 2 })];
    expect(restackTargetForGap(solo, 0, 0)).toBeNull();
    expect(restackTargetForGap(solo, 0, 1)).toBeNull();
  });

  it("derives anchors from the visible rows only (filtered-out neighbours never anchor)", () => {
    // A category chip hid "mid": the function sees exactly what the user
    // sees, so the drop below the remaining top row anchors on "bottom" —
    // never on the hidden layer between them (ADR 0044 decision 5).
    const visible = [
      item("top", "ImageOverlay", { trackIndex: 5 }),
      item("bottom", "VideoClip", { trackIndex: 1 }),
    ];
    expect(restackTargetForGap(visible, 1, 0)).toEqual({
      anchorId: "top",
      position: "above",
    });
    expect(restackTargetForGap(visible, 0, 2)).toEqual({
      anchorId: "bottom",
      position: "below",
    });
  });

  it("an empty list or an out-of-range gap resolves to no-op", () => {
    expect(restackTargetForGap([], 0, 0)).toBeNull();
    expect(restackTargetForGap(rows(), 0, 4)).toBeNull();
    expect(restackTargetForGap(rows(), 0, -1)).toBeNull();
  });
});

describe("restackMenuTargets", () => {
  // Visible rows top-of-stack first, the At-playhead render order — the same
  // stack the context menu is looking at (ADR 0044 decision 4: front/back are
  // derived by the caller from the visible non-reserved stack; the op surface
  // stays above/below).
  const rows = () => [
    item("top", "ImageOverlay", { trackIndex: 5 }),
    item("mid", "Text", { trackIndex: 3 }),
    item("bottom", "VideoClip", { trackIndex: 1 }),
  ];

  it("top row: forward and front are no-ops; backward and back anchor below", () => {
    expect(restackMenuTargets(rows(), 0)).toEqual({
      bringForward: null,
      bringToFront: null,
      sendBackward: { anchorId: "mid", position: "below" },
      sendToBack: { anchorId: "bottom", position: "below" },
    });
  });

  it("middle row: all four available, front/back anchored at the stack ends", () => {
    expect(restackMenuTargets(rows(), 1)).toEqual({
      bringForward: { anchorId: "top", position: "above" },
      sendBackward: { anchorId: "bottom", position: "below" },
      bringToFront: { anchorId: "top", position: "above" },
      sendToBack: { anchorId: "bottom", position: "below" },
    });
  });

  it("bottom row: backward and back are no-ops; forward and front anchor above (distinct anchors)", () => {
    // bringForward hops one visible step; bringToFront jumps the whole stack —
    // on the bottom row of three the two anchors differ.
    expect(restackMenuTargets(rows(), 2)).toEqual({
      bringForward: { anchorId: "mid", position: "above" },
      bringToFront: { anchorId: "top", position: "above" },
      sendBackward: null,
      sendToBack: null,
    });
  });

  it("a single-row stack has all four as no-ops", () => {
    const solo = [item("only", "VideoClip", { trackIndex: 2 })];
    expect(restackMenuTargets(solo, 0)).toEqual({
      bringForward: null,
      sendBackward: null,
      bringToFront: null,
      sendToBack: null,
    });
  });

  it("an empty list or an out-of-range index has all four as no-ops", () => {
    const none = {
      bringForward: null,
      sendBackward: null,
      bringToFront: null,
      sendToBack: null,
    };
    expect(restackMenuTargets([], 0)).toEqual(none);
    expect(restackMenuTargets(rows(), 3)).toEqual(none);
    expect(restackMenuTargets(rows(), -1)).toEqual(none);
  });

  it("derives anchors from the visible rows only (filtered-out neighbours never anchor)", () => {
    // A category chip hid "mid": the menu sees exactly what the user sees
    // (ADR 0044 decision 5), so the remaining pair anchor on each other.
    const visible = [
      item("top", "ImageOverlay", { trackIndex: 5 }),
      item("bottom", "VideoClip", { trackIndex: 1 }),
    ];
    expect(restackMenuTargets(visible, 0).sendBackward).toEqual({
      anchorId: "bottom",
      position: "below",
    });
    expect(restackMenuTargets(visible, 1).bringToFront).toEqual({
      anchorId: "top",
      position: "above",
    });
  });
});

function layer(
  id: string,
  startUs: number,
  endUs: number,
  kind = "Color",
): LayerSummary {
  return {
    id,
    kind,
    label: null,
    t_start_us: startUs,
    t_end_us: endUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind } as LayerSummary["params"],
    effects: [],
  };
}

function track(
  id: string,
  role: TrackSummary["role"],
  layers: LayerSummary[],
): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role,
    transient: false,
    layers,
  };
}

// Playhead at 1s, ±0.5s window → intersection range [500_000, 1_500_000].
const NOW = 1_000_000;

/// Key + args, so a name assertion says which rung of `trackDisplayName` ran
/// without pinning the English copy.
const T = (key: string, values: Record<string, unknown>): string =>
  values.n === undefined ? key : `${key}#${String(values.n)}`;

describe("buildPeekItems windowing", () => {
  it("keeps only role-null layers that intersect the ±window", () => {
    const items = buildPeekItems(
      [
        track("t-in", null, [layer("in", 800_000, 1_200_000)]),
        // Assigned-role track: never surfaced by Nearby.
        track("t-role", "a-roll", [layer("role", 800_000, 1_200_000)]),
        // Ends exactly at the low edge (t_end <= lo) → excluded.
        track("t-before", null, [layer("before", 0, 500_000)]),
        // Starts exactly at the high edge (t_start >= hi) → excluded.
        track("t-after", null, [layer("after", 1_500_000, 2_000_000)]),
      ],
      NOW,
      500_000,
      T,
    );

    expect(items.map((i) => i.layer.id)).toEqual(["in"]);
  });

  it("flattens overlapping role-null tracks in time order", () => {
    const items = buildPeekItems(
      [
        track("t-late", null, [layer("late", 1_200_000, 1_400_000)]),
        track("t-early", null, [layer("early", 700_000, 900_000)]),
      ],
      NOW,
      5_000_000,
      T,
    );

    // Neither spans the playhead, so ordering is purely by start time.
    expect(items.map((i) => i.layer.id)).toEqual(["early", "late"]);
  });

  it("signs the offset by side and measures what is left of the spanner", () => {
    const items = buildPeekItems(
      [
        track("t", null, [
          layer("span", 800_000, 1_200_000),
          layer("past", 700_000, 900_000),
          layer("future", 1_200_000, 1_400_000),
        ]),
      ],
      NOW,
      5_000_000,
      T,
    );

    // Spanning item sorts first (LIVE), then the rest by start time.
    expect(items.map((i) => i.layer.id)).toEqual(["span", "past", "future"]);
    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("span")!.spansPlayhead).toBe(true);
    expect(byId.get("span")!.offsetUs).toBe(0);
    expect(byId.get("past")!.offsetUs).toBe(-100_000);
    expect(byId.get("future")!.offsetUs).toBe(200_000);
    // The spanner's row shows what is left of it instead of a zero distance;
    // a row that is not playing has nothing to run out.
    expect(byId.get("span")!.remainingUs).toBe(200_000);
    expect(byId.get("past")!.remainingUs).toBe(0);
    expect(byId.get("future")!.remainingUs).toBe(0);
  });

  // z is exactly the track's position in the project array, so the item must
  // carry the index of its track in the *full* array — role tracks included —
  // for the At-playhead stack to order against.
  it("indexes each item's track by its position in the full track array", () => {
    const items = buildPeekItems(
      [
        track("t-role", "a-roll", [layer("skip", 800_000, 1_200_000)]),
        track("t-b", null, [layer("b", 800_000, 1_200_000)]),
        track("t-c", null, [layer("c", 700_000, 900_000)]),
      ],
      NOW,
      500_000,
      T,
    );

    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("b")!.trackIndex).toBe(1);
    expect(byId.get("c")!.trackIndex).toBe(2);
  });

  // The row's sublabel is the header's name, so an unnamed lane reads as its
  // position rather than as its dominant layer class.
  it("names each row's track the way the track header does", () => {
    const named = track("t-named", null, [layer("a", 800_000, 1_200_000)]);
    const unnamed = { ...track("t-plain", null, [layer("b", 800_000, 1_200_000)]), label: null };
    const items = buildPeekItems([named, unnamed], NOW, 5_000_000, T);
    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("a")!.trackLabel).toBe("t-named");
    expect(byId.get("b")!.trackLabel).toBe("tracks.positional#2");
  });
});

describe("section membership at the window edges", () => {
  it("layers touching the playhead are At-playhead; the rest of the window is Nearby", () => {
    const items = buildPeekItems(
      [
        // Ends exactly at the playhead (t_end == now) → still spanning.
        track("t-ends-now", null, [layer("ends-now", 600_000, NOW)]),
        // Starts exactly at the playhead (t_start == now) → spanning.
        track("t-starts-now", null, [layer("starts-now", NOW, 1_400_000)]),
        // Inside the window but strictly past → Nearby.
        track("t-past", null, [layer("past", 501_000, 999_999)]),
        // Inside the window but strictly future → Nearby.
        track("t-future", null, [layer("future", 1_000_001, 1_499_000)]),
      ],
      NOW,
      500_000,
      T,
    );

    const sections = splitPeekSections(items, new Set());
    // Both spanning rows are visual, so they z-order top-of-stack first:
    // t-starts-now sits above t-ends-now in the track array.
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "starts-now",
      "ends-now",
    ]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["past", "future"]);
  });
});
