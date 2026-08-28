import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type TrackSummary } from "../../ipc";
import {
  DEFAULT_PX_PER_SEC,
  HEADER_COL_PX,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC_FLOOR,
  clamp,
} from "../geometry";
import {
  fitPxPerSec,
  steppedPxPerSec,
  zoomAnchorX,
  zoomedScrollLeft,
} from "../zoom";
import { wheelPixels } from "../wheelScroll";
import {
  loadViewState,
  noteTabZoom,
  noteTrackExpanded,
  noteTrackHeights,
} from "../../state/viewState";

/// The lane's visible width — `clientWidth` minus the sticky header column,
/// which overlays the left edge and hides content under it. Read off the node
/// per gesture rather than from `viewportWidthPx` state, so a press or a wheel
/// tick arriving before the ResizeObserver's re-measure has committed still
/// anchors against the lane the user is actually looking at.
function laneWidthPx(root: HTMLDivElement): number {
  return root.clientWidth - HEADER_COL_PX;
}

/// One timeline Panel's view state: its own zoom (px/sec) and scroll, plus the
/// heights of the rows it draws, and both zoom gestures — Ctrl/Alt+wheel
/// anchored on the cursor, keys anchored on the playhead.
///
/// Reads and writes ONE tab's entry in `view.json` and no more. Several
/// timeline Panels can stand open (ADR 0053) and they share one file, so the
/// writes go through `state/viewState.ts`, which is the single owner of the
/// document and of the debounce in front of it.
export function useTimelineView(opts: {
  /// The composition this Panel shows — the key its zoom and scroll are
  /// remembered under. `null` is the unbound row the Dock builds before a
  /// summary names a root: it shows no composition, so it remembers nothing.
  compositionId: string | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  tracks: TrackSummary[];
  durationUs: number;
}): {
  pxPerSec: number;
  trackHeights: Record<string, number>;
  setTrackHeights: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  trackHeightsRef: React.MutableRefObject<Record<string, number>>;
  expandedTracks: Set<string>;
  toggleExpanded: (id: string) => void;
  viewportWidthPx: number;
  /// Step the zoom by `steps` doublings (negative zooms out), holding
  /// `anchorTimeUs` still — the keyboard path. Stable identity: safe to hand
  /// straight to a shortcut handler.
  zoomBySteps: (steps: number, anchorTimeUs: number) => void;
} {
  const { compositionId, rootRef, tracks, durationUs } = opts;
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  // Track ids whose keyframe sub-lanes are expanded. Persisted to view.json.
  const [expandedTracks, setExpandedTracks] = useState<Set<string>>(new Set());
  const [viewportWidthPx, setViewportWidthPx] = useState(0);
  // The restored scroll offset, still waiting for a lane wide enough to hold
  // it. Null once it has landed, or when there was nothing to restore.
  const [pendingScrollLeftPx, setPendingScrollLeftPx] = useState<number | null>(
    null,
  );
  // Suppress the initial post-load echo: the first load-then-set-state pair
  // must not push the values it just read back at the owner. Flipped to true
  // only after this Panel's own read completes.
  const viewLoadedRef = useRef<boolean>(false);

  // -------- Initial load + patches back to the owner --------

  // One read per Panel; the owner serves them all from one request. The
  // backend returns defaults pre-workspace (blank-on-boot session), so this is
  // safe to call unconditionally.
  useEffect(() => {
    let cancelled = false;
    void loadViewState().then((state) => {
      if (cancelled) return;
      const tab = state.composition_tabs.find(
        (entry) => entry.composition_id === compositionId,
      );
      setPxPerSec(
        clamp(
          tab?.px_per_sec ?? DEFAULT_PX_PER_SEC,
          MIN_PX_PER_SEC_FLOOR,
          MAX_PX_PER_SEC,
        ),
      );
      setTrackHeights(state.track_heights);
      setExpandedTracks(new Set(state.expanded_tracks));
      setPendingScrollLeftPx(tab?.scroll_left_px ?? null);
      viewLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [compositionId]);

  // The restored offset can only be written once the canvas is at least as
  // wide as it was when the offset was taken — the width follows the project's
  // duration, which can arrive after `view.json` does, and a write against a
  // too-narrow lane silently clamps. Hence the read-back: the pending value is
  // retried, on each render that could have widened the lane, until it sticks
  // or a zoom gesture abandons it (a lane that never widens enough would
  // otherwise keep pulling the view back).
  useLayoutEffect(() => {
    if (pendingScrollLeftPx === null) return;
    const root = rootRef.current;
    if (!root) return;
    root.scrollLeft = pendingScrollLeftPx;
    if (root.scrollLeft === pendingScrollLeftPx) setPendingScrollLeftPx(null);
  }, [pendingScrollLeftPx, pxPerSec, durationUs, viewportWidthPx, rootRef]);

  // Refs hold the latest values for the event-time handlers, which read them
  // rather than closing over React's render cadence.
  const pxPerSecRef = useRef(pxPerSec);
  const trackHeightsRef = useRef(trackHeights);
  // Latest project duration — the wheel handler reads this to compute
  // the "fit-to-viewport" min zoom each tick, so a project getting
  // longer (new clips added) immediately widens the wheel-out range.
  const durationUsRef = useRef(durationUs);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setViewportWidthPx(Math.max(0, root.clientWidth - HEADER_COL_PX));
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [rootRef]);
  useEffect(() => {
    pxPerSecRef.current = pxPerSec;
  }, [pxPerSec]);
  useEffect(() => {
    trackHeightsRef.current = trackHeights;
  }, [trackHeights]);
  useEffect(() => {
    durationUsRef.current = durationUs;
  }, [durationUs]);

  useEffect(() => {
    if (!viewLoadedRef.current) return;
    noteTabZoom(compositionId, pxPerSec);
  }, [compositionId, pxPerSec]);

  // Only the rows THIS Panel draws. The map spans the whole project, and this
  // Panel holds a copy of it that stops being current the moment another Panel
  // resizes one of its own rows — reporting the copy wholesale would revert
  // that edit. Dead ids are dropped by the owner, against the project's own
  // track set, so nothing has to be filtered here.
  useEffect(() => {
    if (!viewLoadedRef.current) return;
    const own: Record<string, number> = {};
    for (const track of tracks) {
      const px = trackHeights[track.id];
      if (px !== undefined) own[track.id] = px;
    }
    noteTrackHeights(own);
  }, [trackHeights, tracks]);

  // Single-key patches for the same reason, and a diff rather than the set
  // itself because collapsing a row is a REMOVAL: a whole-set write from one
  // Panel would collapse every row another Panel had expanded.
  const reportedExpandedRef = useRef<ReadonlySet<string>>(expandedTracks);
  useEffect(() => {
    const reported = reportedExpandedRef.current;
    reportedExpandedRef.current = expandedTracks;
    if (!viewLoadedRef.current) return;
    for (const id of expandedTracks) {
      if (!reported.has(id)) noteTrackExpanded(id, true);
    }
    for (const id of reported) {
      if (!expandedTracks.has(id)) noteTrackExpanded(id, false);
    }
  }, [expandedTracks]);

  // -------- Zoom: Ctrl/Alt+wheel (cursor-anchored), keys (playhead-anchored) --------

  // Re-anchoring happens in a layout effect, after React has re-rendered with
  // the new px/sec. Doing it inline in the gesture handler reads stale state and
  // produces a one-frame jitter. Both gestures queue the same record here; all
  // that distinguishes them is which x they chose to hold.
  const zoomPendingRef = useRef<{
    scrollLeft: number;
    anchorXInViewport: number;
    oldPxPerSec: number;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // React's JSX `onWheel` is registered passive in modern React, so
    // `preventDefault()` from there silently fails. Attach manually
    // with `{ passive: false }` so we can swallow the default
    // page-scroll behaviour when Ctrl is held.
    const onWheel = (e: WheelEvent) => {
      // Ctrl is the web's zoom modifier and Resolve's; Alt is Premiere's. Both,
      // because the muscle memory a user arrives with is whichever NLE their
      // hands came from — and neither collides with the scroll gesture, which
      // owns the bare wheel and Shift (`hooks/useWheelScroll.ts`).
      if (!e.ctrlKey && !e.altKey) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      // The root's left edge starts under the sticky track-header
      // column, which doesn't scroll — measure the cursor from the
      // scrolling body's left edge instead so the re-anchor math
      // holds.
      //
      // Taken as the anchor verbatim, NOT through `zoomAnchorX`: the cursor is
      // the anchor by definition, wherever it is. Over the header column it
      // reads negative, which anchors a time just left of the lane — and that
      // is the honest answer for a gesture the user aimed there.
      const cursorXInViewport = e.clientX - rect.left - HEADER_COL_PX;
      // deltaMode varies by device — normalise lines/pages to pixels before
      // computing the zoom factor. Shared with the scroll gesture's mapping
      // (`timeline/wheelScroll.ts`) so a notch means the same travel in both.
      const px = wheelPixels(e.deltaY, e.deltaMode);
      // Exponential zoom: small wheel ticks scale by ~ε near 1.0, big
      // ones don't snap-jump. Negative px (scrolling up) zooms in.
      const factor = Math.exp(-px * 0.001);
      const oldPxPerSec = pxPerSecRef.current;
      // Lower bound = "fit-to-viewport" zoom (`zoom.fitPxPerSec`), recomputed
      // every tick so it tracks viewport resize + project growth.
      const fitMin = fitPxPerSec(laneWidthPx(root), durationUsRef.current);
      const newPxPerSec = clamp(oldPxPerSec * factor, fitMin, MAX_PX_PER_SEC);
      if (newPxPerSec === oldPxPerSec) return;
      zoomPendingRef.current = {
        scrollLeft: root.scrollLeft,
        anchorXInViewport: cursorXInViewport,
        oldPxPerSec,
      };
      // The gesture owns the offset from here; a still-unapplied restore would
      // fight the re-anchor below for it.
      setPendingScrollLeftPx(null);
      setPxPerSec(newPxPerSec);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
    };
  }, [rootRef]);

  /// Keyboard zoom. Same bounds and same re-anchor as the wheel; the anchor is
  /// the playhead instead of the cursor, and the step is a doubling instead of
  /// a wheel delta (`zoom.ts` owns both). The caller passes the time to hold
  /// rather than the hook reading the playhead store, which keeps the view
  /// state's one dependency the project and leaves "anchor the playhead" a
  /// decision the call site can see.
  const zoomBySteps = useCallback(
    (steps: number, anchorTimeUs: number) => {
      const root = rootRef.current;
      if (!root) return;
      const oldPxPerSec = pxPerSecRef.current;
      const viewportPx = laneWidthPx(root);
      const newPxPerSec = steppedPxPerSec(
        oldPxPerSec,
        steps,
        fitPxPerSec(viewportPx, durationUsRef.current),
      );
      // Already parked against the stop this press asks for.
      if (newPxPerSec === oldPxPerSec) return;
      const scrollLeft = root.scrollLeft;
      zoomPendingRef.current = {
        scrollLeft,
        anchorXInViewport: zoomAnchorX({
          anchorPx: (anchorTimeUs / 1_000_000) * oldPxPerSec,
          scrollLeftPx: scrollLeft,
          viewportPx,
        }),
        oldPxPerSec,
      };
      setPendingScrollLeftPx(null);
      setPxPerSec(newPxPerSec);
    },
    [rootRef],
  );

  // Re-anchor the scroll position so the anchored time stays put. Runs
  // synchronously after the layout flip so there's no flash.
  useLayoutEffect(() => {
    const pending = zoomPendingRef.current;
    if (!pending) return;
    zoomPendingRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    root.scrollLeft = zoomedScrollLeft({
      scrollLeftPx: pending.scrollLeft,
      anchorX: pending.anchorXInViewport,
      ratio: pxPerSec / pending.oldPxPerSec,
    });
  }, [pxPerSec, rootRef]);

  const toggleExpanded = useCallback(
    (id: string) =>
      setExpandedTracks((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }),
    [],
  );

  return {
    pxPerSec,
    trackHeights,
    setTrackHeights,
    trackHeightsRef,
    expandedTracks,
    toggleExpanded,
    viewportWidthPx,
    zoomBySteps,
  };
}
