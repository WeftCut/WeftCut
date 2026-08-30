// How many marks are reachable inside a composition — the number a Group clip's
// `⚑N` badge draws.
//
// A count and nothing else. The badge asserts HOW MANY and never WHERE:
// projecting a child's marks onto the parent's lane would erase, visually, the
// boundary ADR 0052 and 0053 pay for — a Group is a full composition, so every
// walk, mutation and validator has exactly one path — and it would owe nesting
// an answer that a 20 px lane cannot give.

import type { ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";

/// Every PAINTED marker of `compositionId`, plus those of every composition
/// nested inside it, to any depth. Zero for a null id and for a composition the
/// summary no longer carries (one removed under a stale clip).
///
/// Recursive because the question the badge answers is "is there anything in
/// there worth opening", and a mark two levels down is as much a reason to go
/// as one at the top.
///
/// Summed over PLACEMENTS, not over compositions: a composition placed twice
/// contributes twice, because inside the parent the user meets two Group clips
/// with a badge each and the parent's number is what they add up to. So a
/// `seen` set here would not merely be redundant, it would be WRONG — it
/// collapses the second placement into the first. Nor is one needed to
/// terminate: a reference cycle is refused at the actor (`CompositionCycle`),
/// so the reference graph is acyclic. The sibling walk `firstVideoMediaIdIn`
/// (`state/projectStore.ts`) does keep one, because it wants each composition's
/// answer once and cheaply rather than once per placement.
///
/// The placing clip's SOURCE WINDOW is deliberately not consulted — which is
/// why this takes a composition and not the layer. Activating the badge opens
/// the child's Panel, and that Panel shows the whole child composition, not the
/// slice `src_in_us`/`src_out_us` frames; counting the window would hand over a
/// number the user then cannot reconcile with what they are looking at.
///
/// HIBERNATING markers do not count. Such a marker is retained in state and
/// painted nowhere — `computeLaneMarkers` (`rulerModel.ts`) drops it, and so do
/// the mini timeline and the search palette — so counting it would send someone
/// in to hunt for a mark that is drawn on no surface.
export function groupMarkerCount(
  summary: ProjectSummary | null,
  compositionId: string | null,
): number {
  if (!summary || compositionId === null) return 0;
  const composition = summary.compositions[compositionId];
  if (!composition) return 0;
  let total = 0;
  for (const marker of composition.markers) {
    if (!marker.hibernating) total += 1;
  }
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.params.kind !== "CompositionRef") continue;
      total += groupMarkerCount(summary, layer.params.composition_id);
    }
  }
  return total;
}

/// Subscription form, for the badge. Yields a NUMBER, so an unrelated project
/// mutation re-walks and then bails out instead of re-rendering the clip
/// (`feedback_zustand_composite_selector`).
export const useGroupMarkerCount = (compositionId: string | null): number =>
  useProjectStore((s) => groupMarkerCount(s.summary, compositionId));
