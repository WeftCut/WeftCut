import { create } from "zustand";

import { snapFrameRound } from "../frames";
import type {
  CompositionSummary,
  LinkSummary,
  MediaSummary,
  TrackSummary,
} from "../ipc";
import { wouldCycleInOpenComposition } from "../state/compositionScopeStore";
import type { LayerOverlapClass } from "./geometry";
import {
  evaluateTimelinePlacements,
  SPAWN_TRACK_ID,
  type PlacementValidity,
} from "./placement";
import { snapDragDeltaToTimelineBoundary } from "./snapping";

export const MEDIA_DRAG_TYPE = "application/x-weftcut-media";

// Keep the pointer inside the ghost instead of pinning it to the left edge.
// This leaves the clip's start, the content immediately before it, and the
// collision boundary visible while the user is positioning the drop.
export const MEDIA_DRAG_CURSOR_OFFSET_PX = 32;

const FALLBACK_MEDIA_DURATION_US = 2_000_000;
const DEFAULT_IMAGE_DURATION_US = 3_000_000;

/// What a pool drag carries. One gesture, two sources: a media item places a
/// clip spanning the source's own duration, a composition places a Group clip
/// spanning the composition's. `label` and `durationUs` are on both arms because
/// they are the whole of what a ghost draws — a drop surface sizes and names the
/// incoming clip without ever asking which arm it has.
export type MediaDragPayload =
  | {
      source: "media";
      mediaId: string;
      /// The pool item's `MediaSummary.kind`, which is what decides the overlap
      /// class (Audio shares a lane with a visual clip; nothing else does).
      kind: string;
      label: string;
      durationUs: number;
    }
  | {
      source: "composition";
      compositionId: string;
      label: string;
      durationUs: number;
    };

export interface MediaDragVisual {
  clientX: number;
  clientY: number;
  width: number;
  height: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
}

export interface MediaDragAbsorptionTarget {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// The placement verdicts plus the one a pool drag can reach on its own:
/// `"cycle"` is a composition dropped where it would contain itself. It refuses
/// like a collision — see `mediaDropInvalid` — and exists as its own answer
/// because the chrome has to say WHICH refusal it is; the lane is free, and
/// "Overlap" on an empty lane reads as a bug.
export type MediaDropValidity = PlacementValidity | "cycle";

/// Whether a pool drop wears the refusing chrome and is blocked at release.
/// `"spawn"` is committable and `"locked"` has its own amber (placement.ts's
/// `placementRefuses` draws the same line for a clip drag) — so this is the
/// predicate the ghost's red branch asks, not `!== "valid"`.
export function mediaDropInvalid(validity: MediaDropValidity): boolean {
  return validity === "collision" || validity === "cycle";
}

export interface MediaDropPlan {
  /// Unsnapped value sent to add_media_layer.
  rawStartUs: number;
  tStartUs: number;
  tEndUs: number;
  validity: MediaDropValidity;
  conflictingLayerIds: string[];
  overlapClass: LayerOverlapClass;
  /// When true, the ghost occupies the same half-height slot that the final
  /// layer will use beside an opposite-class layer.
  sharesLane: boolean;
}

export interface MediaDropSnapOptions {
  visibleTracks: readonly TrackSummary[];
  links: readonly LinkSummary[];
  linkByLayerId: ReadonlyMap<string, string>;
  currentTimeUs: number;
  enabled: boolean;
  strengthPx: number;
}

interface MediaDragState {
  active: MediaDragPayload | null;
  dropTargetTrackId: string | null;
  visual: MediaDragVisual | null;
  absorptionTarget: MediaDragAbsorptionTarget | null;
  begin: (payload: MediaDragPayload, visual?: MediaDragVisual) => void;
  moveVisual: (clientX: number, clientY: number) => void;
  claimDropTarget: (
    trackId: string,
    absorptionTarget?: MediaDragAbsorptionTarget,
  ) => void;
  releaseDropTarget: (trackId: string) => void;
  end: () => void;
}

export const useMediaDragStore = create<MediaDragState>((set) => ({
  active: null,
  dropTargetTrackId: null,
  visual: null,
  absorptionTarget: null,
  begin: (active, visual) =>
    set({
      active,
      dropTargetTrackId: null,
      visual: visual ?? null,
      absorptionTarget: null,
    }),
  moveVisual: (clientX, clientY) =>
    set((state) =>
      state.active === null || state.visual === null
        ? state
        : { visual: { ...state.visual, clientX, clientY } },
    ),
  claimDropTarget: (trackId, absorptionTarget) =>
    set((state) =>
      state.dropTargetTrackId === trackId &&
      state.absorptionTarget === absorptionTarget
        ? state
        : {
            dropTargetTrackId: trackId,
            absorptionTarget: absorptionTarget ?? null,
          },
    ),
  releaseDropTarget: (trackId) =>
    set((state) =>
      state.dropTargetTrackId === trackId
        ? { dropTargetTrackId: null, absorptionTarget: null }
        : state,
    ),
  end: () =>
    set({
      active: null,
      dropTargetTrackId: null,
      visual: null,
      absorptionTarget: null,
    }),
}));

/// Cap on the floating drag preview's width, so a wide pool card does not
/// follow the pointer at full size.
const MAX_DRAG_PREVIEW_WIDTH_PX = 220;

/// The floating preview's geometry for a pool row — the row's own box scaled to
/// fit the cap, with the grab point kept where it was inside it, so the preview
/// leaves the pointer exactly where it was pressed.
export function poolDragVisual(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): MediaDragVisual {
  const rect = element.getBoundingClientRect();
  const scale = Math.min(1, MAX_DRAG_PREVIEW_WIDTH_PX / rect.width);
  return {
    clientX,
    clientY,
    width: rect.width * scale,
    height: rect.height * scale,
    pointerOffsetX: (clientX - rect.left) * scale,
    pointerOffsetY: (clientY - rect.top) * scale,
  };
}

/// Chromium's native drag image is a frozen translucent snapshot and cannot
/// animate into the timeline ghost. Replace it with a transparent pixel; the
/// app-owned drag preview is the visible, animatable surface.
export function hideNativeDragPreview(dataTransfer: DataTransfer): void {
  if (typeof dataTransfer.setDragImage !== "function") return;
  const pixel = document.createElement("div");
  pixel.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(pixel);
  dataTransfer.setDragImage(pixel, 0, 0);
  window.setTimeout(() => pixel.remove(), 0);
}

export function mediaPlacementDurationUs(media: MediaSummary): number {
  // Matches add_media_layer's user-visible defaults. Still images get a
  // useful timeline span; animated images with a probed duration keep it.
  if (media.kind === "Image") {
    const durationUs = media.duration_us;
    return durationUs !== null && durationUs >= 500_000
      ? durationUs
      : DEFAULT_IMAGE_DURATION_US;
  }
  return media.duration_us ?? FALLBACK_MEDIA_DURATION_US;
}

export function mediaDragPayload(media: MediaSummary): MediaDragPayload {
  return {
    source: "media",
    mediaId: media.id,
    kind: media.kind,
    label: media.label,
    durationUs: mediaPlacementDurationUs(media),
  };
}

/// A composition drag. `label` is the name the pool row shows — derived or set,
/// resolved by the caller, because deriving `Group N` needs the whole
/// composition set and the locale bundle.
export function compositionDragPayload(
  composition: Pick<CompositionSummary, "id" | "duration_us">,
  label: string,
): MediaDragPayload {
  return {
    source: "composition",
    compositionId: composition.id,
    label,
    durationUs: composition.duration_us,
  };
}

export function parseMediaDrag(e: React.DragEvent): MediaDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.label !== "string" ||
      typeof parsed.durationUs !== "number"
    ) {
      return null;
    }
    if (parsed.source === "composition") {
      return typeof parsed.compositionId === "string"
        ? (parsed as unknown as MediaDragPayload)
        : null;
    }
    // `source: "media"` is checked by its own fields rather than by the tag, so a
    // payload that predates the tag still parses as what it is.
    return typeof parsed.mediaId === "string" && typeof parsed.kind === "string"
      ? ({ ...parsed, source: "media" } as unknown as MediaDragPayload)
      : null;
  } catch {
    return null;
  }
}

/// A Group clip composites like any clip, so a composition drop is `visual` —
/// the same answer `validate.ts`'s `layerOverlapClass` gives a `CompositionRef`.
function dragOverlapClass(payload: MediaDragPayload): LayerOverlapClass {
  return payload.source === "media" && payload.kind === "Audio"
    ? "audio"
    : "visual";
}

export function planMediaDrop({
  track,
  media,
  pointerXPx,
  pxPerSec,
  fpsNum,
  fpsDen,
  snap,
}: {
  /// The destination lane, or null for the drop strip — no lane exists there
  /// yet, so the placement is evaluated against `SPAWN_TRACK_ID` and answers
  /// `"spawn"`. Everything else about the plan (start time, snapping, ghost
  /// span) is identical, which is the point of routing both through here.
  track: TrackSummary | null;
  media: MediaDragPayload;
  pointerXPx: number;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  snap?: MediaDropSnapOptions;
}): MediaDropPlan {
  const baseRawStartUs = Math.max(
    0,
    Math.round(
      ((pointerXPx - MEDIA_DRAG_CURSOR_OFFSET_PX) / pxPerSec) * 1_000_000,
    ),
  );
  // add_media_layer creates tEnd from the *raw* start plus source duration,
  // then applyAddLayer snaps both edges independently. This mirrors the
  // frame-grid case; Audio commits on the sample grid instead (ADR 0038), so
  // an audio ghost can sit a sub-frame off its committed layer.
  const baseTStartUs = snapFrameRound(baseRawStartUs, fpsNum, fpsDen);
  const baseTEndUs = snapFrameRound(
    baseRawStartUs + media.durationUs,
    fpsNum,
    fpsDen,
  );
  const boundaryDeltaUs = snap
    ? snapDragDeltaToTimelineBoundary({
        state: {
          kind: "move",
          // The incoming layer has no project id yet. This sentinel cannot
          // match a live layer, so every visible boundary remains eligible.
          layerId: "__media-drop-ghost__",
          originalTStart: baseTStartUs,
          originalTEnd: baseTEndUs,
          escapeLink: true,
        },
        frameDeltaUs: 0,
        visibleTracks: snap.visibleTracks,
        links: snap.links,
        linkByLayerId: snap.linkByLayerId,
        currentTimeUs: snap.currentTimeUs,
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: snap.enabled,
        strengthPx: snap.strengthPx,
      })
    : 0;
  // Apply the chosen boundary delta to the actor input, then recompute both
  // snapped edges. The ghost and collision interval therefore match the
  // committed layer even at fractional frame rates.
  const rawStartUs = Math.max(0, baseRawStartUs + boundaryDeltaUs);
  const tStartUs = snapFrameRound(rawStartUs, fpsNum, fpsDen);
  const tEndUs = snapFrameRound(
    rawStartUs + media.durationUs,
    fpsNum,
    fpsDen,
  );
  const overlapClass = dragOverlapClass(media);
  // The cycle gate out-ranks the lane: a composition that would contain itself
  // is refused wherever it is released, so no lane, and no free interval on one,
  // can make it droppable. Read from the scope store here rather than threaded in
  // by each drop surface, because the answer depends only on WHAT is being
  // dragged and WHERE the editor is looking — not on the lane under the pointer,
  // which is all a drop surface knows.
  if (media.source === "composition" && wouldCycleInOpenComposition(media.compositionId)) {
    return {
      rawStartUs,
      tStartUs,
      tEndUs,
      validity: "cycle",
      conflictingLayerIds: [],
      overlapClass,
      sharesLane: false,
    };
  }
  const evaluation = evaluateTimelinePlacements({
    tracks: track ? [track] : [],
    placements: [
      {
        layerId: "__media-drop-ghost__",
        trackId: track?.id ?? SPAWN_TRACK_ID,
        tStartUs,
        tEndUs,
        overlapClass,
        locked: false,
      },
    ],
    replacedLayerIds: new Set(),
  });

  return {
    rawStartUs,
    tStartUs,
    tEndUs,
    validity: evaluation.validity,
    conflictingLayerIds: evaluation.conflictingLayerIds,
    overlapClass,
    sharesLane: evaluation.sharesLane,
  };
}
