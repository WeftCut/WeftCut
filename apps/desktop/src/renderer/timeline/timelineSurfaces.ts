// Which timeline Panel the pointer is over.
//
// A clip drag is pointer-driven and window-global: once armed it follows the
// pointer anywhere, a second timeline showing another composition included. The
// dragging Panel cannot answer this for itself — its own lane hit-test is a band
// test on `clientY` alone, so a Panel beside it shares every band and a clip
// carried sideways would read as a lane at home.
//
// One question, asked by both parties to a crossing. The HOST asks "is another
// Panel under the pointer" and withholds every destination of its own while the
// answer is yes (`hooks/useLayerDrag.ts`). The DESTINATION asks "is it me" and,
// when it is, resolves the drop on its own axis and draws the ghost
// (`ForeignDragGhost.tsx`). Two callers, one seam, so the two can never disagree
// about where the pointer is.
//
// Rects rather than `document.elementFromPoint`: the drag already measures its
// lanes once per pointer event, so this is the same question asked the same
// way, and it is unaffected by the overlay layer Dockview paints Panel content
// into (`renderer: "always"`), which owns the topmost element at any point.
//
// This module owns no drag state, no refusal and no claim: it answers, and the
// callers decide.

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
/// into.
///
/// The host reads that answer as "somebody else's"; a candidate destination
/// reads it as "mine" by comparing it with its own composition. Both ask per
/// `pointermove`, and what keeps that affordable is the `surfaces.size < 2` fast
/// path: a lone timeline is the ordinary arrangement, and it costs a map-size
/// read rather than a forced reflow per event.
///
/// Only visible Panels are registered, so a tab hidden behind another can
/// neither be crossed into nor claim a drop — one rule, honoured at both call
/// sites with no code at either.
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
