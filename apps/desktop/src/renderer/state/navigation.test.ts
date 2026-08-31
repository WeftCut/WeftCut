import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampSeekUs,
  jumpToLayer,
  registerOpenMediaPoolPanel,
  registerRevealMedia,
  registerRevealTrack,
  registerScrollToTime,
  revealInMediaPool,
  revealLayerWithoutSeek,
  revealTrackWithoutSelection,
  selectLayer,
  selectLayers,
  seekToClamped,
  seekToNextEdit,
  seekToNextMarker,
  seekToPrevEdit,
  seekToPrevMarker,
} from "./navigation";
import { registerTransport } from "./playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import {
  clearLayerSelection,
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
  setLayerSelection,
} from "./selectionStore";
import { openComposition } from "./compositionAnchorStore";
import type { MarkerSummary, ProjectSummary } from "../ipc";
import {
  compositionFixture,
  groupLayerFixture,
  rootOf,
  summaryFixture,
} from "../testing/summaryFixture";

/// 10 s 30 fps summary with one video track (one clip at 2 s) and one
/// media item. Only the fields navigation touches need to be realistic.
function fixtureSummary(): ProjectSummary {
  return summaryFixture({
    project_id: "p1",
    name: "fixture",
    media: [
      {
        id: "m1", label: "beach.mp4", path: "C:/x/beach.mp4", kind: "Video",
        duration_us: 5_000_000, width: 1920, height: 1080, size_bytes: 1,
        available: true, decode_route: { kind: "Original" } as never,
        codec: "h264", pix_fmt: "yuv420p",
      },
    ],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 10_000_000,
      tracks: [
      {
        id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "a-roll", transient: false,
        layers: [
          {
            id: "l1", label: null, t_start_us: 2_000_000, t_end_us: 4_000_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: "beach.mp4",
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
          {
            id: "l2", label: "Second", t_start_us: 5_000_000, t_end_us: 6_000_000,
            kind: "Color", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "Color",
              color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } },
              width: 1920,
              height: 1080,
            },
          },
        ],
      },
    ],
      markers: [],
      links: [],
    },
  });
}

beforeEach(() => {
  useProjectStore.getState().apply(fixtureSummary());
  clearLayerSelection();
  setPlayheadTimeUs(0);
  vi.clearAllMocks();
});

describe("clampSeekUs / seekToClamped", () => {
  it("clamps to [0, lastFrameAnchorUs]", () => {
    expect(clampSeekUs(-5)).toBe(0);
    // 10 s @ 30 fps → last frame anchor 9_966_667
    expect(clampSeekUs(99_000_000)).toBe(9_966_667);
    expect(clampSeekUs(2_000_000)).toBe(2_000_000);
  });

  it("writes playheadStore optimistically and seeks the transport", () => {
    const seek = vi.fn();
    registerTransport({ play() {}, pause() {}, seek, isPlaying: () => false });
    seekToClamped(2_000_000);
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(seek).toHaveBeenCalledWith(2_000_000);
  });
});

describe("seekToPrevEdit / seekToNextEdit", () => {
  // Fixture edit points: 0, 2s, 4s (l1 boundaries), 5s, 6s (l2 boundaries).

  it("walks forward across every layer boundary", () => {
    setPlayheadTimeUs(0);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(2_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(4_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(5_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(6_000_000);
  });

  it("walks backward and reaches 0", () => {
    setPlayheadTimeUs(6_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(5_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(4_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(2_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(0);
    // Already at the first point — stays put.
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(0);
  });

  it("navigates from a position between edit points", () => {
    setPlayheadTimeUs(4_500_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(4_000_000);
    setPlayheadTimeUs(4_500_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(5_000_000);
  });

  it("is a no-op past the last edit point", () => {
    setPlayheadTimeUs(7_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(7_000_000);
  });

  it("clamps a boundary at the exclusive composition end to the last frame anchor", () => {
    // Stretch l2 to the composition end: its t_end (10s) is exclusive, so
    // "next edit" from 6s parks on the last frame's start, not on 10s.
    const summary = fixtureSummary();
    rootOf(summary).tracks[0]!.layers[1]!.t_end_us = 10_000_000;
    useProjectStore.getState().apply(summary);
    setPlayheadTimeUs(6_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(9_966_667);
  });
});

/// A marker with only the fields the walk reads spelled out.
function marker(over: Partial<MarkerSummary> & { t_us: number }): MarkerSummary {
  return {
    id: `mk-${over.t_us}`,
    end_t_us: null,
    label: "",
    note: "",
    color_hint: "",
    anchor_layer: null,
    anchor_src_us: null,
    hibernating: false,
    ...over,
  };
}

/// The fixture summary with `markers` on its root instead of an empty lane.
function withMarkers(markers: MarkerSummary[]): ProjectSummary {
  const summary = fixtureSummary();
  rootOf(summary).markers = markers;
  return summary;
}

describe("seekToPrevMarker / seekToNextMarker", () => {
  const AT_1_5_9 = [
    marker({ t_us: 1_000_000 }),
    marker({ t_us: 5_000_000 }),
    marker({ t_us: 9_000_000 }),
  ];

  beforeEach(() => {
    useProjectStore.getState().apply(withMarkers(AT_1_5_9));
  });

  it("walks forward mark by mark and stops at the last one", () => {
    setPlayheadTimeUs(0);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(5_000_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(9_000_000);
    // No wrap: the fourth press is a dead key, not a jump back to the first.
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(9_000_000);
  });

  it("walks backward symmetrically and stops at the first one", () => {
    setPlayheadTimeUs(9_000_000);
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(5_000_000);
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
  });

  it("steps OFF a mark the playhead is standing on, never back onto it", () => {
    setPlayheadTimeUs(5_000_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(9_000_000);
    setPlayheadTimeUs(5_000_000);
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
  });

  it("counts a mark sharing the displayed frame as already reached", () => {
    // Parked inside the 5 s mark's own frame rather than on its boundary: the
    // same frame is on screen, so the mark is behind in both directions.
    setPlayheadTimeUs(5_010_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(9_000_000);
    setPlayheadTimeUs(5_010_000);
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
  });

  it("skips a mark whose own time sits off-grid in the displayed frame", () => {
    // ADR 0037 keeps marks on the grid, and one that got off it must still not
    // be walked to from the frame it is drawn in: the jump would change no
    // frame and would park the playhead off the lattice.
    useProjectStore
      .getState()
      .apply(
        withMarkers([marker({ t_us: 5_010_000 }), marker({ t_us: 9_000_000 })]),
      );
    setPlayheadTimeUs(5_000_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(9_000_000);
  });

  it("reaches a region marker at its START, never at its end", () => {
    useProjectStore
      .getState()
      .apply(withMarkers([marker({ t_us: 3_000_000, end_t_us: 8_000_000 })]));
    setPlayheadTimeUs(0);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(3_000_000);
    // Standing INSIDE the region: it is not a mark ahead, and its end is
    // nothing to land on, so the walk has nowhere to go.
    setPlayheadTimeUs(5_000_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(5_000_000);
  });

  it("never lands on a hibernating mark", () => {
    useProjectStore.getState().apply(
      withMarkers([
        marker({ t_us: 1_000_000 }),
        marker({ t_us: 5_000_000, anchor_layer: "l1", hibernating: true }),
        marker({ t_us: 9_000_000 }),
      ]),
    );
    setPlayheadTimeUs(0);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(9_000_000);
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(1_000_000);
  });

  it("does nothing at all in a composition with no marks", () => {
    useProjectStore.getState().apply(withMarkers([]));
    setPlayheadTimeUs(4_000_000);
    seekToNextMarker();
    seekToPrevMarker();
    expect(playheadTimeUs()).toBe(4_000_000);
  });

  it("walks the FOCUSED Group's marks, not the root's, and seeks in root time", () => {
    // A Group placed at 2 s with its window opening at 0, so its clock reads
    // root minus 2 s. Its own marks are at 0.5 s and 1.5 s LOCAL.
    const summary = summaryFixture({
      project_id: "p-group",
      root: {
        duration_us: 10_000_000,
        markers: [marker({ t_us: 1_000_000 })],
        tracks: [
          {
            id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
            muted: false, solo: false, role: "a-roll", transient: false,
            layers: [
              groupLayerFixture({
                id: "layer-group",
                compositionId: "comp-group",
                tStartUs: 2_000_000,
                tEndUs: 6_000_000,
                srcInUs: 0,
                srcOutUs: 4_000_000,
              }),
            ],
          },
        ],
      },
      groups: [
        compositionFixture({
          id: "comp-group",
          duration_us: 4_000_000,
          markers: [marker({ t_us: 500_000 }), marker({ t_us: 1_500_000 })],
        }),
      ],
    });
    useProjectStore.getState().apply(summary);
    expect(openComposition("comp-group", "layer-group")).toBe(true);

    setPlayheadTimeUs(2_000_000);
    seekToNextMarker();
    // The Group's 0.5 s mark, projected up through its placement — the root's
    // own mark at 1 s is not on this timeline and never comes up.
    expect(playheadTimeUs()).toBe(2_500_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(3_500_000);
    seekToNextMarker();
    expect(playheadTimeUs()).toBe(3_500_000);
  });
});

describe("jumpToLayer", () => {
  it("selects, seeks to t_start, scrolls, and reveals the owner track", () => {
    const reveal = vi.fn();
    const scroll = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    const unScroll = registerScrollToTime(scroll);
    expect(jumpToLayer("l1")).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", "l1");
    expect(primaryLayerIdOf(currentSelection())).toBe("l1");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual(["l1"]);
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(scroll).toHaveBeenCalledWith(2_000_000);
    unReveal();
    unScroll();
  });

  it("falls back to plain selection when no reveal handle is registered", () => {
    expect(jumpToLayer("l1")).toBe(true);
    expect(primaryLayerIdOf(currentSelection())).toBe("l1");
  });

  it("returns false for a stale layer id and changes nothing", () => {
    expect(jumpToLayer("ghost")).toBe(false);
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(playheadTimeUs()).toBe(0);
  });
});

describe("revealLayerWithoutSeek / revealTrackWithoutSelection", () => {
  // The non-seeking half of jumpToLayer, for the History Panel: a history jump
  // changes what is ON the timeline, not which frame is being looked at.

  it("selects + reveals through App's handle and never seeks", () => {
    const reveal = vi.fn();
    const scroll = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    const unScroll = registerScrollToTime(scroll);
    setPlayheadTimeUs(7_000_000);

    expect(revealLayerWithoutSeek("l1")).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", "l1");
    expect(playheadTimeUs()).toBe(7_000_000);
    expect(scroll).not.toHaveBeenCalled();
    unReveal();
    unScroll();
  });

  it("falls back to a plain selection with no reveal handle mounted", () => {
    expect(revealLayerWithoutSeek("l2")).toBe(true);
    expect(primaryLayerIdOf(currentSelection())).toBe("l2");
  });

  it("returns false for a stale layer id", () => {
    expect(revealLayerWithoutSeek("ghost")).toBe(false);
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
  });

  it("reveals a track with a NULL layer id — nothing to select", () => {
    // `add_track` / `add_caption_track` rows carry a Track ref and nothing
    // else, and selectionStore has no track-selection concept.
    const reveal = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    setLayerSelection("l1", ["l1"]);

    expect(revealTrackWithoutSelection("t1")).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", null);
    // The existing selection is left alone rather than cleared.
    expect(primaryLayerIdOf(currentSelection())).toBe("l1");
    expect(playheadTimeUs()).toBe(0);
    unReveal();
  });

  it("returns false for a stale track, or with no reveal handle mounted", () => {
    expect(revealTrackWithoutSelection("t1")).toBe(false);
    const reveal = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    expect(revealTrackWithoutSelection("ghost")).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
    unReveal();
  });
});

describe("selectLayer / selectLayers", () => {
  it("selects one Layer or an exact complete set", () => {
    expect(selectLayer("l1")).toBe(true);
    expect(primaryLayerIdOf(currentSelection())).toBe("l1");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual(["l1"]);

    expect(selectLayers(["l1", "l2"], "l2")).toBe(true);
    expect(primaryLayerIdOf(currentSelection())).toBe("l2");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual(["l1", "l2"]);
  });

  it("rejects a stale Layer or invalid primary without a partial update", () => {
    setLayerSelection("l1", ["l1", "l2"]);

    expect(selectLayers(["l2", "ghost"], "l2")).toBe(false);
    expect(selectLayers(["l1"], "l2")).toBe(false);
    expect(primaryLayerIdOf(currentSelection())).toBe("l1");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual(["l1", "l2"]);
  });

  it("clears the complete selection when the Project session resets", () => {
    setLayerSelection("l2", ["l1", "l2"]);
    useProjectStore.getState().apply(null);

    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });
});

describe("revealInMediaPool", () => {
  it("focuses the Media Pool Panel and calls the mounted reveal handle", () => {
    const openPanel = vi.fn();
    const flash = vi.fn();
    const unOpen = registerOpenMediaPoolPanel(openPanel);
    const unReveal = registerRevealMedia(flash);
    expect(revealInMediaPool("m1")).toBe(true);
    expect(openPanel).toHaveBeenCalledOnce();
    expect(flash).toHaveBeenCalledWith("m1");
    unReveal();
    unOpen();
  });

  it("delivers a pending reveal after a closed Panel is recreated", () => {
    const openPanel = vi.fn();
    const unOpen = registerOpenMediaPoolPanel(openPanel);

    expect(revealInMediaPool("m1")).toBe(true);
    expect(openPanel).toHaveBeenCalledOnce();

    const flash = vi.fn();
    const unReveal = registerRevealMedia(flash);
    expect(flash).toHaveBeenCalledWith("m1");
    unReveal();
    unOpen();
  });

  it("returns false for a stale media id", () => {
    expect(revealInMediaPool("ghost")).toBe(false);
  });
});
