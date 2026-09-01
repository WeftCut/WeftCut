import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayerBlock, type PendingLayerPlacement } from "./LayerBlock";
import {
  shiftMembersOf,
  useLayerDragForTrack,
  type DragSeed,
  type DragSubject,
} from "./layerDragStore";
import { shiftOnGrids } from "../grid";
import {
  computeLayerSlices,
  layerSliceRect,
  type LayerSlice,
  type LinkTab,
} from "./geometry";
import { formatTimecode } from "../frames";
import { TransitionChip } from "./TransitionChip";
import {
  transitionChipsForTrack,
  type TrackTransitionChip,
  type TransitionResizeArgs,
} from "./transitions";
import type {
  AnimTrack,
  LayerSummary,
  TrackSummary,
  TransitionSummary,
} from "../ipc";
import { playheadClockUs } from "../state/playheadProjection";
import { useMarqueeAnchor } from "./hooks/useMarqueeAnchor";
import {
  MEDIA_DRAG_CURSOR_OFFSET_PX,
  MEDIA_DRAG_TYPE,
  mediaDropInvalid,
  parseMediaDrag,
  planMediaDrop,
  useMediaDragStore,
  type MediaDragPayload,
  type MediaDropPlan,
  type MediaDropSnapOptions,
} from "./mediaDrag";
import { previewTrackId } from "./placement";

export function TrackLane({
  track,
  registerLaneEl,
  pxPerSec,
  height,
  isExpanded,
  selectedLayerId,
  selectedLayerIds,
  transitions,
  selectedTransitionId,
  linkByLayerId,
  linkTabByLayerId,
  pendingPlacements,
  pendingLayerById,
  dragLayerById,
  bladeMode,
  onBladeSplit,
  onBladePreview,
  onSelectFromClick,
  onDragStart,
  onMediaDrop,
  onContextMenu,
  onChipContextMenu,
  onChipResize,
  onCommitLabel,
  onCommitLinkLabel,
  onCommitGroupLabel,
  onCommitParamTrack,
  isRevealed,
  isResizing,
  onHeightDragStart,
  fpsNum,
  fpsDen,
  mediaDropSnap,
  compositionId,
}: {
  track: TrackSummary;
  /// Publishes this lane's DOM node to the Timeline's lane registry, which is
  /// what the drag hit-test measures (`trackIdAtClientY`). Called with null on
  /// unmount.
  registerLaneEl: (trackId: string, el: HTMLElement | null) => void;
  pxPerSec: number;
  height: number;
  /// True when this track's keyframe sub-lanes are expanded — collapsed
  /// in-clip diamonds are hidden (the sub-lanes render them instead).
  isExpanded: boolean;
  selectedLayerId: string | null;
  selectedLayerIds: ReadonlySet<string>;
  /// Full project transition list; the lane filters to chips whose both
  /// participants live on this track.
  transitions: TransitionSummary[];
  selectedTransitionId: string | null;
  linkByLayerId: Map<string, string>;
  /// Each link's anchor member → its tab (`indexLinkTabs`); a layer absent
  /// from the map draws no link chrome beyond the accent.
  linkTabByLayerId: ReadonlyMap<string, LinkTab>;
  pendingPlacements: PendingLayerPlacement[] | null;
  pendingLayerById: ReadonlyMap<string, LayerSummary>;
  dragLayerById: ReadonlyMap<string, LayerSummary>;
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onBladePreview: (layer: LayerSummary | null, clientX?: number) => void;
  /// Pass-through to `LayerBlock`, whose prop docstring owns the contract:
  /// applies the click's selection semantics, returns whether the clicked layer
  /// is selected afterwards.
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => boolean;
  onDragStart: (state: DragSeed) => void;
  onMediaDrop: (
    track: TrackSummary,
    payload: MediaDragPayload,
    plan: MediaDropPlan,
  ) => void;
  /// Context-menu hook. LayerBlock fires this on right-click; the
  /// Timeline shows a small floating menu and routes the chosen
  /// action.
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
    layerEnabled: boolean,
  ) => void;
  /// Transition-chip counterpart of `onContextMenu` — the Timeline anchors
  /// the chip menu at the cursor for this chip's transition.
  onChipContextMenu: (e: React.MouseEvent, chip: TrackTransitionChip) => void;
  /// Chip edge-drag commit — the Timeline lowers the assembled patch through
  /// `updateTransition` (one commit per gesture, spec D6).
  onChipResize: (args: TransitionResizeArgs) => void;
  onCommitLabel: (layerId: string, label: string) => void;
  onCommitLinkLabel: (linkId: string, label: string | null) => void;
  onCommitGroupLabel: (compositionId: string, label: string | null) => void;
  onCommitParamTrack: (layerId: string, paramKey: string, track: AnimTrack<number>) => void;
  /// Inline-reveal flag. The lane renders with extra chrome
  /// (dashed border / "hidden" badge) so the user knows this row is
  /// only here because they clicked a Playhead Panel row.
  isRevealed: boolean;
  /// True while any track-height drag is in flight — keeps the resize
  /// handle highlighted even when the pointer wanders off it mid-drag.
  isResizing: boolean;
  onHeightDragStart: (e: React.PointerEvent) => void;
  fpsNum: number;
  fpsDen: number;
  mediaDropSnap: Omit<MediaDropSnapOptions, "currentTimeUs">;
  /// The composition this lane belongs to — this Panel's own, whichever tab
  /// holds the keyboard. It offers the playhead as a snap boundary on this
  /// Panel's own axis (`state/playheadProjection.ts`) and answers the cycle gate
  /// for a Group released here.
  compositionId: string | null;
}) {
  const { t } = useTranslation();
  // Null unless this lane is one the gesture concerns — it holds a subject, or
  // the pointer is over it. Every other lane sits out the pointermove entirely
  // (`layerDragStore.ts`).
  const dragState = useLayerDragForTrack(track.id);
  const activeMediaDrag = useMediaDragStore((s) => s.active);
  const dropTargetTrackId = useMediaDragStore((s) => s.dropTargetTrackId);
  const claimDropTarget = useMediaDragStore((s) => s.claimDropTarget);
  const releaseDropTarget = useMediaDragStore((s) => s.releaseDropTarget);
  const endMediaDrag = useMediaDragStore((s) => s.end);
  const [dropPreview, setDropPreview] = useState<{
    media: MediaDragPayload;
    plan: MediaDropPlan;
  } | null>(null);

  useEffect(() => {
    if (activeMediaDrag === null || dropTargetTrackId !== track.id) {
      setDropPreview(null);
    }
  }, [activeMediaDrag, dropTargetTrackId, track.id]);

  const visibleDropPreview =
    dropTargetTrackId === track.id ? dropPreview : null;

  const dragPreviewTrackId = useCallback(
    (subject: DragSubject): string => {
      if (dragState?.kind !== "move") return subject.trackId;
      if (subject.layerId !== dragState.layerId) return subject.trackId;
      return previewTrackId(dragState.overTrackId, subject.trackId);
    },
    [dragState],
  );

  const renderedLayers = useMemo(() => {
    let layers = track.layers;

    for (const pendingPlacement of pendingPlacements ?? []) {
      const pendingLayer = pendingLayerById.get(pendingPlacement.layerId);
      if (!pendingLayer) continue;
      const pendingRenderLayer: LayerSummary = {
        ...pendingLayer,
        id: pendingPlacement.layerId,
        t_start_us: pendingPlacement.tStartUs,
        t_end_us: pendingPlacement.tEndUs,
      };

      if (pendingPlacement.trackId === track.id) {
        let replaced = false;
        layers = layers.map((layer) => {
          if (layer.id !== pendingPlacement.layerId) return layer;
          replaced = true;
          return pendingRenderLayer;
        });
        if (!replaced) layers = [...layers, pendingRenderLayer];
      } else {
        layers = layers.filter(
          (layer) => layer.id !== pendingPlacement.layerId,
        );
      }
    }

    if (dragState?.kind === "move" && !dragState.duplicate) {
      for (const subject of dragState.subjects) {
        const layer = dragLayerById.get(subject.layerId);
        if (!layer) continue;
        const previewTrackId = dragPreviewTrackId(subject);
        if (previewTrackId === track.id) {
          if (!layers.some((candidate) => candidate.id === layer.id)) {
            layers = [...layers, layer];
          }
        } else if (subject.trackId === track.id) {
          layers = layers.filter((candidate) => candidate.id !== subject.layerId);
        }
      }
    }

    return layers;
  }, [
    dragLayerById,
    dragPreviewTrackId,
    dragState,
    pendingLayerById,
    pendingPlacements,
    track.id,
    track.layers,
  ]);

  // Static per project version (playhead-gate discipline): derives only from
  // the summary, so playback never re-renders the chip layer.
  const transitionChips = useMemo(
    () => transitionChipsForTrack(track, transitions),
    [track, transitions],
  );

  // One in-flight clone ghost per duplicate subject landing on THIS lane: the
  // dragged seed follows the pointer's lane, every other member stays on its
  // own — the same rule the move projection and `paste_layers` apply.
  const duplicatePreviews = useMemo(() => {
    if (dragState?.kind !== "move" || !dragState.duplicate) return [];
    const out: { layer: LayerSummary; sliceLayer: LayerSummary }[] = [];
    for (const subject of dragState.subjects) {
      const layer = dragLayerById.get(subject.layerId);
      if (!layer) continue;
      const previewTrackId =
        subject.layerId === dragState.layerId
          ? (dragState.overTrackId ?? subject.trackId)
          : subject.trackId;
      if (previewTrackId !== track.id) continue;
      // Per member, and clamped per member: a duplicate's members are placed one
      // at a time (`pasteLayerInterval` resolves one layer), so unlike a move
      // there is no set for the zero boundary to stop as one body.
      //
      // The endpoints themselves are the shared arithmetic (`renderer/grid.ts`),
      // which is what `pasteLayerInterval` computes on the other side of the
      // commit: both endpoints take the same delta and snap on this member's own
      // lattice.
      const clampedStartUs = Math.max(
        0,
        subject.originalTStart + dragState.deltaUs,
      );
      const landed = shiftOnGrids(
        shiftMembersOf([subject]),
        clampedStartUs - subject.originalTStart,
        { num: fpsNum, den: fpsDen },
      ).get(subject.layerId)!;
      out.push({
        layer,
        sliceLayer: {
          ...layer,
          id: `${layer.id}::duplicate-preview`,
          t_start_us: landed.tStartUs,
          t_end_us: landed.tEndUs,
        } satisfies LayerSummary,
      });
    }
    return out;
  }, [dragLayerById, dragState, fpsDen, fpsNum, track.id]);

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
      e.preventDefault();
      if (activeMediaDrag === null) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = planMediaDrop({
        compositionId,
        track,
        media: activeMediaDrag,
        pointerXPx: e.clientX - rect.left,
        pxPerSec,
        fpsNum,
        fpsDen,
        snap: { ...mediaDropSnap, currentTimeUs: playheadClockUs(compositionId) },
      });
      e.dataTransfer.dropEffect = plan.validity === "valid" ? "copy" : "none";
      const slot = mediaDropGhostSlot(height, plan);
      const ghostLeft =
        rect.left + (plan.tStartUs / 1_000_000) * pxPerSec;
      const ghostWidth = Math.max(
        4,
        ((plan.tEndUs - plan.tStartUs) / 1_000_000) * pxPerSec,
      );
      // The floating media card collapses into a compact point inside the
      // ghost while the ghost itself expands from that same point.
      const targetWidth = Math.min(36, Math.max(14, ghostWidth));
      const targetHeight = Math.min(20, Math.max(10, slot.height * 0.45));
      const anchorX = ghostLeft + Math.min(MEDIA_DRAG_CURSOR_OFFSET_PX, ghostWidth / 2);
      claimDropTarget(track.id, {
        left: anchorX - targetWidth / 2,
        top: rect.top + slot.top + (slot.height - targetHeight) / 2,
        width: targetWidth,
        height: targetHeight,
      });
      setDropPreview({ media: activeMediaDrag, plan });
    },
    [
      activeMediaDrag,
      claimDropTarget,
      compositionId,
      fpsDen,
      fpsNum,
      height,
      mediaDropSnap,
      pxPerSec,
      track,
    ],
  );

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Crossing a child LayerBlock is not leaving the lane. Without this guard
    // the ghost flickers whenever it passes over existing clip content.
    const rect = e.currentTarget.getBoundingClientRect();
    // Chromium may report (0, 0) as an unavailable-coordinate sentinel for
    // dragleave. Treating it as a real point wedges the first lane's ghost,
    // because that lane commonly begins at the viewport origin.
    const hasPointerCoordinates = e.clientX !== 0 || e.clientY !== 0;
    const pointerStillInside =
      hasPointerCoordinates &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (
      pointerStillInside ||
      (e.relatedTarget instanceof Node &&
        e.currentTarget.contains(e.relatedTarget))
    ) {
      return;
    }
    releaseDropTarget(track.id);
    setDropPreview(null);
  }, [releaseDropTarget, track.id]);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = parseMediaDrag(e);
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = payload
        ? planMediaDrop({
            compositionId,
            track,
            media: payload,
            pointerXPx: e.clientX - rect.left,
            pxPerSec,
            fpsNum,
            fpsDen,
            snap: { ...mediaDropSnap, currentTimeUs: playheadClockUs(compositionId) },
          })
        : null;
      setDropPreview(null);
      if (!payload) return;
      e.preventDefault();
      endMediaDrag();
      // `=== "valid"`, deliberately not `!placementRefuses(...)`: a lane drop
      // always names a real track, so `"spawn"` cannot arise here, and if one
      // ever did it would mean a caller routed a strip plan onto a lane — refuse
      // rather than commit it to the wrong row. The strip has its own handler.
      if (plan?.validity !== "valid") return;
      onMediaDrop(track, payload, plan);
    },
    [
      compositionId,
      endMediaDrag,
      fpsDen,
      fpsNum,
      mediaDropSnap,
      onMediaDrop,
      pxPerSec,
      track,
    ],
  );

  // Highlight the lane the user is currently dragging an existing layer over.
  const isCrossTrackTarget =
    dragState?.kind === "move" &&
    dragState.overTrackId === track.id &&
    dragState.trackId !== track.id;
  const existingDragTargetValidity =
    dragState?.kind === "move" &&
    (dragState.overTrackId ?? dragState.trackId) === track.id
      ? dragState.validity
      : null;
  const existingDragTargetClass =
    existingDragTargetValidity === "collision"
      ? "bg-red-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-red-400/80"
      : existingDragTargetValidity === "locked"
        ? "bg-amber-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-amber-400/80"
        : "";

  const dropTargetClass =
    visibleDropPreview !== null && mediaDropInvalid(visibleDropPreview.plan.validity)
      ? "bg-red-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-red-400/80"
      : visibleDropPreview?.plan.validity === "locked"
        ? "bg-amber-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-amber-400/80"
        : visibleDropPreview !== null
          ? "bg-blue-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-blue-300/80"
          : "";

  const ghostSlot = visibleDropPreview
    ? mediaDropGhostSlot(height, visibleDropPreview.plan)
    : { top: 4, height: Math.max(8, height - 8) };

  // Stable identity so a re-render doesn't churn the registry through
  // null; React only re-invokes it when the lane actually remounts.
  const laneRef = useCallback(
    (el: HTMLDivElement | null) => registerLaneEl(track.id, el),
    [registerLaneEl, track.id],
  );

  // A box started on lane background sweeps CLIPS. Chips and the height
  // splitter stop their own pointerdown, so only the background reaches here —
  // and a locked chip, which does not stop it and is background as far as
  // selection is concerned.
  const { onPointerDown: onMarqueeDown } = useMarqueeAnchor({ kind: "clip" });

  return (
    <div
      ref={laneRef}
      data-testid="track-lane"
      data-track-id={track.id}
      className={[
        "relative border-b border-border-soft bg-track-lane",
        // Mutually exclusive so emit order never decides which state's
        // chrome wins (drop-target vs revealed); the base bg-track-lane
        // vs branch-bg conflict still resolves by emit order, currently
        // favouring the branches.
        visibleDropPreview !== null
          ? dropTargetClass
          : existingDragTargetClass !== ""
            ? existingDragTargetClass
            : isCrossTrackTarget
              ? "bg-secondary outline outline-1 outline-dashed -outline-offset-1 outline-primary"
              : isRevealed
                ? "outline outline-1 outline-dashed -outline-offset-1 outline-blue-400/55 bg-blue-400/5"
                : "",
      ].join(" ")}
      style={{ height }}
      onPointerDown={onMarqueeDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {visibleDropPreview !== null && (
        <div
          data-testid="media-drop-ghost"
          data-validity={visibleDropPreview.plan.validity}
          data-start-us={visibleDropPreview.plan.tStartUs}
          data-end-us={visibleDropPreview.plan.tEndUs}
          className={`media-drop-ghost pointer-events-none absolute z-[5] flex min-w-1 items-center gap-1 overflow-hidden rounded border px-2 text-[10px] font-semibold text-white shadow-[0_3px_10px_rgba(0,0,0,0.4)] ${
            mediaDropInvalid(visibleDropPreview.plan.validity)
              ? "border-red-300 bg-red-500/55"
              : visibleDropPreview.plan.validity === "locked"
                ? "border-amber-300 bg-amber-500/55"
                : "border-blue-200 bg-blue-500/45"
          }`}
          style={{
            left: (visibleDropPreview.plan.tStartUs / 1_000_000) * pxPerSec,
            top: ghostSlot.top,
            width: Math.max(
              4,
              ((visibleDropPreview.plan.tEndUs - visibleDropPreview.plan.tStartUs) /
                1_000_000) *
                pxPerSec,
            ),
            height: ghostSlot.height,
            "--media-drop-ghost-origin-x": `${Math.min(
              MEDIA_DRAG_CURSOR_OFFSET_PX,
              Math.max(
                2,
                (((visibleDropPreview.plan.tEndUs -
                  visibleDropPreview.plan.tStartUs) /
                  1_000_000) *
                  pxPerSec) /
                  2,
              ),
            )}px`,
          } as React.CSSProperties}
          title={`${visibleDropPreview.media.label}: ${formatTimecode(visibleDropPreview.plan.tStartUs, fpsNum, fpsDen)} → ${formatTimecode(visibleDropPreview.plan.tEndUs, fpsNum, fpsDen)}`}
        >
          <span className="min-w-0 truncate">{visibleDropPreview.media.label}</span>
          <span className="shrink-0 opacity-80">
            {formatTimecode(visibleDropPreview.media.durationUs, fpsNum, fpsDen)}
          </span>
          {visibleDropPreview.plan.validity !== "valid" && (
            <span className="ml-auto shrink-0 rounded bg-black/35 px-1 py-0.5">
              {visibleDropPreview.plan.validity === "cycle"
                ? t("timeline.drop_cycle")
                : visibleDropPreview.plan.validity === "locked"
                  ? t("timeline.drop_locked", { defaultValue: "Locked" })
                  : t("timeline.drop_collision", { defaultValue: "Overlap" })}
            </span>
          )}
        </div>
      )}
      {/* Eye-off feedback: dim + freeze the whole layer area. When the
          track is enabled the wrapper is `display: contents` (no box, no
          layout impact); when disabled it's an unpositioned plain div, so
          the absolutely-positioned LayerBlocks still resolve against the
          lane's `relative` box — geometry identical in both states. */}
      <div className={track.enabled ? "contents" : "pointer-events-none opacity-40"}>
      {(() => {
        // Compute per-layer slice once per track render (see `LayerSlice`).
        const sliceLayers = [
          ...renderedLayers,
          ...duplicatePreviews.map((preview) => preview.sliceLayer),
        ];
        const slices = computeLayerSlices(sliceLayers);
        const blocks = renderedLayers.map((layer) => (
          <LayerBlock
            key={layer.id}
            layer={layer}
            trackId={track.id}
            trackKind={track.kind}
            trackLocked={track.locked}
            isTrackExpanded={isExpanded}
            pxPerSec={pxPerSec}
            laneHeight={height}
            slice={slices.get(layer.id) ?? "full"}
            isPrimary={selectedLayerId === layer.id}
            isSelected={selectedLayerIds.has(layer.id)}
            linkId={linkByLayerId.get(layer.id) ?? null}
            linkTab={linkTabByLayerId.get(layer.id) ?? null}
            pendingPlacement={
              pendingPlacements?.find((placement) => placement.layerId === layer.id) ?? null
            }
            bladeMode={bladeMode}
            onBladeSplit={onBladeSplit}
            onBladePreview={onBladePreview}
            onSelectFromClick={onSelectFromClick}
            onDragStart={onDragStart}
            onContextMenu={onContextMenu}
            onCommitLabel={onCommitLabel}
            onCommitLinkLabel={onCommitLinkLabel}
            onCommitGroupLabel={onCommitGroupLabel}
            onCommitParamTrack={onCommitParamTrack}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
        ));
        for (const preview of dragState ? duplicatePreviews : []) {
          blocks.push(
            <LayerBlock
              key={preview.sliceLayer.id}
              layer={preview.layer}
              trackId={track.id}
              trackKind={track.kind}
              trackLocked={track.locked}
              isTrackExpanded={isExpanded}
              pxPerSec={pxPerSec}
              laneHeight={height}
              slice={slices.get(preview.sliceLayer.id) ?? "full"}
              isPrimary={false}
              isSelected={false}
              linkId={null}
              linkTab={null}
              pendingPlacement={null}
              previewOnly
              bladeMode={bladeMode}
              onBladeSplit={onBladeSplit}
              onBladePreview={onBladePreview}
              onSelectFromClick={onSelectFromClick}
              onDragStart={onDragStart}
              onContextMenu={onContextMenu}
              onCommitLabel={onCommitLabel}
              onCommitLinkLabel={onCommitLinkLabel}
              onCommitGroupLabel={onCommitGroupLabel}
              onCommitParamTrack={onCommitParamTrack}
              fpsNum={fpsNum}
              fpsDen={fpsDen}
            />,
          );
        }
        // Transition chips render AFTER the blocks so they sit above the
        // participating layers' heads in DOM order (same z tier as a
        // selected block). Slotted to the incoming layer's slice so they
        // hug its block in combined V+A rows.
        for (const chip of transitionChips) {
          blocks.push(
            <TransitionChip
              key={chip.transition.id}
              chip={chip}
              pxPerSec={pxPerSec}
              laneHeight={height}
              slice={slices.get(chip.toLayer.id) ?? "full"}
              isSelected={selectedTransitionId === chip.transition.id}
              bladeMode={bladeMode}
              fpsNum={fpsNum}
              fpsDen={fpsDen}
              onContextMenu={(e) => onChipContextMenu(e, chip)}
              onResize={onChipResize}
            />,
          );
        }
        return blocks;
      })()}
      </div>
      <div
        className={`absolute inset-x-0 -bottom-[3px] z-[3] h-1.5 cursor-ns-resize transition-colors duration-75 hover:bg-blue-400/35 ${isResizing ? "bg-blue-400/35" : "bg-transparent"}`}
        title={t("timeline.resize_track_hint", {
          defaultValue: "Drag to resize this track",
        })}
        onPointerDown={onHeightDragStart}
      />
    </div>
  );
}

/// The ghost occupies the band the dropped layer's chip will get. Translating
/// the drop plan's overlap vocabulary into a `LayerSlice` is the only part of
/// this that was ever local.
function mediaDropGhostSlot(height: number, plan: MediaDropPlan) {
  const slice: LayerSlice = !plan.sharesLane
    ? "full"
    : plan.overlapClass === "visual"
      ? "top"
      : "bottom";
  return layerSliceRect(height, slice);
}
