import { afterEach, describe, expect, it } from "vitest";

import { displayedFrameStartUs } from "../frames";
import type {
  AnimTrack,
  CompositionSummary,
  LayerSummary,
  MarkerSummary,
  TrackSummary,
} from "../ipc";
import {
  currentSelection,
  primaryLayerIdOf,
  useSelectionStore,
} from "../state/selectionStore";
import { compositionFixture } from "../testing/summaryFixture";
import { markerAnchorFor, markerStartingInFrame } from "./markerAtFrame";

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function marker(tUs: number, endTUs: number | null = null): MarkerSummary {
  seq += 1;
  return {
    id: `marker-${seq}`,
    t_us: tUs,
    end_t_us: endTUs,
    label: "",
    note: "",
    color_hint: "#0080ff",
    anchor_layer: null,
    hibernating: false,
  };
}

// 25 fps → 40 000 µs frames: mid-frame arithmetic stays legible.
const FPS = [25, 1] as const;

function find(
  markers: MarkerSummary[],
  playheadUs: number,
  [num, den]: readonly [number, number] = FPS,
): MarkerSummary | null {
  return markerStartingInFrame(markers, playheadUs, num, den);
}

describe("markerStartingInFrame", () => {
  it("finds nothing in an unmarked project", () => {
    expect(find([], 0)).toBeNull();
  });

  it("matches a point marker anywhere inside its frame, not just on its anchor", () => {
    const m = marker(80_000);
    expect(find([m], 80_000)?.id).toBe(m.id);
    // Playhead mid-frame still displays frame 2, so the frame "carries" m.
    expect(find([m], 100_000)?.id).toBe(m.id);
    // First µs of the next frame does not.
    expect(find([m], 120_000)).toBeNull();
  });

  it("ignores markers in other frames", () => {
    expect(find([marker(0), marker(200_000)], 80_000)).toBeNull();
  });

  it("matches a region by its START frame", () => {
    const region = marker(80_000, 400_000);
    expect(find([region], 90_000)?.id).toBe(region.id);
  });

  it("a region merely SPANNING the frame does not block it", () => {
    // Starts is the rule, not coverage: a new point marker may land inside a
    // region — the shot the region describes can still contain a flaw worth
    // its own mark.
    const region = marker(0, 400_000);
    expect(find([region], 200_000)).toBeNull();
  });

  it("several markers on one frame: the first in sorted order wins", () => {
    const first = marker(80_000);
    const second = marker(80_000);
    expect(find([first, second], 80_000)?.id).toBe(first.id);
  });

  it("holds at fractional rates", () => {
    // Derive the anchor through the same helper the matcher uses, so the case
    // asserts the same-frame rule rather than a wasm rounding convention.
    const anchorUs = displayedFrameStartUs(50_000, 30_000, 1_001);
    const m = marker(anchorUs);
    expect(
      markerStartingInFrame([m], anchorUs + 10, 30_000, 1_001)?.id,
    ).toBe(m.id);
    expect(
      markerStartingInFrame([m], anchorUs + 40_000, 30_000, 1_001),
    ).toBeNull();
  });
});

// ── The other half of the `M` key: which clip, if any, the mark is tied to ───
// `markerStartingInFrame` above answers "add or rename"; `markerAnchorFor`
// answers "free or anchored". The two are tested together because they are the
// one gesture's two decisions, taken in that order.

const staticNum = (value: number): AnimTrack<number> => ({
  mode: "Static",
  value,
});

/// A clip on the timeline at `[tStartUs, tEndUs)` showing source
/// `[srcInUs, …)`, so a mark's timeline time and its source time are never the
/// same number and a derivation that dropped one of the terms would show.
function clip({
  id,
  tStartUs,
  tEndUs,
  srcInUs = 2_000_000,
  params,
}: {
  id: string;
  tStartUs: number;
  tEndUs: number;
  srcInUs?: number;
  params?: LayerSummary["params"];
}): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: params?.kind ?? "VideoClip",
    color_hint: "#5588aa",
    enabled: true,
    locked: false,
    effects: [],
    params: params ?? {
      kind: "VideoClip",
      media_id: "media-1",
      media_label: "clip.mov",
      src_in_us: srcInUs,
      src_out_us: srcInUs + (tEndUs - tStartUs),
      x: staticNum(0),
      y: staticNum(0),
      scale_x: staticNum(1),
      scale_y: staticNum(1),
      scale_linked: true,
      rotation_deg: staticNum(0),
      anchor_x: staticNum(0.5),
      anchor_y: staticNum(0.5),
      opacity: staticNum(1),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
  };
}

function timelineOf(...layers: LayerSummary[]): CompositionSummary {
  const track: TrackSummary = {
    id: "track-1",
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
  return compositionFixture({ tracks: [track] });
}

/// The clip the fixtures anchor to: timeline `[1 s, 3 s)` over source
/// `[2 s, 4 s)`, so a mark at 2 s names source 3 s.
const CLIP = clip({ id: "clip-1", tStartUs: 1_000_000, tEndUs: 3_000_000 });

afterEach(() => useSelectionStore.setState({ selection: { kind: "none" } }));

describe("markerAnchorFor", () => {
  it("names the source instant under the mark, not the timeline one", () => {
    expect(markerAnchorFor(timelineOf(CLIP), "clip-1", 2_000_000)).toEqual({
      layer: "clip-1",
      src_us: 3_000_000,
    });
  });

  // A tie to material the mark does not touch means nothing, so the mark stays
  // free rather than teleporting onto the clip. The end is EXCLUSIVE.
  it("refuses a time the clip does not cover, at either edge", () => {
    const comp = timelineOf(CLIP);
    expect(markerAnchorFor(comp, "clip-1", 999_999)).toBeNull();
    expect(markerAnchorFor(comp, "clip-1", 3_000_000)).toBeNull();
    expect(markerAnchorFor(comp, "clip-1", 1_000_000)).not.toBeNull();
    expect(markerAnchorFor(comp, "clip-1", 2_999_999)).not.toBeNull();
  });

  // The three kinds main's `hasSourceWindow` admits, and no more: a Motif
  // carries a `src_in_us` and is still not anchorable, which is the twin that
  // bites first if this list is ever written as "has a src_in_us".
  it("refuses a kind with no source WINDOW, Motif included", () => {
    const motif = clip({
      id: "motif-1",
      tStartUs: 1_000_000,
      tEndUs: 3_000_000,
      params: {
        kind: "Motif",
        motif_id: "lower-third",
        x: staticNum(0),
        y: staticNum(0),
        scale_x: staticNum(1),
        scale_y: staticNum(1),
        scale_linked: true,
        rotation_deg: staticNum(0),
        anchor_x: staticNum(0.5),
        anchor_y: staticNum(0.5),
        opacity: staticNum(1),
        src_in_us: 0,
        props: {},
      },
    });
    expect(markerAnchorFor(timelineOf(motif), "motif-1", 2_000_000)).toBeNull();
  });

  it("refuses a layer this composition does not hold", () => {
    expect(markerAnchorFor(timelineOf(CLIP), "elsewhere", 2_000_000)).toBeNull();
  });
});

// The `M` key's decision, as `App.tsx` takes it: the live selection names the
// clip, `markerAnchorFor` says whether the mark can be tied to it.
describe("the M key's anchor decision", () => {
  const anchorForSelection = (
    comp: CompositionSummary,
    frameUs: number,
  ): ReturnType<typeof markerAnchorFor> => {
    const primary = primaryLayerIdOf(currentSelection());
    return primary === null ? null : markerAnchorFor(comp, primary, frameUs);
  };
  const select = (primary: string, ...rest: string[]) =>
    useSelectionStore.setState({
      selection: { kind: "layers", primary, ids: new Set([primary, ...rest]) },
    });

  it("marks the TIMELINE when nothing is selected", () => {
    expect(anchorForSelection(timelineOf(CLIP), 2_000_000)).toBeNull();
  });

  it("marks the CLIP when one is selected", () => {
    select("clip-1");
    expect(anchorForSelection(timelineOf(CLIP), 2_000_000)).toEqual({
      layer: "clip-1",
      src_us: 3_000_000,
    });
  });

  // One instant, one mark: a multi-clip selection still yields ONE anchor, on
  // the primary. N marks on one frame stack illegibly, and the next `M` would
  // rename the first and leave the rest unreachable.
  it("yields one anchor on the primary when several clips are selected", () => {
    const second = clip({
      id: "clip-2",
      tStartUs: 1_000_000,
      tEndUs: 3_000_000,
      srcInUs: 5_000_000,
    });
    const third = clip({
      id: "clip-3",
      tStartUs: 1_000_000,
      tEndUs: 3_000_000,
      srcInUs: 7_000_000,
    });
    select("clip-2", "clip-1", "clip-3");
    expect(
      anchorForSelection(timelineOf(CLIP, second, third), 2_000_000),
    ).toEqual({ layer: "clip-2", src_us: 6_000_000 });
  });

  it("falls back to a free mark when the playhead is off the selected clip", () => {
    select("clip-1");
    expect(anchorForSelection(timelineOf(CLIP), 3_500_000)).toBeNull();
  });

  // A media selection is not a clip selection: `primaryLayerIdOf` answers null
  // for every non-layer branch, so the pool having focus cannot tie a mark.
  it("falls back to a free mark for a selection that holds no layers", () => {
    useSelectionStore.setState({
      selection: { kind: "media", id: "media-1" },
    });
    expect(anchorForSelection(timelineOf(CLIP), 2_000_000)).toBeNull();
  });
});
