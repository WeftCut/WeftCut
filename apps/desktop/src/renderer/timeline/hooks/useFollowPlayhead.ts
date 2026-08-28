import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { AnchorFrame } from "../../render/timeProjection";
import { subscribeLocalPlayhead } from "../../state/playheadProjection";
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

  const apply = useCallback(
    (tUs: number | null) => {
      const root = rootRef.current;
      if (!root || scrubbingRef.current || tUs === null) return;
      const geom = geomRef.current;
      const target = followPageScrollLeft({
        playheadPx: (tUs / 1_000_000) * geom.pxPerSec,
        // The store, not `root.scrollLeft` — see the layout-read note above. It
        // tracks the node because the scroll event publishes to it and because
        // this hook publishes its own writes below.
        scrollLeftPx: timelineScrollLeftPx(compositionId),
        viewportPx: geom.viewportWidthPx,
        maxScrollLeftPx: geom.contentWidthPx - geom.viewportWidthPx,
      });
      if (target === null) return;
      root.scrollLeft = target;
      // Publish now instead of waiting for the scroll event's rAF: the ruler's
      // tick window is a subscriber, and one frame of the pre-jump region under
      // a post-jump playhead reads as a glitch. The event still fires and
      // reconciles against whatever the DOM actually clamped to.
      setTimelineScrollLeftPx(compositionId, target);
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
    return subscribeLocalPlayhead(compositionId, anchorFrame, apply);
  }, [anchorFrame, apply, compositionId, enabled, measured]);

  const setScrubbing = useCallback((active: boolean) => {
    scrubbingRef.current = active;
  }, []);

  return { setScrubbing };
}
