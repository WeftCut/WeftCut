import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  moveLayer,
  moveLayersToNewTrack,
  pasteLayers,
  trimLayer,
  type LinkSummary,
  type LayerParamsView,
  type LayerSummary,
  type TrackSummary,
} from "../../ipc";
import { linkFanoutActive } from "../linkEligibility";
import i18n from "../../i18n";
import { layerDisplayName } from "../../lib/layerName";
import { currentGroupOrdinals } from "../../state/projectStore";
import { adjacentFrameBoundaryUs, snapFrameRound } from "../../frames";
import { logMutationFailure } from "../../errors/tryMutate";
import {
  layerOverlapClass,
  trackIdAtClientY,
  type MeasuredTrackRow,
  type VisualTrack,
} from "../geometry";
import { type PendingLayerPlacement } from "../LayerBlock";
import {
  useLayerDragStore,
  useLayerMoveDragSubjects,
  type DragSeed,
  type DragState,
  type DragSubject,
} from "../layerDragStore";
import { snapDragDeltaToTimelineBoundary } from "../snapping";
import { refuseCrossCompositionMove } from "../crossCompositionRefusal";
import { foreignCompositionAtPoint } from "../timelineSurfaces";
import { playheadClockUs } from "../../state/playheadProjection";
import {
  evaluateTimelinePlacements,
  SPAWN_TRACK_ID,
  type PlacementValidity,
  type TimelinePlacement,
} from "../placement";

/// Tracks are kind-agnostic: any layer can land on any track. This
/// reject hook always accepts; routing is by LayerParams, not track
/// kind. See docs/data-model.md (kind-agnostic tracks) / ADR 0023.
///
/// Takes the destination's ID rather than its summary because one destination
/// has no summary: the drop strip names a lane that does not exist yet.
function trackAcceptsForLayer(_targetTrackId: string, _drag: DragState): boolean {
  return true;
}

interface LayerMoveProjection {
  placements: PendingLayerPlacement[];
  destinationTrackId: string;
  anchorStartUs: number;
  validity: PlacementValidity;
  conflictingLayerIds: string[];
}

const UNSELECTED_CLIP_DRAG_ARM_MS = 100;

interface LayerDragGesture {
  state: DragState;
  phase: "pending" | "dragging";
  armAtMs: number;
  lastClientX: number;
  lastClientY: number;
}

/// Where the dragged edge / clip-start actually lands, after the constraints the
/// kind imposes: a move never starts before zero, and a trim never crosses its
/// own opposite edge (one frame of clip always survives).
export function constrainedAnchorUs(
  state: DragState,
  deltaUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  switch (state.kind) {
    case "move":
      return Math.max(0, state.originalTStart + deltaUs);
    case "trim-start":
      return Math.max(
        0,
        Math.min(
          state.originalTStart + deltaUs,
          adjacentFrameBoundaryUs(state.originalTEnd, -1, fpsNum, fpsDen),
        ),
      );
    case "trim-end":
      return Math.max(
        adjacentFrameBoundaryUs(state.originalTStart, 1, fpsNum, fpsDen),
        state.originalTEnd + deltaUs,
      );
  }
}

interface PointerDragEvaluation {
  state: DragState;
  hasEditIntent: boolean;
  hasCommitChange: boolean;
  moveProjection: LayerMoveProjection | null;
  /// The composition of the timeline Panel under the pointer when that Panel is
  /// not this one, else null. Every destination is withheld while it is set and
  /// the release commits nothing.
  foreignCompositionId: string | null;
}

/// Layer drag state machine (move / trim-start / trim-end): ghost
/// tracking via window pointermove, frame + timeline-boundary snapping,
/// and the commit-on-pointerup switch that lowers to
/// `moveLayer`/`moveLayersToNewTrack`/`pasteLayers`/`trimLayer`.
export function useLayerDrag(opts: {
  /// The composition being dragged in — the Panel's own, which is the axis
  /// every time in this gesture is expressed on.
  compositionId: string | null;
  tracks: TrackSummary[];
  links: LinkSummary[];
  linkByLayerId: Map<string, string>;
  orderedTracks: VisualTrack[];
  /// Live track-id → lane-element registry, owned by the Timeline. Measured
  /// per pointer event; see `destinationUnderPointer`.
  laneEls: React.RefObject<Map<string, HTMLElement>>;
  /// The drop strip's row. Deliberately NOT an entry in `laneEls`: that registry
  /// maps TRACK ids to lanes and the hit-test walks `orderedTracks` to find them,
  /// so a row that is not a track could never be reached through it. Handed over
  /// separately and folded into the same measured rows instead — one band rule
  /// still decides every destination.
  dropStripEl: React.RefObject<HTMLElement | null>;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  tailSnapEnabled: boolean;
  tailSnapStrengthPx: number;
  /// A raise minted a lane. The Timeline reveals it: a spawned lane carries no
  /// role, so the A/B Roll filter would hide the clip the user just raised.
  onLaneSpawned: (trackId: string) => void;
  onMutated: () => Promise<void>;
}): {
  setDrag: (s: DragSeed | null) => void;
  pendingPlacements: PendingLayerPlacement[] | null;
  pendingLayerById: ReadonlyMap<string, LayerSummary>;
  dragLayerById: ReadonlyMap<string, LayerSummary>;
} {
  const {
    compositionId,
    tracks,
    links,
    linkByLayerId,
    orderedTracks,
    laneEls,
    dropStripEl,
    pxPerSec,
    fpsNum,
    fpsDen,
    tailSnapEnabled,
    tailSnapStrengthPx,
    onLaneSpawned,
    onMutated,
  } = opts;
  // The whole gesture, armed or not. A ref, not state: a pending gesture must
  // draw NOTHING until the temporal arm and a real frame/track change have both
  // happened, and a value that cannot cause a render makes that structural
  // rather than a condition every reader has to remember. Once it arms, the
  // armed half — and only that half — is published to `layerDragStore`.
  const gestureRef = useRef<LayerDragGesture | null>(null);
  // Mounts the window listeners below, and nothing else. Flipped exactly twice
  // per gesture, at pointerdown and at release, so it is not an event-rate
  // write: the pointer handlers read the ref rather than closing over state.
  const [gestureActive, setGestureActive] = useState(false);
  // Local, not in the store: a placement is written once on commit and cleared
  // once the refreshed project shows the layer where it was promised, never at
  // event rate — so the rule the store exists to enforce does not reach it.
  const [pendingPlacements, setPendingPlacements] =
    useState<PendingLayerPlacement[] | null>(null);

  const layerEntryById = useMemo(() => {
    const layerById = new Map<
      string,
      { layer: LayerSummary; trackId: string; trackLocked: boolean }
    >();
    for (const track of tracks) {
      for (const layer of track.layers) {
        layerById.set(layer.id, {
          layer,
          trackId: track.id,
          trackLocked: track.locked,
        });
      }
    }
    return layerById;
  }, [tracks]);

  const pendingLayerById = useMemo(() => {
    const layersById = new Map<string, LayerSummary>();
    for (const placement of pendingPlacements ?? []) {
      const entry = layerEntryById.get(
        placement.sourceLayerId ?? placement.layerId,
      );
      if (entry) layersById.set(placement.layerId, entry.layer);
    }
    return layersById;
  }, [layerEntryById, pendingPlacements]);

  // LANDMINE: memoized on the SUBJECTS reference, never on the whole gesture.
  // `subjects` is minted once in `setDrag` and every `{ ...state, … }` spread
  // downstream preserves its identity, so this map keeps one identity for the
  // length of a drag — which is what stops the lanes that receive it as a prop
  // from re-rendering per pointermove. Widen the dep to the `DragState` and
  // every lane wakes on every event again.
  const dragSubjects = useLayerMoveDragSubjects();
  const dragLayerById = useMemo(() => {
    const layersById = new Map<string, LayerSummary>();
    for (const subject of dragSubjects ?? []) {
      const entry = layerEntryById.get(subject.layerId);
      if (entry) layersById.set(subject.layerId, entry.layer);
    }
    return layersById;
  }, [dragSubjects, layerEntryById]);

  useEffect(() => {
    if (!pendingPlacements) return;
    const allLanded = pendingPlacements.every((placement) => {
      const track = tracks.find((t) => t.id === placement.trackId);
      const layer = track?.layers.find((l) => l.id === placement.layerId);
      if (!layer) return false;
      // A clone has landed the moment it exists: the actor placed it where its
      // own lattice says (`paste_layers` re-snaps every member), so holding the
      // ghost to the projected time could pin it over the real clip for good.
      if (placement.sourceLayerId !== undefined) return true;
      return (
        layer.t_start_us === placement.tStartUs &&
        layer.t_end_us === placement.tEndUs
      );
    });
    if (allLanded) {
      setPendingPlacements(null);
    }
  }, [pendingPlacements, tracks]);

  const visibleSnapTracks = useMemo(
    () => orderedTracks.map(({ track }) => track),
    [orderedTracks],
  );

  const buildDragSubjects = useCallback(
    (seed: DragSeed): DragSubject[] => {
      // A duplicate's subjects are the link too (`docs/features.md#links`):
      // Alt+drag on a linked A/V pair copies both halves, as Premiere does. The
      // escape is the SELECTION, not a key — Alt on the body already means
      // duplicate — so a selection the user had narrowed to some members before
      // this pointerdown (an Alt+click first) narrows the copy to those.
      const linkId = seed.escapeLink
        ? undefined
        : linkByLayerId.get(seed.layerId);
      const link = linkId ? links.find((candidate) => candidate.id === linkId) : null;
      let candidateIds = link?.layer_ids ?? [seed.layerId];
      if (seed.duplicate && link && seed.selectedAtPointerDown.has(seed.layerId)) {
        const narrowed = link.layer_ids.filter((id) =>
          seed.selectedAtPointerDown.has(id),
        );
        if (narrowed.length < link.layer_ids.length) candidateIds = narrowed;
      }
      const targetEdgeUs =
        seed.kind === "trim-start"
          ? seed.originalTStart
          : seed.kind === "trim-end"
            ? seed.originalTEnd
            : null;

      // Named once per gesture, at pointerdown, through the imperative bundle
      // — the same event-time read `search/searchIndexStore.ts` makes. A
      // subject's name is the string its own block shows, resolved where the
      // layer lives, because the Panel that may have to draw it does not hold
      // the layer or the ordinals a Group's name is derived from.
      const ordinals = currentGroupOrdinals();
      const nameOf = (layer: LayerSummary): string =>
        layerDisplayName(layer, (key, values) => i18n.t(key, values), ordinals);

      const subjects: DragSubject[] = [];
      for (const layerId of candidateIds) {
        const entry = layerEntryById.get(layerId);
        if (!entry) continue;
        const layer = entry.layer;
        if (targetEdgeUs !== null) {
          const edgeUs =
            seed.kind === "trim-start" ? layer.t_start_us : layer.t_end_us;
          if (layerId !== seed.layerId && edgeUs !== targetEdgeUs) continue;
        }
        subjects.push({
          layerId,
          trackId: entry.trackId,
          originalTStart: layer.t_start_us,
          originalTEnd: layer.t_end_us,
          kind: layer.params.kind,
          name: nameOf(layer),
          locked: layer.locked || entry.trackLocked,
        });
      }
      if (!subjects.some((subject) => subject.layerId === seed.layerId)) {
        // Reached only when the summary no longer holds the layer the seed
        // names — the case where nothing about the clip can be read. The lane's
        // own dominant class stands in, because it preserves the one
        // distinction a kind is consulted for downstream (Audio vs everything
        // else), and the name ends on the rung `layerDisplayName` ends on.
        const fallbackKind: LayerParamsView["kind"] =
          seed.trackKind === "Audio" ? "Audio" : "VideoClip";
        subjects.unshift({
          layerId: seed.layerId,
          trackId: seed.trackId,
          originalTStart: seed.originalTStart,
          originalTEnd: seed.originalTEnd,
          kind: fallbackKind,
          name: i18n.t(`kinds.${fallbackKind.toLowerCase()}`, {
            defaultValue: fallbackKind,
          }),
          // A locked block refuses `pointerdown`, so a seed that armed a drag
          // was not locked whatever the summary has since lost.
          locked: false,
        });
      }
      return subjects;
    },
    [linkByLayerId, links, layerEntryById],
  );

  const setDrag = useCallback(
    (seed: DragSeed | null) => {
      announcedForeignRef.current = null;
      if (!seed) {
        // Guarded on this Panel's OWN gesture: `end()` clears the one store
        // every Panel shares, so abandoning a gesture this Panel never had
        // would abandon the neighbour's instead.
        if (gestureRef.current === null) return;
        gestureRef.current = null;
        setGestureActive(false);
        useLayerDragStore.getState().end();
        return;
      }
      // The link override reaches this whole gesture through the seed's own
      // escape flag, folded in ONCE: the subject set, the snapping exclusions
      // and every IPC the commit sends already read `escapeLink`, so nothing
      // downstream consults the store a second time.
      if (!linkFanoutActive({ altKey: seed.escapeLink })) {
        seed = { ...seed, escapeLink: true };
      }
      const subjects = buildDragSubjects(seed);
      // Counted against the RENDERED lanes, so the A/B Roll filter decides
      // what is hidden here exactly as it does for the lanes themselves.
      const visibleTrackIds = new Set(
        orderedTracks.map(({ track }) => track.id),
      );
      const state: DragState = {
        ...seed,
        // Stamped here rather than on the seed: this hook is the only party to
        // the gesture that knows which composition's axis it is expressed on,
        // and every subscriber that is not keyed on a project-unique id needs
        // the answer (`layerDragStore.ts`).
        compositionId,
        subjects,
        validity: "valid",
        conflictingLayerIds: [],
        hiddenSubjectCount: subjects.filter(
          (subject) => !visibleTrackIds.has(subject.trackId),
        ).length,
      };
      const armDelayMs =
        seed.kind === "move" && !seed.wasSelectedAtPointerDown
          ? UNSELECTED_CLIP_DRAG_ARM_MS
          : 0;
      gestureRef.current = {
        state,
        phase: "pending",
        armAtMs: Date.now() + armDelayMs,
        lastClientX: seed.startX,
        lastClientY: seed.startY,
      };
      setGestureActive(true);
    },
    [buildDragSubjects, compositionId, orderedTracks],
  );

  // Module state outlives this Panel. A Panel torn down mid-gesture would
  // otherwise leave a drag published with nobody left to end it; the ref guard
  // is what keeps a SECOND Panel's unmount from ending the first one's drag.
  useEffect(
    () => () => {
      if (gestureRef.current === null) return;
      gestureRef.current = null;
      useLayerDragStore.getState().end();
    },
    [],
  );

  // -------- Layer drag (move / trim) --------

  /// Which destination a pointer at `clientY` is over, as a track id —
  /// `SPAWN_TRACK_ID` when that destination is the drop strip, i.e. a lane that
  /// does not exist yet (ADR 0042). Measure the rendered rows, then band-select.
  /// Cost is one forced reflow per pointer event; the remaining rect reads then
  /// hit clean layout.
  const destinationUnderPointer = useCallback(
    (clientY: number): string | null => {
      const rows: MeasuredTrackRow[] = [];
      // Walk `orderedTracks`, not the registry: only rendered lanes are
      // droppable, and the AB display filter hides some tracks entirely.
      for (const { track } of orderedTracks) {
        const el = laneEls.current.get(track.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        rows.push({ trackId: track.id, top: rect.top, bottom: rect.bottom });
      }
      // The strip joins the SAME row list, so the seam between it and the
      // topmost lane is decided by the one band rule that already hands an
      // expanded track's sub-lanes to their owner. A second hit-test would be a
      // second chance to disagree with this one at exactly that boundary.
      const stripEl = dropStripEl.current;
      if (stripEl) {
        const rect = stripEl.getBoundingClientRect();
        rows.push({
          trackId: SPAWN_TRACK_ID,
          top: rect.top,
          bottom: rect.bottom,
        });
      }
      return trackIdAtClientY(rows, clientY);
    },
    [dropStripEl, laneEls, orderedTracks],
  );

  /// Snap a raw drag delta so the dragged edge / clip-start lands on
  /// a composition-frame boundary. Snapping the DESTINATION (not the
  /// delta itself) handles the case where the source value was
  /// already off-grid: we always end up on grid regardless of the
  /// pre-state. Returns the adjusted deltaUs.
  const snapDragDelta = useCallback(
    (kind: DragState["kind"], originalTStart: number, originalTEnd: number, rawDeltaUs: number): number => {
      const anchor = kind === "trim-end" ? originalTEnd : originalTStart;
      const snappedDest = snapFrameRound(anchor + rawDeltaUs, fpsNum, fpsDen);
      return snappedDest - anchor;
    },
    [fpsNum, fpsDen],
  );

  const snapDeltaToTimelineBoundary = useCallback(
    (
      state: DragState,
      frameDeltaUs: number,
    ): number => {
      return snapDragDeltaToTimelineBoundary({
        // The helper ignores the seed and, unless escaped, its link members —
        // which is the subject set for a move and for a duplicate alike, so a
        // copy never snaps to the sources it is leaving in place.
        state,
        frameDeltaUs,
        visibleTracks: visibleSnapTracks,
        links,
        linkByLayerId,
        // Event-time read (drag pointermove): the playhead is a snap target;
        // its value at the event is what snapping should use. Projected, because
        // it is offered alongside layer boundaries on this Panel's own axis.
        currentTimeUs: playheadClockUs(compositionId),
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: tailSnapEnabled,
        strengthPx: tailSnapStrengthPx,
      });
    },
    [
      compositionId,
      fpsNum,
      fpsDen,
      linkByLayerId,
      links,
      pxPerSec,
      tailSnapEnabled,
      tailSnapStrengthPx,
      visibleSnapTracks,
    ],
  );

  const buildMoveProjection = useCallback(
    (
      state: DragState,
      deltaUs: number,
      overTrackId: string | null,
    ): LayerMoveProjection => {
      const anchorStartUs = Math.max(0, state.originalTStart + deltaUs);
      const actualDeltaUs = anchorStartUs - state.originalTStart;
      const destinationTrackId =
        overTrackId !== null && trackAcceptsForLayer(overTrackId, state)
          ? overTrackId
          : state.trackId;
      // A raise takes the WHOLE subject set onto the one new lane and carries
      // every time verbatim: `move_layers_to_new_track` has no delta for a
      // sibling to follow. Projecting them all onto `SPAWN_TRACK_ID` is exactly
      // the question "could one empty lane hold them" — which is what makes a set
      // that would overlap itself there answer `"collision"` and refuse.
      const spawning = destinationTrackId === SPAWN_TRACK_ID;
      const projected: TimelinePlacement[] = [];

      for (const subject of state.subjects) {
        const entry = layerEntryById.get(subject.layerId);
        if (!entry) continue;
        const durationUs = subject.originalTEnd - subject.originalTStart;
        const isAnchor = subject.layerId === state.layerId;
        const tStartUs = spawning
          ? subject.originalTStart
          : isAnchor
            ? anchorStartUs
            : Math.max(0, subject.originalTStart + actualDeltaUs);
        projected.push({
          layerId: subject.layerId,
          trackId: spawning || isAnchor ? destinationTrackId : subject.trackId,
          tStartUs,
          tEndUs: tStartUs + durationUs,
          overlapClass: layerOverlapClass(entry.layer),
          // The SOURCE lane's lock speaks too. With a real destination the target
          // lane's own lock already refuses — a sibling's destination IS its
          // source — but a raise names one lane that does not exist yet, so
          // without this the strip would be a way around a lock. `"locked"`
          // out-ranks `"spawn"`, which is the whole refusal.
          locked: entry.layer.locked || entry.trackLocked,
        });
      }

      const evaluation = evaluateTimelinePlacements({
        tracks,
        placements: projected,
        // A move replaces the source intervals; a duplicate leaves them in
        // place, so the destination must also be checked against its source.
        replacedLayerIds: state.duplicate
          ? new Set()
          : new Set(state.subjects.map((subject) => subject.layerId)),
      });

      return {
        placements: projected.map((placement) => ({
          layerId: placement.layerId,
          trackId: placement.trackId,
          tStartUs: placement.tStartUs,
          tEndUs: placement.tEndUs,
        })),
        destinationTrackId,
        anchorStartUs,
        validity: evaluation.validity,
        conflictingLayerIds: evaluation.conflictingLayerIds,
      };
    },
    [layerEntryById, tracks],
  );

  const evaluatePointer = useCallback(
    (
      state: DragState,
      clientX: number,
      clientY: number,
    ): PointerDragEvaluation => {
      const deltaPx = clientX - state.startX;
      const rawDeltaUs = Math.round((deltaPx / pxPerSec) * 1_000_000);
      const anchor =
        state.kind === "trim-end" ? state.originalTEnd : state.originalTStart;
      // Compare grid destinations before calculating a drag delta. This is the
      // causality gate: snapping may refine a requested edit, but a stationary
      // pointer (including an off-grid audio anchor) cannot create one.
      const requestedFrameChange =
        snapFrameRound(anchor + rawDeltaUs, fpsNum, fpsDen) !==
        snapFrameRound(anchor, fpsNum, fpsDen);
      const frameDeltaUs = snapDragDelta(
        state.kind,
        state.originalTStart,
        state.originalTEnd,
        rawDeltaUs,
      );
      // Vertical causality gate, mirroring the frame gate above: a track
      // change must be CAUSED by vertical travel. Without it any hit-test
      // disagreement at rest reads as edit intent, and a motionless click on
      // a selected clip (arm delay 0) commits a cross-track move. Skipping
      // the measurement on horizontal-only drags is a free side benefit.
      const movedVertically = Math.abs(clientY - state.startY) >= 1;
      // A layer never changes composition by moving (ADR 0053 decision 8), so a
      // pointer over another timeline Panel names no destination at all. The
      // lane hit-test below could not tell on its own: it bands `clientY`, and a
      // Panel side by side with this one shares every band, so a clip carried
      // sideways into the neighbour would otherwise resolve to a lane at home
      // and commit a move the user never saw.
      const foreignCompositionId =
        state.kind === "move"
          ? foreignCompositionAtPoint(compositionId, clientX, clientY)
          : null;
      const hitTrackId =
        state.kind === "move" && movedVertically && foreignCompositionId === null
          ? destinationUnderPointer(clientY)
          : null;
      // Alt+drag lowers to `pasteLayers`, which needs a lane that already exists,
      // and there is no create-and-paste operation — so the strip is simply not a
      // destination for a duplicate. Withheld here rather than refused at
      // release, the same instinct as this gesture's other pre-checks.
      //
      // Withholding falls back to the SOURCE lane, and that is honest rather than
      // a silent surprise: `overTrackId === null` sends the duplicate ghost to the
      // source lane (TrackLane's `duplicatePreview`), so the copy's landing row and
      // time are both on screen before release. Do NOT "fix" this by suppressing
      // the release — the dark strip says the strip is not the target, and the
      // visible ghost says what is.
      const overTrackId =
        hitTrackId === SPAWN_TRACK_ID && state.duplicate ? null : hitTrackId;
      const destinationTrackId =
        overTrackId !== null && trackAcceptsForLayer(overTrackId, state)
          ? overTrackId
          : state.trackId;
      const trackChanged =
        state.kind === "move" && destinationTrackId !== state.trackId;

      const timeChanged =
        requestedFrameChange &&
        constrainedAnchorUs(state, frameDeltaUs, fpsNum, fpsDen) !== anchor;

      const hasEditIntent = timeChanged || trackChanged;
      // A purely vertical move preserves time. In particular, do not let its
      // zero horizontal delta be attracted to the playhead. A raise onto the
      // strip preserves it too, whatever the pointer did horizontally: the commit
      // carries times verbatim, so a ghost that slid would promise an edit
      // `move_layers_to_new_track` cannot make.
      // Over another Panel the ghost freezes where the clip already is, which is
      // the visible half of the refusal: it goes nowhere, so it promises
      // nothing. Dragging back into this Panel picks the delta up again — the
      // whole gesture is recomputed from the pointer each event.
      const deltaUs =
        timeChanged &&
        destinationTrackId !== SPAWN_TRACK_ID &&
        foreignCompositionId === null
          ? snapDeltaToTimelineBoundary(state, frameDeltaUs)
          : 0;
      const moveProjection =
        state.kind === "move"
          ? buildMoveProjection(state, deltaUs, overTrackId)
          : null;
      const nextState: DragState = {
        ...state,
        deltaUs,
        overTrackId,
        validity: moveProjection?.validity ?? "valid",
        conflictingLayerIds: moveProjection?.conflictingLayerIds ?? [],
      };

      const hasCommitChange =
        constrainedAnchorUs(state, deltaUs, fpsNum, fpsDen) !== anchor || trackChanged;

      return {
        state: nextState,
        hasEditIntent,
        hasCommitChange,
        moveProjection,
        foreignCompositionId,
      };
    },
    [
      buildMoveProjection,
      compositionId,
      fpsDen,
      fpsNum,
      pxPerSec,
      snapDragDelta,
      snapDeltaToTimelineBoundary,
      destinationUnderPointer,
    ],
  );

  /// The foreign composition already announced for the gesture in flight, so
  /// the crossing is reported once and not once per `pointermove`. Cleared when
  /// the pointer comes back, which re-arms it for a second crossing.
  const announcedForeignRef = useRef<string | null>(null);
  const announceForeignComposition = useCallback(
    (foreignCompositionId: string | null) => {
      if (announcedForeignRef.current === foreignCompositionId) return;
      announcedForeignRef.current = foreignCompositionId;
      if (foreignCompositionId === null || compositionId === null) return;
      refuseCrossCompositionMove(compositionId, foreignCompositionId);
    },
    [compositionId],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const current = gestureRef.current;
      if (!current) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      const evaluation = evaluatePointer(current.state, clientX, clientY);
      announceForeignComposition(evaluation.foreignCompositionId);
      const next: LayerDragGesture = {
        ...current,
        lastClientX: clientX,
        lastClientY: clientY,
      };
      const store = useLayerDragStore.getState();
      if (current.phase === "pending") {
        if (Date.now() < current.armAtMs || !evaluation.hasEditIntent) {
          gestureRef.current = next;
          return;
        }
        gestureRef.current = {
          ...next,
          phase: "dragging",
          state: evaluation.state,
        };
        store.begin(evaluation.state, clientX, clientY);
        return;
      }
      gestureRef.current = { ...next, state: evaluation.state };
      store.publish(evaluation.state);
      store.moveVisual(clientX, clientY);
    },
    [announceForeignComposition, evaluatePointer],
  );

  const handlePointerUp = useCallback(
    async (e: PointerEvent) => {
      const current = gestureRef.current;
      if (!current) return;
      const evaluation = evaluatePointer(
        current.state,
        e.clientX,
        e.clientY,
      );
      const temporalArmReached =
        current.phase === "dragging" || Date.now() >= current.armAtMs;
      gestureRef.current = null;
      setGestureActive(false);
      useLayerDragStore.getState().end();
      // Released over another timeline: nothing is sent. The frozen ghost has
      // already emptied the commit, and this states the rule rather than
      // relying on that.
      announceForeignComposition(evaluation.foreignCompositionId);
      if (
        evaluation.foreignCompositionId !== null ||
        !temporalArmReached ||
        !evaluation.hasEditIntent ||
        !evaluation.hasCommitChange
      ) {
        return;
      }
      const committed = evaluation.state;
      const deltaUs = committed.deltaUs;
      const moveProjection = evaluation.moveProjection;

      try {
        // `docs/features.md#links` — Alt-held at drag start opts the move /
        // trim out of link fanout for this single op.
        const escape = committed.escapeLink;
        switch (committed.kind) {
          case "move": {
            const spawning =
              moveProjection?.destinationTrackId === SPAWN_TRACK_ID;
            // The verdict a committable release has to carry: `"spawn"` over the
            // strip (a lane that does not exist yet is never `"valid"`),
            // `"valid"` over a real lane. Collision and lock out-rank both, so
            // this one comparison is also the refusal — the locked case needs no
            // branch of its own.
            if (
              !moveProjection ||
              moveProjection.validity !== (spawning ? "spawn" : "valid")
            ) {
              setPendingPlacements(null);
              return;
            }
            if (spawning) {
              // ONE history entry, from ONE operation: the lane appears, every
              // subject moves onto it, and every lane the raise emptied goes with
              // it, so one undo puts all of it back. Never decomposed into
              // add-track + move — that is two entries and a stranded lane if the
              // second half fails.
              //
              // A bridge is keyed by destination track id and this destination
              // has no id until the commit returns, so one written here could
              // match no lane and would never clear. Nothing to bridge either —
              // times are carried verbatim, so the only change is which row the
              // clip sits on. Any bridge an earlier gesture left is dropped for
              // the same reason: the raise moves its subjects out from under it.
              setPendingPlacements(null);
              const spawnedTrackId = await moveLayersToNewTrack(
                committed.subjects.map((subject) => subject.layerId),
              );
              onLaneSpawned(spawnedTrackId);
              break;
            }
            if (committed.duplicate) {
              // ONE `paste_layers` for the whole subject set, so the clones are
              // one history row and one undo (`docs/features.md#links`). The
              // dragged seed goes first: the op reads the drop position as the
              // seed's, shifts every other clone by the delta the seed
              // travelled, and changes track for the seed alone.
              const seedFirst = [
                committed.layerId,
                ...committed.subjects
                  .map((subject) => subject.layerId)
                  .filter((id) => id !== committed.layerId),
              ];
              // One ghost per subject under a provisional id, then the same
              // batch again under the ids the actor minted — a single state
              // update each way, so no frame shows a partial set.
              const ghosts = (cloneIdFor: (sourceId: string) => string) =>
                moveProjection.placements.map((placement) => ({
                  ...placement,
                  layerId: cloneIdFor(placement.layerId),
                  sourceLayerId: placement.layerId,
                }));
              setPendingPlacements(
                ghosts((sourceId) => `${sourceId}::pending-duplicate`),
              );
              const { clones } = await pasteLayers(
                seedFirst,
                moveProjection.anchorStartUs,
                moveProjection.destinationTrackId,
              );
              const cloneBySource = new Map(
                clones.map((pair) => [pair.source, pair.clone]),
              );
              setPendingPlacements(
                ghosts(
                  (sourceId) =>
                    cloneBySource.get(sourceId) ?? `${sourceId}::pending-duplicate`,
                ),
              );
              break;
            }
            setPendingPlacements(moveProjection.placements);
            await moveLayer(
              committed.layerId,
              moveProjection.destinationTrackId,
              moveProjection.anchorStartUs,
              escape,
            );
            break;
          }
          case "trim-start": {
            const newStart = constrainedAnchorUs(committed, deltaUs, fpsNum, fpsDen);
            await trimLayer(committed.layerId, "in", newStart, escape);
            break;
          }
          case "trim-end": {
            const newEnd = constrainedAnchorUs(committed, deltaUs, fpsNum, fpsDen);
            await trimLayer(committed.layerId, "out", newEnd, escape);
            break;
          }
        }
        await onMutated();
      } catch (err) {
        setPendingPlacements(null);
        logMutationFailure(err, "Timeline drag commit");
      }
    },
    [
      announceForeignComposition,
      evaluatePointer,
      // The trim commits read the grid directly. `evaluatePointer` happens to
      // change with them too, but leaning on that would make this handler's
      // freshness someone else's dependency list.
      fpsDen,
      fpsNum,
      onLaneSpawned,
      onMutated,
    ],
  );

  // If an unselected clip moved during the grace window and the pointer then
  // rests, promote it exactly when the one-shot arm delay expires. This is an
  // activation timer, not a pointermove debounce: continuous motion never
  // pushes the deadline farther away.
  useEffect(() => {
    if (!gestureActive) return;
    let timer = 0;
    const fire = () => {
      const current = gestureRef.current;
      if (!current || current.phase !== "pending") return;
      // Re-read the deadline instead of trusting the one this effect was
      // scheduled against: a fresh pointerdown replaces the gesture without
      // flipping the boolean that mounts this effect, so it would be stale.
      const remainingMs = current.armAtMs - Date.now();
      if (remainingMs > 0) {
        timer = window.setTimeout(fire, remainingMs);
        return;
      }
      const evaluation = evaluatePointer(
        current.state,
        current.lastClientX,
        current.lastClientY,
      );
      if (!evaluation.hasEditIntent) return;
      gestureRef.current = {
        ...current,
        phase: "dragging",
        state: evaluation.state,
      };
      useLayerDragStore
        .getState()
        .begin(evaluation.state, current.lastClientX, current.lastClientY);
    };
    timer = window.setTimeout(
      fire,
      Math.max(0, (gestureRef.current?.armAtMs ?? 0) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [evaluatePointer, gestureActive]);

  useEffect(() => {
    if (!gestureActive) return;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [gestureActive, handlePointerMove, handlePointerUp]);

  return { setDrag, pendingPlacements, pendingLayerById, dragLayerById };
}
