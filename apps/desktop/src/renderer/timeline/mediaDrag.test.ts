import { afterEach, describe, expect, it } from "vitest";

import type { LayerSummary, MediaSummary, TrackSummary } from "../ipc";
import { useCompositionScopeStore } from "../state/compositionScopeStore";
import {
  MEDIA_DRAG_CURSOR_OFFSET_PX,
  compositionDragPayload,
  mediaDragPayload,
  mediaDropInvalid,
  mediaPlacementDurationUs,
  parseMediaDrag,
  planMediaDrop,
  useMediaDragStore,
} from "./mediaDrag";

const staticNum = (value: number) => ({ mode: "Static" as const, value });

afterEach(() => useMediaDragStore.getState().end());

function media(overrides: Partial<MediaSummary> = {}): MediaSummary {
  return {
    id: "media-1",
    label: "Interview",
    path: "C:/media/interview.mp4",
    kind: "Video",
    duration_us: 3_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 1024,
    available: true,
    decode_route: { route: "bypass" },
    codec: "h264",
    pix_fmt: "yuv420p",
    ...overrides,
  };
}

function visualLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "VideoClip",
    color_hint: "#5588aa",
    enabled: true,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: "media-existing",
      media_label: "existing.mp4",
      src_in_us: 0,
      src_out_us: tEndUs - tStartUs,
      x: staticNum(0),
      y: staticNum(0),
      scale_x: staticNum(1),
      scale_y: staticNum(1),
      scale_linked: true,
      rotation_deg: staticNum(0),
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
      opacity: staticNum(1),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

function audioLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "Audio",
    color_hint: "#aa8855",
    enabled: true,
    locked: false,
    params: {
      kind: "Audio",
      media_id: "media-audio",
      media_label: "audio.wav",
      src_in_us: 0,
      src_out_us: tEndUs - tStartUs,
      gain_db: staticNum(0),
      pan: staticNum(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "music",
    },
    effects: [],
  };
}

function track(layers: LayerSummary[], locked = false): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "A roll",
    enabled: true,
    locked,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

describe("media drag placement", () => {
  it("uses source duration and the timeline defaults for missing durations", () => {
    expect(mediaPlacementDurationUs(media())).toBe(3_000_000);
    expect(mediaPlacementDurationUs(media({ duration_us: null }))).toBe(
      2_000_000,
    );
    expect(
      mediaPlacementDurationUs(
        media({ kind: "Image", duration_us: null }),
      ),
    ).toBe(3_000_000);
  });

  it("places the pointer a fixed distance inside the ghost", () => {
    const payload = mediaDragPayload(media());
    const plan = planMediaDrop({
      track: track([]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });

    expect(plan.rawStartUs).toBe(1_000_000);
    expect(plan.tStartUs).toBe(1_000_000);
    expect(plan.tEndUs).toBe(4_000_000);
    expect(plan.validity).toBe("valid");
  });

  it("obeys the existing tail-snap setting for the ghost and final drop", () => {
    const payload = mediaDragPayload(media());
    const targetTrack = track([visualLayer("previous", 0, 2_000_000)]);
    const plan = planMediaDrop({
      track: targetTrack,
      media: payload,
      // Raw start=1.9s. At 100px/s and strength=20px, the existing 2s
      // boundary is inside the 200ms snap radius. Before snapping this also
      // overlaps the previous clip, so collision must be evaluated afterward.
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 190,
      pxPerSec: 100,
      fpsNum: 30,
      fpsDen: 1,
      snap: {
        visibleTracks: [targetTrack],
        links: [],
        linkByLayerId: new Map(),
        currentTimeUs: 10_000_000,
        enabled: true,
        strengthPx: 20,
      },
    });

    expect(plan.rawStartUs).toBe(2_000_000);
    expect(plan.tStartUs).toBe(2_000_000);
    expect(plan.tEndUs).toBe(5_000_000);
    expect(plan.validity).toBe("valid");
  });

  it("keeps the unsnapped frame position when tail snap is disabled", () => {
    const payload = mediaDragPayload(media());
    const targetTrack = track([visualLayer("previous", 0, 2_000_000)]);
    const plan = planMediaDrop({
      track: targetTrack,
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 210,
      pxPerSec: 100,
      fpsNum: 30,
      fpsDen: 1,
      snap: {
        visibleTracks: [targetTrack],
        links: [],
        linkByLayerId: new Map(),
        currentTimeUs: 10_000_000,
        enabled: false,
        strengthPx: 20,
      },
    });

    expect(plan.rawStartUs).toBe(2_100_000);
    expect(plan.tStartUs).toBe(2_100_000);
  });

  it("snaps the ghost tail as well as its head", () => {
    const payload = mediaDragPayload(media());
    const targetTrack = track([visualLayer("next", 5_000_000, 6_000_000)]);
    const plan = planMediaDrop({
      track: targetTrack,
      media: payload,
      // Raw [1.9s,4.9s); its tail is within 100ms of the next clip's 5s edge.
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 190,
      pxPerSec: 100,
      fpsNum: 30,
      fpsDen: 1,
      snap: {
        visibleTracks: [targetTrack],
        links: [],
        linkByLayerId: new Map(),
        currentTimeUs: 10_000_000,
        enabled: true,
        strengthPx: 20,
      },
    });

    expect(plan.tStartUs).toBe(2_000_000);
    expect(plan.tEndUs).toBe(5_000_000);
    expect(plan.validity).toBe("valid");
  });

  it("reports same-class overlap as a collision but allows a shared AV row", () => {
    const payload = mediaDragPayload(media());
    const collision = planMediaDrop({
      track: track([visualLayer("video", 0, 2_000_000)]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });
    const shared = planMediaDrop({
      track: track([audioLayer("audio", 0, 2_000_000)]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });

    expect(collision.validity).toBe("collision");
    expect(collision.conflictingLayerIds).toEqual(["video"]);
    expect(shared.validity).toBe("valid");
    expect(shared.sharesLane).toBe(true);
  });

  it("treats touching half-open intervals as valid and reports locked tracks", () => {
    const payload = mediaDragPayload(media());
    const adjacent = planMediaDrop({
      track: track([visualLayer("video", 0, 1_000_000)]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });
    const locked = planMediaDrop({
      track: track([], true),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });

    expect(adjacent.validity).toBe("valid");
    expect(locked.validity).toBe("locked");
  });

  it("answers spawn for the drop strip with the same span a lane would get", () => {
    const payload = mediaDragPayload(media());
    const occupied = track([visualLayer("video", 0, 10_000_000)]);
    const args = {
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    };
    const onLane = planMediaDrop({ ...args, track: occupied });
    const onStrip = planMediaDrop({ ...args, track: null });

    // The span is a property of the pointer and the source, not of the
    // destination — only the answer about the destination differs.
    expect(onStrip.tStartUs).toBe(onLane.tStartUs);
    expect(onStrip.tEndUs).toBe(onLane.tEndUs);
    expect(onLane.validity).toBe("collision");
    expect(onStrip.validity).toBe("spawn");
    expect(onStrip.conflictingLayerIds).toEqual([]);
  });
});

describe("media drag target ownership", () => {
  it("ignores a stale leave after another track has claimed focus", () => {
    const drag = useMediaDragStore.getState();
    drag.begin(mediaDragPayload(media()));
    drag.claimDropTarget("a-roll");
    drag.claimDropTarget("b-roll");

    drag.releaseDropTarget("a-roll");
    expect(useMediaDragStore.getState().dropTargetTrackId).toBe("b-roll");

    drag.releaseDropTarget("b-roll");
    expect(useMediaDragStore.getState().dropTargetTrackId).toBeNull();
  });

  it("moves the custom preview and clears its absorption target on leave", () => {
    const drag = useMediaDragStore.getState();
    drag.begin(mediaDragPayload(media()), {
      clientX: 100,
      clientY: 80,
      width: 180,
      height: 120,
      pointerOffsetX: 20,
      pointerOffsetY: 30,
    });

    drag.moveVisual(140, 110);
    drag.claimDropTarget("a-roll", {
      left: 120,
      top: 200,
      width: 36,
      height: 20,
    });

    expect(useMediaDragStore.getState()).toMatchObject({
      visual: { clientX: 140, clientY: 110 },
      dropTargetTrackId: "a-roll",
      absorptionTarget: {
        left: 120,
        top: 200,
        width: 36,
        height: 20,
      },
    });

    drag.releaseDropTarget("a-roll");
    expect(useMediaDragStore.getState().absorptionTarget).toBeNull();
  });
});

// The drag from the media pool's Groups section. Its one extra refusal is
// structural rather than geometric, so it is decided before any lane is asked.
describe("composition drag placement", () => {
  const GROUP = { id: "comp-group", duration_us: 4_000_000 };
  const args = {
    pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
    pxPerSec: 80,
    fpsNum: 30,
    fpsDen: 1,
  };

  afterEach(() =>
    useCompositionScopeStore.setState({
      projectId: "p",
      openId: "comp-root",
      crumbs: [],
      playheads: new Map(),
    }),
  );

  it("spans the composition's own duration, on the visual lane", () => {
    const plan = planMediaDrop({
      ...args,
      track: track([]),
      media: compositionDragPayload(GROUP, "Group 1"),
    });
    expect(plan.validity).toBe("valid");
    expect(plan.tEndUs - plan.tStartUs).toBe(GROUP.duration_us);
    // A Group clip composites, so it collides with a visual clip and shares a
    // lane with audio — exactly what a video drop does.
    expect(plan.overlapClass).toBe("visual");
  });

  it("refuses the composition the editor is standing inside", () => {
    useCompositionScopeStore.setState({
      openId: GROUP.id,
      crumbs: [{ layerId: "layer-group", compositionId: GROUP.id }],
    });
    const plan = planMediaDrop({
      ...args,
      track: track([]),
      media: compositionDragPayload(GROUP, "Group 1"),
    });
    expect(plan.validity).toBe("cycle");
    expect(mediaDropInvalid(plan.validity)).toBe(true);
    // No lane is named, because no lane could have made it droppable.
    expect(plan.conflictingLayerIds).toEqual([]);
  });

  it("refuses an ANCESTOR of the open composition, on a lane and on the strip alike", () => {
    // Standing two deep: root › outer › inner. Placing `outer` here would make
    // it contain itself through `inner`.
    const outer = { id: "comp-outer", duration_us: 2_000_000 };
    useCompositionScopeStore.setState({
      openId: "comp-inner",
      crumbs: [
        { layerId: "layer-outer", compositionId: outer.id },
        { layerId: "layer-inner", compositionId: "comp-inner" },
      ],
    });
    const payload = compositionDragPayload(outer, "Group 1");
    expect(planMediaDrop({ ...args, track: track([]), media: payload }).validity).toBe("cycle");
    // The strip spawns a lane, and a fresh lane does not break the loop either.
    expect(planMediaDrop({ ...args, track: null, media: payload }).validity).toBe("cycle");
    // A DESCENDANT is fine: nesting deeper closes no loop.
    const other = { id: "comp-other", duration_us: 2_000_000 };
    expect(
      planMediaDrop({ ...args, track: track([]), media: compositionDragPayload(other, "Group 2") })
        .validity,
    ).toBe("valid");
  });

  it("round-trips through the dataTransfer payload both sources use", () => {
    const payload = compositionDragPayload(GROUP, "Intro");
    const raw = JSON.stringify(payload);
    const parsed = parseMediaDrag({
      dataTransfer: { getData: () => raw },
    } as unknown as React.DragEvent);
    expect(parsed).toEqual(payload);
    const mediaParsed = parseMediaDrag({
      dataTransfer: { getData: () => JSON.stringify(mediaDragPayload(media())) },
    } as unknown as React.DragEvent);
    expect(mediaParsed).toMatchObject({ source: "media", mediaId: "media-1" });
  });
});
