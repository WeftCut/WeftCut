// Single-axis overflow geometry for the app's strip scrollers — the dock tab
// strip and the Quick Actions strip. Given where a scroller sits and where its
// items lie, it answers: which ends still hide content, where a paging step
// should land, and whether an item has come to rest under an end overlay.
//
// Pure. The DOM side — reading the numbers, subscribing to scroll and resize,
// painting the overlays — lives in `hooks/useEdgeOverflow.ts`.
//
// Both strips share this module so "which end hides content" cannot drift
// between them; they deliberately differ only in what they draw from it.
// ADR 0050 carries the why.

/// Tolerance for comparing two fractional layout numbers — an item's edge
/// against the readable band's. Layout arrives in fractional CSS px on a
/// fractional-DPI display, so an item flush with the band's edge measures a few
/// tenths of a px past it.
const SUBPIXEL_EPSILON = 0.5;

/// Tolerance for comparing a scroll offset against the scroll limit, which needs
/// its own and a much wider one: the two sides are not in the same number space.
/// `scrollStart` is the browser's own fractional offset, while `contentSize` and
/// `viewportSize` come from `scrollWidth` / `clientWidth`, which are integers —
/// the first ENCLOSES the fractional content, overstating it by up to 1px, and
/// the second ROUNDS the fractional viewport, either way, by up to 0.5px. So a
/// limit derived from them can name an offset up to 1.5px past the furthest one
/// the browser will clamp a scroll to.
///
/// LANDMINE: tightening this to `SUBPIXEL_EPSILON` strands the trailing overlay.
/// A strip parked at its true maximum then reads as "not at the end", so the
/// overlay never retires — and its arrow, whose target the browser clamps to the
/// offset the strip is already at, becomes a button that visibly does nothing.
/// Whether it bites depends on the content's fractional widths, which is what
/// makes it look intermittent: six tabs in a Group here overstate the limit by
/// 0.73px and wedge, five overstate it by 0.18px and the bug hides.
const SCROLL_LIMIT_EPSILON = 1.5;

/// Where the scroller sits along its axis. Horizontal strips read
/// `scrollLeft` / `clientWidth` / `scrollWidth`; vertical ones read the block
/// equivalents. Nothing here knows which.
export interface EdgeGeometry {
  readonly scrollStart: number;
  /// The visible extent — what the user can see at once.
  readonly viewportSize: number;
  /// The laid-out extent of everything in the scroller.
  readonly contentSize: number;
}

export interface EdgeState {
  readonly overflowing: boolean;
  /// Nothing is hidden before the viewport, so the leading end has nothing to
  /// announce. True for a strip that does not overflow at all.
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/// An item's extent in content coordinates: `[start, end]`, ascending, in DOM
/// order. For a tab strip these are `offsetLeft` and `offsetLeft + offsetWidth`
/// — the same datum `scrollStart` is measured in.
export type ItemRange = readonly [start: number, end: number];

export interface EdgeScrollView extends EdgeGeometry {
  /// How much of EACH end an overlay covers. Content under it is unreadable and
  /// unclickable, so every target below treats the overlaid band as outside the
  /// viewport — which is the whole reason these functions need the number.
  readonly overlaySize: number;
}

const maxScrollOf = (g: EdgeGeometry): number =>
  Math.max(0, g.contentSize - g.viewportSize);

const clampScroll = (value: number, limit: number): number =>
  Math.min(Math.max(value, 0), limit);

/// Which ends have something to announce. Consumers paint an end iff it is
/// overflowing and not "at" — the two flags are what keeps an end's gradient and
/// its arrow from ever being out of step.
///
/// All three verdicts read the limit, so all three carry its tolerance: an "at"
/// verdict means the same thing at either end, and a strip whose whole travel is
/// inside the tolerance is one the browser cannot really scroll, so it reports as
/// fitting.
export function edgeState(g: EdgeGeometry): EdgeState {
  const limit = maxScrollOf(g);
  const overflowing = limit > SCROLL_LIMIT_EPSILON;
  return {
    overflowing,
    atStart: !overflowing || g.scrollStart <= SCROLL_LIMIT_EPSILON,
    atEnd: !overflowing || g.scrollStart >= limit - SCROLL_LIMIT_EPSILON,
  };
}

/// Where a step toward `toward` should land, or null when that end has nothing
/// left to reveal.
///
/// The step is item-aligned rather than a fraction of the viewport: items are
/// discrete named destinations, so a step that stops mid-item leaves a target
/// the user can see but not read. It reveals the nearest item that is not
/// already fully readable, by bringing that item's outer edge to the readable
/// band's edge — the mirror image in each direction.
///
/// A returned target always moves: the chosen item was picked for lying past the
/// readable band, so its aligned offset differs from the current one before
/// clamping, and the clamp can only pull it back to an end stop that `atStart` /
/// `atEnd` has already ruled out.
export function edgeScrollTarget(
  view: EdgeScrollView,
  items: readonly ItemRange[],
  toward: "start" | "end",
): number | null {
  const { scrollStart, viewportSize, overlaySize } = view;
  const state = edgeState(view);
  if (toward === "end" ? state.atEnd : state.atStart) return null;
  const limit = maxScrollOf(view);

  if (toward === "end") {
    const readableEnd = scrollStart + viewportSize - overlaySize;
    const next = items.find(([, end]) => end > readableEnd + SUBPIXEL_EPSILON);
    // Nothing straddles the trailing overlay, yet the scroller still has room
    // to travel: what remains is its own trailing padding, so the end stop is
    // the only honest step.
    if (!next) return limit;
    return clampScroll(next[1] - viewportSize + overlaySize, limit);
  }

  const readableStart = scrollStart + overlaySize;
  let previous: ItemRange | undefined;
  for (const item of items) {
    if (item[0] >= readableStart - SUBPIXEL_EPSILON) break;
    previous = item;
  }
  if (!previous) return 0;
  return clampScroll(previous[0] - overlaySize, limit);
}

/// The offset that lifts `item` out from under an end overlay, or null when it
/// already rests in the readable band.
///
/// Needed because the app's own paths steer items straight into that band:
/// Dockview scrolls a newly activated tab to `scrollStart = item.start`, flush
/// with the scrollport edge, which is exactly where the leading overlay sits. So
/// the tab a user just asked for — from the View menu, or by clicking a clipped
/// one — comes to rest under the arrow that hides it.
///
/// One pass is enough: correcting an edge lands the item exactly on the band's
/// boundary, and over-correcting past an end stop only retires that end's
/// overlay, which cannot re-hide the item. The one case that could ping-pong is
/// guarded below.
export function overlayClearTarget(
  view: EdgeScrollView,
  item: ItemRange,
): number | null {
  const { scrollStart, viewportSize, overlaySize } = view;
  const state = edgeState(view);
  const [start, end] = item;

  const leading = state.atStart ? 0 : overlaySize;
  const trailing = state.atEnd ? 0 : overlaySize;
  const bandStart = scrollStart + leading;
  const bandEnd = scrollStart + viewportSize - trailing;

  let target: number;
  if (end - start >= bandEnd - bandStart - SUBPIXEL_EPSILON) {
    // Wider than the readable band, so it cannot clear both overlays: pin its
    // start, where the label — and so the Panel's only name — begins.
    // Correcting the trailing edge instead would push the start under the
    // leading overlay, and the next correction would push it straight back.
    target = start - leading;
  } else if (start < bandStart - SUBPIXEL_EPSILON) {
    target = start - leading;
  } else if (end > bandEnd + SUBPIXEL_EPSILON) {
    target = end - viewportSize + trailing;
  } else {
    return null;
  }

  const clamped = clampScroll(target, maxScrollOf(view));
  // A correction that lands where the scroller already sits is not a correction.
  // Judged against the limit's tolerance, not the sub-pixel one, because
  // `clamped` inherits the limit's overstatement: an item at the trailing end
  // yields a target a px past the offset the strip is already parked at, and
  // returning it would have the caller write a `scrollLeft` the browser discards.
  return Math.abs(clamped - scrollStart) <= SCROLL_LIMIT_EPSILON ? null : clamped;
}
