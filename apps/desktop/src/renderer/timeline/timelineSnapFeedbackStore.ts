import { create } from "zustand";

// One transient guide per timeline composition. Keep event-rate updates out of
// Timeline's root React state: only the guide leaf subscribes to this store.
export type TimelineSnapOwner = "layer" | "foreign" | "media" | "marker" | "blade";
interface Guide { owner: TimelineSnapOwner; boundaryUs: number }
interface TimelineSnapFeedbackState {
  byComposition: Record<string, Guide | undefined>;
}
const keyOf = (compositionId: string | null) => compositionId ?? "__root__";

export const useTimelineSnapFeedback = create<TimelineSnapFeedbackState>(() => ({
  byComposition: {},
}));

export function setTimelineSnapGuide(
  compositionId: string | null,
  owner: TimelineSnapOwner,
  boundaryUs: number | null,
): void {
  const key = keyOf(compositionId);
  useTimelineSnapFeedback.setState((state) => {
    const current = state.byComposition[key];
    if (boundaryUs === null) {
      if (current?.owner !== owner) return state;
      const next = { ...state.byComposition };
      delete next[key];
      return { byComposition: next };
    }
    if (current?.owner === owner && current.boundaryUs === boundaryUs) return state;
    return { byComposition: { ...state.byComposition, [key]: { owner, boundaryUs } } };
  });
}

/** Media drag is a singleton across all lanes in this renderer. Its end()
 * clears the owner across every composition, so no lane needs a second
 * drag-end listener just to remove its own transient visual feedback. */
export function clearTimelineSnapGuidesByOwner(owner: TimelineSnapOwner): void {
  useTimelineSnapFeedback.setState((state) => {
    const next = { ...state.byComposition };
    let changed = false;
    for (const [composition, guide] of Object.entries(next)) {
      if (guide?.owner !== owner) continue;
      delete next[composition];
      changed = true;
    }
    return changed ? { byComposition: next } : state;
  });
}

export function useTimelineSnapBoundary(compositionId: string | null): number | null {
  return useTimelineSnapFeedback((s) => s.byComposition[keyOf(compositionId)]?.boundaryUs ?? null);
}
