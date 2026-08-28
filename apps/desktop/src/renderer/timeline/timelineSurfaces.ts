// Which timeline Panel the pointer is over.
//
// A clip drag is pointer-driven and window-global: once armed it follows the
// pointer anywhere, a second timeline showing another composition included. A
// layer never changes composition by moving (ADR 0053 decision 8), so that
// gesture has to be refused where the user can see it — and the one fact the
// dragging Panel cannot answer on its own is which composition sits under the
// pointer now. Its own lane hit-test is a band test on `clientY` alone, so a
// Panel beside it shares every band and would otherwise read as a lane at home.
//
// Rects rather than `document.elementFromPoint`: the drag already measures its
// lanes once per pointer event, so this is the same question asked the same
// way, and it is unaffected by the overlay layer Dockview paints Panel content
// into (`renderer: "always"`), which owns the topmost element at any point.
//
// This module owns no drag state and no refusal: `hooks/useLayerDrag.ts` asks,
// and decides.

/// `composition_id → that Panel's scroll root`. Only Panels currently on screen
/// are entered, so a tab hidden behind another cannot claim a point that is
/// visibly inside its neighbour.
const surfaces = new Map<string, HTMLElement>();

/// Publish a visible timeline Panel's surface. The returned unregister is
/// identity-guarded (the `registerRevealTrack` pattern), so a stale cleanup
/// running after a remount cannot drop the newer entry.
export function registerTimelineSurface(
  compositionId: string,
  el: HTMLElement,
): () => void {
  surfaces.set(compositionId, el);
  return () => {
    if (surfaces.get(compositionId) === el) surfaces.delete(compositionId);
  };
}

/// The composition of the timeline Panel under the point when that Panel is not
/// `hostCompositionId`'s — null for a point over the host itself, over no
/// timeline at all, or whenever a second timeline cannot exist to be crossed
/// into. That last case is the common one and is answered without measuring
/// anything, which is what keeps this affordable on a drag's `pointermove`.
export function foreignCompositionAtPoint(
  hostCompositionId: string | null,
  clientX: number,
  clientY: number,
): string | null {
  if (hostCompositionId === null || surfaces.size < 2) return null;
  for (const [compositionId, el] of surfaces) {
    if (compositionId === hostCompositionId) continue;
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return compositionId;
    }
  }
  return null;
}
