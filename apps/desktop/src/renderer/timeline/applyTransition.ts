// The store-reading half of the argumentless "apply transition" surfaces:
// `findNearestCut` (transitions.ts) is the pure kernel, this module binds it
// to live state. The palette/menu command and the Transitions-panel cards
// both dispatch through `applyTransitionAtPlayhead`, so target semantics
// can never drift between outlets.
//
// Everything reads stores imperatively at call time, for the reason
// `canMoveSelectionToNewTrack` does: App does not subscribe to selection or
// playhead, so a value captured at build time would freeze.

import { addTransition, type TransitionDirection } from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
import { playheadTimeUs } from "../state/playheadStore";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import {
  compositionOrRoot,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import {
  setTransitionSelection,
  useSelectionStore,
} from "../state/selectionStore";
import {
  buildTransitionKindArgs,
  defaultTransitionDurationUs,
  findNearestCut,
  type TransitionCut,
  type TransitionKindName,
} from "./transitions";

/// The cut an argumentless apply would hit right now, or null when no eligible
/// cut exists anywhere. Eligibility includes the duration these surfaces will
/// send — the default 1 s — so a pair too short for it is never offered. Null
/// is what `enabled` predicates gate on — prevention rather than refusal, per
/// the menus/toasts convention.
export function transitionTargetCut(): TransitionCut | null {
  const comp = currentOpenComposition();
  if (!comp) return null;
  return findNearestCut(
    comp.tracks,
    playheadTimeUs(),
    defaultTransitionDurationUs(comp.fps_num, comp.fps_den),
    useSelectionStore.getState().selectedLayerIds,
  );
}

/// Live `enabled` gate. Which cut wins depends on the playhead, but whether
/// ANY (default-duration-eligible) cut exists does not — so this probes at
/// t=0 and skips the playhead and selection reads.
export function hasTransitionCut(): boolean {
  const comp = currentOpenComposition();
  if (!comp) return false;
  return (
    findNearestCut(
      comp.tracks,
      0,
      defaultTransitionDurationUs(comp.fps_num, comp.fps_den),
    ) !== null
  );
}

/// Subscription form of `hasTransitionCut` for surfaces that render the gate
/// (the Transitions-panel cards). Boolean selector on purpose: an edit
/// re-renders the subscriber only when cut-existence flips, not on every
/// summary refresh.
export const useHasTransitionCut = (): boolean => {
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) => {
    const comp = compositionOrRoot(s.summary, focusedId);
    return (
      comp !== null &&
      findNearestCut(
        comp.tracks,
        0,
        defaultTransitionDurationUs(comp.fps_num, comp.fps_den),
      ) !== null
    );
  });
};

/// Apply `kind` (+ `direction`) at the resolved target with the default
/// 1 s frame-snapped duration — no placement arg, so the add takes the
/// overlap default (the incoming layer moves left; ADR 0048). The eligibility
/// gate above prevents the duration-bound refusal; the ones state can still
/// spring (participants sharing a link, a moved sibling crossing t = 0)
/// surface through the status log as structured refusals — never a silent
/// clamp or fallback.
///
/// On success the new transition is selected: these surfaces sit away from
/// the timeline, and with no toast by convention, the highlighted chip plus
/// the inspector flipping to the transition IS the feedback that names where
/// the apply landed.
export async function applyTransitionAtPlayhead(
  kind: TransitionKindName,
  direction: TransitionDirection | undefined,
  refresh: () => Promise<void> | void,
): Promise<void> {
  const comp = currentOpenComposition();
  if (!comp) return;
  const cut = transitionTargetCut();
  if (!cut) return;
  const args = buildTransitionKindArgs(kind, direction ?? null);
  try {
    const id = await addTransition({
      fromLayerId: cut.fromLayerId,
      toLayerId: cut.toLayerId,
      durationUs: defaultTransitionDurationUs(comp.fps_num, comp.fps_den),
      kind: args.kind,
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
    });
    setTransitionSelection(id);
    await refresh();
  } catch (err) {
    logMutationFailure(err, "Add transition");
  }
}
