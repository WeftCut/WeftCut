import { describe, expect, it } from "vitest";

import type { AnimTrack, LayerSummary, TrackSummary } from "../../ipc";
import { markerDragTimeUs, type MarkerDragContext } from "./useMarkerDrag";

const staticNum = (value: number): AnimTrack<number> => ({
  mode: "Static",
  value,
});

/// A clip at `[1 s, 3 s)` — the anchoring clip of every anchored case below, and
/// a pair of snap targets (1 s and 3 s) for the free ones.
const CLIP: LayerSummary = {
  id: "clip-1",
  label: null,
  t_start_us: 1_000_000,
  t_end_us: 3_000_000,
  kind: "VideoClip",
  color_hint: "#5588aa",
  enabled: true,
  locked: false,
  effects: [],
  params: {
    kind: "VideoClip",
    media_id: "media-1",
    media_label: "clip.mov",
    src_in_us: 2_000_000,
    src_out_us: 4_000_000,
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

const TRACK: TrackSummary = {
  id: "track-1",
  kind: "Video",
  label: null,
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: null,
  transient: true,
  layers: [CLIP],
};

/// 2000 px/s at 30 fps: one frame is 66.7 px, so a snap strength of 12 px is a
/// fraction of a frame and cannot be confused with the grid's own rounding.
function context(over: Partial<MarkerDragContext> = {}): MarkerDragContext {
  return {
    markerId: "marker-1",
    originalTUs: 2_000_000,
    originalEndTUs: null,
    anchored: false,
    startClientX: 0,
    pxPerSec: 2000,
    fpsNum: 30,
    fpsDen: 1,
    bounds: { minUs: 0, maxUs: null },
    snap: {
      visibleTracks: [TRACK],
      links: [],
      linkByLayerId: new Map(),
      enabled: false,
      strengthPx: 12,
      ...(over.snap ?? {}),
    },
    ...over,
  };
}

/// The same drag zoomed out to 100 px/s, where the 12 px snap strength spans
/// more than a frame and the snap has something to say.
const zoomedOut = (snapping: boolean): MarkerDragContext => {
  const base = context({ pxPerSec: 100 });
  return { ...base, snap: { ...base.snap, enabled: snapping } };
};

/// The playhead is a snap target too; parked far from every case that is not
/// about it.
const PLAYHEAD_US = 90_000_000;

describe("markerDragTimeUs", () => {
  it("lands every preview on the composition frame grid", () => {
    // Half a frame of travel is still a whole frame of movement, because a
    // preview sitting between frames is a landing the commit cannot make.
    const ctx = context();
    expect(markerDragTimeUs(ctx, 20_000, PLAYHEAD_US)).toBe(2_033_333);
    expect(markerDragTimeUs(ctx, 10_000, PLAYHEAD_US)).toBe(2_000_000);
  });

  // Measured from the press, never accumulated per move: after a clamp has held
  // the glyph still, the pointer coming back has to bring it straight back with
  // it rather than resuming from where it was pinned.
  it("reads the pointer's total travel, so a return trip lands where it started", () => {
    const ctx = context({ anchored: true, bounds: { minUs: 1_000_000, maxUs: 2_966_667 } });
    expect(markerDragTimeUs(ctx, 5_000_000, PLAYHEAD_US)).toBe(2_966_667);
    expect(markerDragTimeUs(ctx, 0, PLAYHEAD_US)).toBe(2_000_000);
  });

  it("stops an anchored marker at its clip's edges instead of running past them", () => {
    const ctx = context({ anchored: true, bounds: { minUs: 1_000_000, maxUs: 2_966_667 } });
    expect(markerDragTimeUs(ctx, 9_000_000, PLAYHEAD_US)).toBe(2_966_667);
    expect(markerDragTimeUs(ctx, -9_000_000, PLAYHEAD_US)).toBe(1_000_000);
  });

  it("never lets a free marker cross zero", () => {
    expect(markerDragTimeUs(context(), -9_000_000, PLAYHEAD_US)).toBe(0);
  });

  // Clip edges and the playhead, which is what Premiere and Resolve snap a
  // marker to. No flag of the marker lane's own: the preference the clip drag
  // and the blade already obey is the one that governs here.
  //
  // At 100 px/s a frame is 6.7 px, so the 12 px strength reaches past one — the
  // only zoom band where snapping does anything a marker's own frame grid does
  // not already do.
  it("snaps a free marker to a clip edge within the strength, and not without it", () => {
    expect(markerDragTimeUs(zoomedOut(true), 900_000, PLAYHEAD_US)).toBe(3_000_000);
    expect(markerDragTimeUs(zoomedOut(false), 900_000, PLAYHEAD_US)).toBe(2_900_000);
  });

  it("snaps to the playhead", () => {
    expect(markerDragTimeUs(zoomedOut(true), 1_400_000, 3_500_000)).toBe(3_500_000);
    expect(markerDragTimeUs(zoomedOut(false), 1_400_000, 3_500_000)).toBe(3_400_000);
  });

  // A boundary the marker may not land on is not offered at all. Offering it and
  // clamping afterwards would pull the glyph off its own clip and then drag it
  // back, which reads as the snap fighting the pointer.
  it("offers no snap target the marker may not land on", () => {
    const ctx = {
      ...zoomedOut(true),
      anchored: true,
      bounds: { minUs: 1_000_000, maxUs: 2_966_667 },
    };
    // The clip's END boundary is inside the strength and outside the span, so
    // the drag keeps the frame the pointer is on — and does NOT arrive at the
    // upper bound, which is where the clamp would have parked a snapped-past-it
    // preview.
    expect(markerDragTimeUs(ctx, 900_000, PLAYHEAD_US)).toBe(2_900_000);
  });
});
