// Page-scroll geometry for "follow the playhead": given where the playhead is
// and where the view sits, decide whether the view should jump, and to what
// offset. Pure — the DOM side (when to ask, what to do with the answer) lives
// in `hooks/useFollowPlayhead.ts`.
//
// Paging, not tracking. The alternative — pinning the playhead to a fixed
// column and sliding the content under it — rewrites `scrollLeft` on every
// composition frame, and every write publishes to `timelineScrollStore` and
// re-renders the ruler. Paging touches the view once per screenful, which is
// also the convention the user already knows from Premiere/FCP.

/// Distance from a viewport edge at which the playhead counts as "at" it.
/// Wide enough to cover the playhead head's triangle (it overhangs the line by
/// ~7 px each way), so the jump fires before the marker is visibly clipped.
const EDGE_PAD_PX = 12;

/// Where the playhead lands after a jump, as a fraction of the viewport — a
/// margin, not a centring. Its job is to leave a sliver of already-played
/// context behind the marker; anything larger just throws away lookahead, which
/// is the whole point of paging forward.
const LEAD_RATIO = 0.08;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

export interface FollowViewport {
  /// Playhead position in content px — `timeUs / 1e6 * pxPerSec`, the same
  /// coordinate space as `scrollLeftPx` (the sticky header column is outside
  /// the scrolling body, so it offsets neither).
  playheadPx: number;
  scrollLeftPx: number;
  /// Visible lane width — the scroll root's `clientWidth` MINUS the sticky
  /// header column, which overlays the left edge and hides content under it.
  viewportPx: number;
  /// `scrollWidth - clientWidth`. Clamping against it here (rather than letting
  /// the DOM clamp the assignment) is what lets the caller compare the returned
  /// offset with the current one and skip a no-op write.
  maxScrollLeftPx: number;
  /// How far, in content px, the playhead's last move went toward earlier
  /// time; 0 for a forward move or none. Picks the side it lands on; which
  /// edge it left the view by does not.
  backwardPx: number;
}

/// The offset to page to, or `null` when the view already holds the playhead
/// comfortably — the answer on all but one frame in a screenful, so callers can
/// treat `null` as "nothing to do" on the per-frame path.
///
/// The playhead lands a lead in from the left edge, with the screen it is about
/// to play into ahead of it — after playback, a seek forward, or a jump of a
/// screen or more in either direction, which is a relocation the user reads
/// and plays forward from. A step back of less than a screen (a frame step, the
/// previous edit) lands near the RIGHT edge instead: the user repeats that
/// gesture, and a lead-sized margin would re-page on the very next press.
/// Keyed on the move, not on which edge was crossed: playback resuming behind
/// a view the user scrolled ahead runs forward from the left.
export function followPageScrollLeft(view: FollowViewport): number | null {
  const { playheadPx, scrollLeftPx, viewportPx, maxScrollLeftPx, backwardPx } = view;
  // Pre-measurement (a panel that has never laid out) and degenerate widths:
  // no window to be outside of.
  if (!(viewportPx > 0)) return null;
  const inside =
    playheadPx >= scrollLeftPx + EDGE_PAD_PX &&
    playheadPx <= scrollLeftPx + viewportPx - EDGE_PAD_PX;
  if (inside) return null;

  const lead = clamp(viewportPx * LEAD_RATIO, EDGE_PAD_PX, viewportPx / 2);
  const steppingBack = backwardPx > 0 && backwardPx < viewportPx;
  const target = steppingBack ? playheadPx - (viewportPx - lead) : playheadPx - lead;
  const clamped = clamp(target, 0, Math.max(0, maxScrollLeftPx));
  // Already parked against an end stop — the playhead sits in the pad band and
  // no scroll can improve that. Returning the current offset would make every
  // subsequent frame a write.
  return clamped === scrollLeftPx ? null : clamped;
}
