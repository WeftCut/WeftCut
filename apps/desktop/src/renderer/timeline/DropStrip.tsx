import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { formatTimecode } from "../frames";
import type { LayerParamsView, LayerSummary } from "../ipc";
import {
  DragGhostChip,
  dragGhostBand,
  GHOST_HEAD_CAP_PX,
} from "./DragGhostChip";
import { DROP_STRIP_HEIGHT_PX } from "./geometry";
import type { PendingLayerPlacement } from "./LayerBlock";
import { placementRefuses, SPAWN_TRACK_ID } from "./placement";
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
import {
  moveLandings,
  useForeignDropStripAnchorUs,
  useForeignDropStripValidity,
  useIsForeignDropClaimed,
  useIsLayerMoveDragging,
  useLayerDragForStrip,
} from "./layerDragStore";

/// One ghost the strip draws for a clip whose destination is the lane this row
/// spawns. Minted from the LIVE gesture while the pointer is here, and from the
/// PENDING promise for the round trip after release — the strip is the only
/// surface either can be drawn on, a spawned lane having no id to key a lane
/// preview by until the command returns.
///
/// A clip carried in from ANOTHER Panel is not in this list: it draws its own
/// ghost over this row (`ForeignDragGhost.tsx`), and draws the same one, both
/// going through `DragGhostChip` on the band `dragGhostBand` gives this row.
interface StripClipGhost {
  layerId: string;
  /// The clip's display name, or null for a promise — resolved where the layer
  /// lives, and only the live gesture carries it (`DragSubject.name`).
  name: string | null;
  kind: LayerParamsView["kind"];
  tStartUs: number;
  tEndUs: number;
}

/// The idle dashed rule between the drop strip and the topmost lane.
///
/// A zero-height overlay *after* the 14 px hit row, not a child of it: a
/// hairline that overflowed the strip would paint *under* the first lane's
/// fill (`bg-track-lane` is opaque). `z-[1]` lets this 1 px sit on top of
/// that fill without raising the strip itself (a strip stacking context
/// would cover first-lane link tabs that overflow upward). `intoLanePx`
/// is the offset into the following row; 0 is the strip/lane boundary.
export function DropStripSeam({ intoLanePx }: { intoLanePx: number }) {
  return (
    <div
      className="pointer-events-none relative z-[1] h-0"
      aria-hidden="true"
    >
      <div
        data-testid="timeline-drop-strip-seam"
        className="absolute inset-x-0 h-px"
        style={{
          top: intoLanePx,
          // `border-dashed` on a 1 px hairline (0.9 px at 110% OS scale)
          // paints as sparse dots, so the 14 px empty strip leaks through
          // and the gutter under the "line" reads as 14+4. Paint the dashes
          // as a fill so they actually occlude that void.
          backgroundImage:
            "repeating-linear-gradient(to right, var(--border-soft) 0 3px, transparent 3px 7px)",
        }}
      />
    </div>
  );
}

/// Header-column half of the drop-strip row. Same height as the body, or every
/// header beneath it loses its lane. The plus is a landmark in the cell, not a
/// control: ADR 0042 has no click-to-spawn-empty-track, and a button here would
/// teach the mental model the strip exists to remove. It sits at the bottom of
/// the hit row (`items-end`) so leftover pixels fall above the plus, not as a
/// gutter between the strip and the first track. The dashed rule itself is the
/// overlay `DropStripSeam` Timeline mounts after this cell.
export function DropStripHeader() {
  return (
    <div
      data-testid="timeline-drop-strip-header"
      className="relative flex items-end justify-center bg-card pb-px"
      style={{ height: DROP_STRIP_HEIGHT_PX }}
      aria-hidden="true"
    >
      <span
        data-testid="timeline-drop-strip-add"
        className="relative z-[1] text-muted-foreground/40"
      >
        <Plus size={10} strokeWidth={2.25} aria-hidden />
      </span>
    </div>
  );
}

/// The permanently reserved row above the topmost lane: releasing a drag here
/// spawns a lane at the top of the z-stack and places the clip on it (ADR 0042).
///
/// Idle it is a plus in the header half and a dashed rule that Timeline paints
/// as `DropStripSeam` after this row — a seam, not a lane. No fill, nothing
/// that reads as an empty track the editor is supposed to manage, because that
/// mental model is what tracks-as-a-by-product removes. It lights up only while
/// a drag is in flight, and it claims the highlight through the SAME drop-target
/// protocol the lanes use, under `SPAWN_TRACK_ID`, so ownership transfers
/// between the strip and a lane without a second mechanism deciding who is lit.
///
/// A drop here is never a collision WITH THE DESTINATION: the lane it lands on
/// does not exist yet, so `planMediaDrop` with no track answers `"spawn"` (see
/// `placement.ts`). It CAN still be refused — a composition that would contain
/// itself, a locked clip, or a subject set that would overlap ITSELF on the one
/// new lane — so the strip carries the same red and amber chrome and the same
/// release guard a lane does.
///
/// It is also where a raise's own preview is DRAWN. Every other destination is a
/// lane and can host the chip itself; this one has no lane to host it until the
/// commit returns, so the bars live in this row — during the gesture from the
/// live drag, and afterwards from the promise `useLayerDrag` writes on
/// `SPAWN_TRACK_ID`, which is what keeps the clip from flashing back to where it
/// started for the length of the round trip.
///
/// Two genuinely different event models reach this one row. The media-pool drag
/// is HTML5 drag-and-drop and lands in the handlers below; the existing-clip drag
/// is pointer-driven and terminates in the timeline's own drag-commit path. Each
/// publishes to a store this component subscribes to — `mediaDrag.ts` and
/// `layerDragStore.ts` — and both then feed the SINGLE armed/lit pair at the
/// bottom, because the failure mode here is one mechanism lighting the strip
/// while the other silently does nothing.
///
/// A clip dragged in from ANOTHER Panel is the second gesture the clip drag
/// arrives as, and it is read from the CLAIM rather than from the drag: the
/// gesture belongs to a composition this Panel must not arm for, and the claim
/// is the destination's own statement that a release here would land
/// (`ForeignDragGhost.tsx` resolves it, and commits it).
export function DropStrip({
  elRef,
  pxPerSec,
  fpsNum,
  fpsDen,
  mediaDropSnap,
  compositionId,
  pendingPlacements,
  pendingLayerById,
  onMediaDrop,
}: {
  /// The row's element, which the layer drag's hit-test measures. A ref rather
  /// than a registry entry: the strip is not a track (see `useLayerDrag`).
  elRef: React.RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  mediaDropSnap: Omit<MediaDropSnapOptions, "currentTimeUs">;
  /// The composition this strip spawns into — this Panel's own, whichever tab
  /// holds the keyboard, so a drop here is a local act on a background timeline
  /// too. It routes the drop, offers the playhead as a snap boundary on this
  /// Panel's own axis (`state/playheadProjection.ts`), and answers the cycle
  /// gate for a Group released here.
  compositionId: string | null;
  /// The in-flight move promises, as `TrackLane` receives them. Only the ones on
  /// `SPAWN_TRACK_ID` concern this row, and they are the raise's bridge: they
  /// keep the clip drawn here for the round trip in which the lane it is going
  /// to does not exist yet (`useLayerDrag`'s spawn commit).
  pendingPlacements: PendingLayerPlacement[] | null;
  pendingLayerById: ReadonlyMap<string, LayerSummary>;
  /// Commits the drop. A null track means "spawn one" — the Timeline owns the
  /// two-step commit because it also owns the readiness guards every media drop
  /// shares.
  onMediaDrop: (
    track: null,
    payload: MediaDragPayload,
    plan: MediaDropPlan,
  ) => void;
}) {
  const { t } = useTranslation();
  const layerMoveArmed = useIsLayerMoveDragging(compositionId);
  // Non-null exactly while a clip drag started in this Panel names this strip.
  // The whole gesture, because the row DRAWS this drop: a raise's preview
  // belongs to the strip and to no lane (`previewTrackId`).
  const stripDrag = useLayerDragForStrip(compositionId);
  const foreignDropArmed = useIsForeignDropClaimed(compositionId);
  const foreignStripAnchorUs = useForeignDropStripAnchorUs(compositionId);
  const foreignStripValidity = useForeignDropStripValidity(compositionId);
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
    if (activeMediaDrag === null || dropTargetTrackId !== SPAWN_TRACK_ID) {
      setDropPreview(null);
    }
  }, [activeMediaDrag, dropTargetTrackId]);

  const visibleDropPreview =
    dropTargetTrackId === SPAWN_TRACK_ID ? dropPreview : null;

  // The raise's landing, through the SAME call the move projection makes — the
  // strip promises what the commit sends, or it is not a preview of it. Every
  // subject, because a raise takes the whole set onto the one new lane.
  const stripLanding = useMemo(
    () =>
      stripDrag === null
        ? null
        : moveLandings(stripDrag, stripDrag.deltaUs, {
            num: fpsNum,
            den: fpsDen,
          }),
    [fpsDen, fpsNum, stripDrag],
  );

  const clipGhosts = useMemo((): StripClipGhost[] => {
    if (stripDrag !== null && stripLanding !== null) {
      return stripDrag.subjects.map((subject) => {
        const landed = stripLanding.byLayerId.get(subject.layerId);
        return {
          layerId: subject.layerId,
          name: subject.name,
          kind: subject.kind,
          // The floor is already in the landing (`floorShiftAtZero`), so the
          // set's phase survives the zero boundary intact and no bar needs a
          // clamp of its own.
          tStartUs: landed?.tStartUs ?? subject.originalTStart,
          tEndUs: landed?.tEndUs ?? subject.originalTEnd,
        };
      });
    }
    // Released, and the lane still has no id: the promise is the only place the
    // clip exists on screen until the refreshed project brings the lane.
    const ghosts: StripClipGhost[] = [];
    for (const placement of pendingPlacements ?? []) {
      if (placement.trackId !== SPAWN_TRACK_ID) continue;
      const layer = pendingLayerById.get(placement.layerId);
      if (!layer) continue;
      ghosts.push({
        layerId: placement.layerId,
        name: null,
        kind: layer.params.kind,
        tStartUs: placement.tStartUs,
        tEndUs: placement.tEndUs,
      });
    }
    return ghosts;
  }, [pendingLayerById, pendingPlacements, stripDrag, stripLanding]);

  const planFor = useCallback(
    (media: MediaDragPayload, pointerXPx: number) =>
      planMediaDrop({
        compositionId,
        track: null,
        media,
        pointerXPx,
        pxPerSec,
        fpsNum,
        fpsDen,
        snap: { ...mediaDropSnap, currentTimeUs: playheadClockUs(compositionId) },
      }),
    [compositionId, fpsDen, fpsNum, mediaDropSnap, pxPerSec],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
      e.preventDefault();
      if (activeMediaDrag === null) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = planFor(activeMediaDrag, e.clientX - rect.left);
      e.dataTransfer.dropEffect = mediaDropInvalid(plan.validity) ? "none" : "copy";
      // Collapse the floating media card into a chip inside the strip, the same
      // way a lane absorbs it. Not cosmetic here: at full size the card covers
      // the whole row, so without this the highlight and the hint that say what
      // release will do are both hidden underneath it.
      const ghostLeft = rect.left + (plan.tStartUs / 1_000_000) * pxPerSec;
      const ghostWidth = Math.max(
        4,
        ((plan.tEndUs - plan.tStartUs) / 1_000_000) * pxPerSec,
      );
      const width = Math.min(36, Math.max(14, ghostWidth));
      const height = Math.max(8, DROP_STRIP_HEIGHT_PX - 4);
      claimDropTarget(SPAWN_TRACK_ID, {
        left:
          ghostLeft +
          Math.min(MEDIA_DRAG_CURSOR_OFFSET_PX, ghostWidth / 2) -
          width / 2,
        top: rect.top + (DROP_STRIP_HEIGHT_PX - height) / 2,
        width,
        height,
      });
      setDropPreview({ media: activeMediaDrag, plan });
    },
    [activeMediaDrag, claimDropTarget, planFor, pxPerSec],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // Chromium reports (0, 0) as an unavailable-coordinate sentinel for some
      // dragleave events; the strip commonly begins at the viewport origin, so
      // treating that as a real point outside the row would wedge its highlight.
      const rect = e.currentTarget.getBoundingClientRect();
      const hasPointerCoordinates = e.clientX !== 0 || e.clientY !== 0;
      const pointerStillInside =
        hasPointerCoordinates &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (pointerStillInside) return;
      releaseDropTarget(SPAWN_TRACK_ID);
      setDropPreview(null);
    },
    [releaseDropTarget],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = parseMediaDrag(e);
      setDropPreview(null);
      if (!payload) return;
      e.preventDefault();
      endMediaDrag();
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = planFor(payload, e.clientX - rect.left);
      if (mediaDropInvalid(plan.validity)) return;
      onMediaDrop(null, payload, plan);
    },
    [endMediaDrag, onMediaDrop, planFor],
  );

  // A clip drag names this strip from either side of the gesture: this Panel's
  // own, or a neighbour's whose claim landed here. Both are this composition's
  // µs — the local one by its composition gate, the foreign one because the
  // claim was resolved on this Panel's axis in the first place.
  const clipDragAnchorUs = stripLanding?.anchorTStartUs ?? foreignStripAnchorUs;
  // And its verdict, from whichever side. One value, so the row cannot light
  // blue and promise a track under a ghost that is already red — which is what
  // it did for a refused drop carried in from next door, the claim's validity
  // having never reached the chrome.
  const clipValidity = stripDrag?.validity ?? foreignStripValidity;
  // One armed/lit pair, fed by every event model. Any drag arms the row;
  // whichever one currently owns the strip lights it. A promise draws its bars
  // without lighting anything: the gesture is over, and "release to create a
  // track" is no longer what the row is saying.
  const armed = activeMediaDrag !== null || layerMoveArmed || foreignDropArmed;
  const lit = visibleDropPreview !== null || clipDragAnchorUs !== null;
  // Each event model's own predicate, so neither decides for the other:
  // `"spawn"` is committable and `"locked"` has its own amber, which is why
  // neither asks `!== "valid"`.
  const mediaRefused =
    visibleDropPreview !== null &&
    mediaDropInvalid(visibleDropPreview.plan.validity);
  const clipRefused = clipValidity !== null && placementRefuses(clipValidity);
  const refused = mediaRefused || clipRefused;
  const lockRefused = clipValidity === "locked";
  // WHICH refusal, not merely whether: a fresh lane refuses for three different
  // reasons — a composition that would contain itself (media), a subject set
  // that would overlap itself on the one new lane, and a locked subject — and
  // "Overlap" on an empty lane reads as a bug. Amber for a lock, red for the
  // rest, the vocabulary every lane and the ghost in this row already use.
  const refusalLabel = mediaRefused
    ? t("timeline.drop_cycle")
    : clipValidity === "collision"
      ? t("timeline.drop_collision", { defaultValue: "Overlap" })
      : lockRefused
        ? t("timeline.drop_locked", { defaultValue: "Locked" })
        : null;
  const ghostLeftPx =
    visibleDropPreview !== null
      ? (visibleDropPreview.plan.tStartUs / 1_000_000) * pxPerSec
      : 0;
  // Anchored to the gesture's head rather than to the row, so the hint lands
  // beside the pointer at any scroll offset. For a media drag that is the ghost's
  // head, offset far enough to clear the absorbed media chip (which reaches at
  // most MEDIA_DRAG_CURSOR_OFFSET_PX + 18 px past it).
  //
  // For a clip drag it begins where the ghost's HEAD CAP ends — the label sits on
  // the bar (there is no room beside it in a strip this thin) but never on the one edge
  // the gesture is about. Not a nudge for looks: the hint is opaque and a tier
  // above every ghost, so at offset 0 it covered the landing marker completely.
  // The bar's TAIL would clear it too and is the wrong answer — at frame-level
  // zoom the tail is off screen while the hand holding the clip is not.
  const hintLeftPx =
    visibleDropPreview !== null
      ? ghostLeftPx + MEDIA_DRAG_CURSOR_OFFSET_PX + 24
      : ((clipDragAnchorUs ?? 0) / 1_000_000) * pxPerSec + GHOST_HEAD_CAP_PX;
  // Row-local, because the ghosts are children of the row. The SAME rule the
  // cross-Panel ghost applies to this row from outside it, which is what makes
  // the two boxes coincide instead of merely resembling each other.
  const stripGhostBand = dragGhostBand(DROP_STRIP_HEIGHT_PX, SPAWN_TRACK_ID);
  // The strip is a clip surface for selection too: a sweep may start on the
  // reserved row and reach down into the lanes.
  const { onPointerDown: onMarqueeDown } = useMarqueeAnchor({ kind: "clip" });
  return (
    <div
      ref={elRef}
      data-testid="timeline-drop-strip"
      data-armed={armed ? "true" : "false"}
      data-lit={lit ? "true" : "false"}
      className={`relative ${
        lockRefused
          ? "bg-amber-500/25 outline outline-1 outline-dashed -outline-offset-1 outline-amber-400/80"
          : refused
            ? "bg-red-500/25 outline outline-1 outline-dashed -outline-offset-1 outline-red-400/80"
            : lit
              ? "bg-blue-500/25 outline outline-1 outline-dashed -outline-offset-1 outline-blue-300/80"
              : armed
                ? "bg-blue-400/10"
                : ""
      }`}
      style={{ height: DROP_STRIP_HEIGHT_PX }}
      onPointerDown={onMarqueeDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {visibleDropPreview !== null && (
        <div
          data-testid="timeline-drop-strip-ghost"
          data-validity={visibleDropPreview.plan.validity}
          data-start-us={visibleDropPreview.plan.tStartUs}
          data-end-us={visibleDropPreview.plan.tEndUs}
          className={`pointer-events-none absolute inset-y-0 z-[5] rounded-sm border ${
            refused ? "border-red-300 bg-red-500/55" : "border-blue-200 bg-blue-500/45"
          }`}
          style={{
            left: ghostLeftPx,
            width: Math.max(
              4,
              ((visibleDropPreview.plan.tEndUs -
                visibleDropPreview.plan.tStartUs) /
                1_000_000) *
                pxPerSec,
            ),
          }}
          title={`${visibleDropPreview.media.label}: ${formatTimecode(visibleDropPreview.plan.tStartUs, fpsNum, fpsDen)} → ${formatTimecode(visibleDropPreview.plan.tEndUs, fpsNum, fpsDen)}`}
        />
      )}
      {/* The raise's own preview: one bar per subject, at the landing the commit
          will send. It lives HERE and on no lane — the source lane releases the
          clip because the clip is leaving it (`previewTrackId`) — and it outlives
          the gesture, the promise on `SPAWN_TRACK_ID` keeping it drawn through
          the round trip in which the destination lane has no id yet. */}
      {clipGhosts.map((ghost) => (
        <DragGhostChip
          key={ghost.layerId}
          testId="timeline-drop-strip-clip-ghost"
          layerId={ghost.layerId}
          trackId={SPAWN_TRACK_ID}
          name={ghost.name}
          kind={ghost.kind}
          tStartUs={ghost.tStartUs}
          tEndUs={ghost.tEndUs}
          // A promise has outlived the gesture that carried a verdict, and only a
          // committable one is ever written — `"spawn"` is what it committed on.
          validity={clipValidity ?? "spawn"}
          pxPerSec={pxPerSec}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          {...stripGhostBand}
        />
      ))}
      {/* Says what release will do, for whichever gesture is over the row.
          Absolute because the strip's height must never depend on the text. */}
      {lit && (
        <div
          data-testid="timeline-drop-strip-hint"
          className={`pointer-events-none absolute inset-y-0 z-[6] whitespace-nowrap rounded-sm px-1.5 text-[9px] font-semibold ${
            refused ? "bg-red-950/85 text-red-50" : "bg-blue-950/85 text-blue-50"
          }`}
          style={{ left: hintLeftPx, lineHeight: `${DROP_STRIP_HEIGHT_PX}px` }}
        >
          {refusalLabel ??
            t("timeline.drop_spawn_hint", {
              defaultValue: "Release to create a track",
            })}
        </div>
      )}
    </div>
  );
}
