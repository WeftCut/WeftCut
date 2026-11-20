import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { AnchorFrame } from "../../render/timeProjection";
import { usePlaybackStore } from "../../state/playbackStore";
import { subscribeLocalPlayhead } from "../../state/playheadProjection";
import { playheadSeekCount } from "../../state/playheadStore";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../../state/timelineScrollStore";
import { followPageScrollLeft } from "../followPlayhead";

/// Keeps the playhead inside the timeline's visible span by paging the view
/// when it reaches an edge — during playback and after a jump (a shortcut seek,
/// an edit-point step, a timecode entry). The page geometry itself is
/// `followPlayhead.ts`; this hook owns when it is consulted and the scroll write.
///
/// Frame-rate rule (see `state/playheadStore.ts`): the playhead moves once per
/// composition frame, so this is a TRANSIENT subscription writing the DOM
/// directly — no React state, nothing above a leaf re-renders while playing.
/// The same rule is why every input arrives pre-measured instead of being read
/// off the node: a per-frame `clientWidth` read would force a synchronous
/// layout right after the playhead component dirtied `style.left`.
///
/// YIELDS to the user's view. Once something other than this hook moves the
/// view — a wheel or trackpad scroll, a scrollbar drag, a zoom — playback stops
/// paging until one of: the playhead is comfortably inside a view that held
/// still for a frame (it has caught up with where the user looked ahead), a
/// user seek (`playheadSeekCount`), or playback starting. Without it every
/// composition frame paged back a view the user had just scrolled off the
/// playhead, and the two alternated each frame — a flicker. No timer resumes
/// it: a view pulled away from what the user is reading is the same fight,
/// only later.
///
/// PROJECTED: it pages against this Panel's own reading of the moment, so a
/// scrub in one timeline pages the others by their own geometry. A moment this
/// composition is not on screen at pages nothing — there is no line to keep in
/// view.
export function useFollowPlayhead(opts: {
  /// The composition this timeline shows — the key its scroll offset is
  /// published under, so paging one Panel never moves another's ruler.
  compositionId: string | null;
  /// Where that composition's clock sits on the root's, resolved by the caller
  /// so this hook's per-frame callback walks nothing.
  anchorFrame: AnchorFrame | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  /// Visible lane width, header column already subtracted.
  viewportWidthPx: number;
  /// Full canvas width in px (`computeTimelineExtent`).
  contentWidthPx: number;
  enabled: boolean;
}): {
  /// Gate the follow across a playhead DRAG. Scrubbing on the ruler is the one
  /// playhead move the user makes with the pointer, against the view they are
  /// looking at — paging out from under that pointer fights the gesture.
  setScrubbing: (active: boolean) => void;
} {
  const {
    compositionId,
    anchorFrame,
    rootRef,
    pxPerSec,
    viewportWidthPx,
    contentWidthPx,
    enabled,
  } = opts;
  const scrubbingRef = useRef(false);

  // Latest geometry, so the subscription below registers once per enable rather
  // than being torn down and rebuilt on every zoom tick and resize. Updated in
  // a LAYOUT effect: the values describe the committed DOM, and a playhead
  // event landing between render and commit must still page against the layout
  // that is actually on screen.
  const geomRef = useRef({ pxPerSec, viewportWidthPx, contentWidthPx });
  useLayoutEffect(() => {
    geomRef.current = { pxPerSec, viewportWidthPx, contentWidthPx };
  }, [pxPerSec, viewportWidthPx, contentWidthPx]);

  // Where the view and the seek count stood at this hook's last look, and
  // whether it is yielding. Reset on every (re)subscribe below.
  const followRef = useRef({ scrollLeftPx: 0, seeks: 0, yielded: false });

  const apply = useCallback(
    (tUs: number | null) => {
      const root = rootRef.current;
      if (!root || scrubbingRef.current || tUs === null) return;
      const geom = geomRef.current;
      const follow = followRef.current;
      // The store, not `root.scrollLeft` — see the layout-read note above. It
      // tracks the node because the scroll event publishes to it and because
      // this hook publishes its own writes below.
      const scrollLeftPx = timelineScrollLeftPx(compositionId);
      const seeks = playheadSeekCount();
      // A user seek outranks a moved view: `jumpToTimeUs` seeks AND scrolls.
      const viewMoved = seeks === follow.seeks && scrollLeftPx !== follow.scrollLeftPx;
      if (seeks !== follow.seeks) follow.yielded = false;
      else if (viewMoved) follow.yielded = true;
      follow.seeks = seeks;
      follow.scrollLeftPx = scrollLeftPx;

      const target = followPageScrollLeft({
        playheadPx: (tUs / 1_000_000) * geom.pxPerSec,
        scrollLeftPx,
        viewportPx: geom.viewportWidthPx,
        maxScrollLeftPx: geom.contentWidthPx - geom.viewportWidthPx,
      });
      if (follow.yielded) {
        // Re-arm only on a still view: mid-gesture the playhead can sit
        // comfortably inside for a frame before the next scroll step lands.
        if (!viewMoved && target === null) follow.yielded = false;
        return;
      }
      if (target === null) return;
      root.scrollLeft = target;
      // Publish now instead of waiting for the scroll event's rAF: the ruler's
      // tick window is a subscriber, and one frame of the pre-jump region under
      // a post-jump playhead reads as a glitch. Read back (once per page, not
      // per frame) rather than publish `target`: the DOM snaps the offset to
      // device pixels, and the scroll event's later publish of the snapped
      // value would read as a user scroll and stop the follow after one page.
      setTimelineScrollLeftPx(compositionId, root.scrollLeft);
      follow.scrollLeftPx = timelineScrollLeftPx(compositionId);
    },
    [compositionId, rootRef],
  );

  // Whether there is a lane to page at all. A mount's first commit has no
  // measurement yet (`useTimelineView` measures in a layout effect), and a
  // panel hidden behind another dock tab measures 0 again.
  const measured = viewportWidthPx > 0;

  useEffect(() => {
    if (!enabled || !measured) return;
    // Catch up on enable — deliberately keyed on the gates and the projection,
    // never on the geometry. Widening this to `pxPerSec` would re-anchor on the playhead
    // every wheel tick, and zoom picks its own anchor (`timeline/zoom.ts`: the
    // cursor on a wheel tick, the playhead on a key press) — including the
    // deliberate decision NOT to chase an off-screen playhead; widening it to
    // the width would re-anchor on every panel resize.
    // Project edits rebuild the AnchorFrame object even when its clock is
    // unchanged. Re-subscribing in that case immediately applies the parked
    // playhead and steals the user's horizontal window during track edits.
    // Subscribe to the clock's values, not the summary's object identity.
    //
    // A (re)subscribe starts un-yielded against the view as it stands: turning
    // the follow on is the user asking for it.
    const rearm = () => {
      followRef.current = {
        scrollLeftPx: timelineScrollLeftPx(compositionId),
        seeks: playheadSeekCount(),
        yielded: false,
      };
    };
    rearm();
    const unsubPlayback = usePlaybackStore.subscribe((s, prev) => {
      if (s.playing && !prev.playing) rearm();
    });
    const unsubPlayhead = subscribeLocalPlayhead(compositionId, anchorFrame, apply);
    return () => {
      unsubPlayback();
      unsubPlayhead();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    anchorFrame?.offsetUs, anchorFrame?.windowStartUs, anchorFrame?.windowEndUs,
    anchorFrame?.fpsNum, anchorFrame?.fpsDen, apply, compositionId, enabled, measured,
  ]);

  const setScrubbing = useCallback((active: boolean) => {
    scrubbingRef.current = active;
  }, []);

  return { setScrubbing };
}
