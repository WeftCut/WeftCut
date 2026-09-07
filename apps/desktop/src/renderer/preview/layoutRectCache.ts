// Cached `getBoundingClientRect()` for the preview overlays' per-frame loops.
//
// LANDMINE: the timeline playhead writes `style.left` on every frame of
// playback, so a layout READ from a rAF loop in the same frame forces a
// synchronous reflow of the whole document — the cost scales with the number of
// open tracks and Panels, which is why the sluggishness grows with the project.
// The rule the overlays follow is the one `timeline/hooks/useFollowPlayhead.ts`
// states: nothing on the per-frame path reads layout. It reads the cache here
// instead, and the cache re-reads only when something that could have MOVED the
// element has happened.
//
// This module owns invalidation, not geometry: what a rect means is the
// overlay's business (`gizmoGeometry.ts`). Dock moves reach it from outside as
// `bumpPreviewLayoutEpoch` — the Dock is the one mover a ResizeObserver on the
// element cannot see, because relayouting a Panel can leave the observed box the
// same size at a new origin.

export interface ClientRectCache {
  /// The element's client box, re-read only after an invalidation.
  rect(): DOMRect;
  /// Drop the cached box; the next `rect()` re-reads.
  invalidate(): void;
  /// Detach every listener and leave the epoch. Idempotent.
  dispose(): void;
}

/// Every live cache's invalidator. A Set so `dispose` is exact and a double
/// dispose is harmless.
const epochInvalidators = new Set<() => void>();

/// Something moved the preview surface that no observer on the element itself
/// can see — a Dock relayout above it. Invalidates every live cache.
export function bumpPreviewLayoutEpoch(): void {
  for (const invalidate of [...epochInvalidators]) invalidate();
}

/// Whether a scroll on `target` could have moved `el`. `document` and `window`
/// scroll everything; anything else only moves what it contains — so a scroll
/// inside an unrelated Panel costs nothing.
function scrollMoves(target: EventTarget | null, el: Element): boolean {
  if (target === null) return false;
  if (target === document || target === window) return true;
  return target instanceof Node && target.contains(el);
}

/// A cache of `el`'s client box for a caller that reads it every frame.
///
/// Invalidated by anything that can move the box: the element resizing, the
/// window resizing, a scroll on an ancestor, the layout epoch, and — belt and
/// braces — a `pointerdown` anywhere, so every gesture starts from a box read
/// after whatever the previous frame did to the document.
export function observeClientRect(el: Element): ClientRectCache {
  let cached: DOMRect | null = null;
  let disposed = false;
  const invalidate = (): void => {
    cached = null;
  };
  const onScroll = (e: Event): void => {
    if (scrollMoves(e.target, el)) invalidate();
  };
  // jsdom has no ResizeObserver, and the overlays' unit tests run there.
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(invalidate);
  resizeObserver?.observe(el);
  window.addEventListener("resize", invalidate);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("pointerdown", invalidate, { capture: true, passive: true });
  epochInvalidators.add(invalidate);
  return {
    rect: () => (cached ??= el.getBoundingClientRect()),
    invalidate,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      epochInvalidators.delete(invalidate);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("pointerdown", invalidate, { capture: true });
    },
  };
}
