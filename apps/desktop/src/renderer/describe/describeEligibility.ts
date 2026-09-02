// Whether the selection is a clip a vision model can look at, and why not when
// it is not.
//
// The sibling of `speech/autoCaptionEligibility.ts` and the same three shapes
// for the same two reasons: a Dock Panel cannot read Timeline's locals and has
// to render the gate it dispatches, and `CommandDef.enabled` is evaluated
// during its caller's own render, so only a subscribed form re-evaluates.
//
// Its own module rather than a fourth state on the audio gate, because the
// material question is a different one: description reads the PICTURE stream,
// so an Audio layer is the wrong kind here and the right kind there. Every
// disabled state is its own string because the instruction differs.

import type { LayerSummary, TrackSummary } from "../ipc";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import {
  compositionOrRoot,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import {
  currentSelection,
  primaryLayerIdOf,
  usePrimaryLayerId,
} from "../state/selectionStore";
import { primarySelectedLayer } from "../speech/autoCaptionEligibility";

/// Stable empty reference — a fresh `[]` per selector call would defeat the
/// reference-equality bail-out the hooks below rely on.
const NO_TRACKS: readonly TrackSummary[] = [];

/// `describe` is the live direction; the rest are the disabled reasons, one per
/// tooltip string.
///
/// No in-flight state, unlike auto-caption's: a description is a local model run
/// that starts nowhere but its own dialog, and the dialog disables its own
/// button while one is going. Greying the command for it would refuse the
/// gesture with no instruction behind the refusal.
export type DescribeState =
  | "describe"
  | "needs_selection"
  | "needs_video_kind"
  | "speed_not_one";

/// The order of the checks is the order the instructions get harder: select
/// something, select a picture clip, then go and split a speed-1 segment off it.
///
/// Pure, so the store reads belong to the forms below it.
export function describeState(
  primaryId: string | null,
  tracks: readonly TrackSummary[],
): DescribeState {
  const layer = primarySelectedLayer(primaryId, tracks);
  if (!layer) return "needs_selection";
  const params = layer.params;
  // `describe_clip` takes a VideoClip and nothing else — an Image or a Motif
  // has no frame stream to sample, and Rust refuses each by kind.
  if (params.kind !== "VideoClip") return "needs_video_kind";
  // The gesture-side half of the tool's own refusal: sampling maps window time
  // onto source time by one addition with no speed factor, so a re-timed clip's
  // segments would be timestamped at source times its frames never show.
  if (params.speed !== 1) return "speed_not_one";
  return "describe";
}

/// Imperative form, for `CommandDef.enabled` and the command handler — both run
/// where there is no React.
export function describeForSelection(): DescribeState {
  return describeState(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
  );
}

export function canDescribeSelection(): boolean {
  return describeForSelection() === "describe";
}

/// The clip a description would read, or null — what the command hands to the
/// dialog so it can name the clip it is about to work on. Answers even when the
/// gesture is not live, so a greyed row can still say which clip it meant.
export function describeTarget(): LayerSummary | null {
  return primarySelectedLayer(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
  );
}

/// Subscription form — two stores, two subscriptions, neither a composite
/// selector (`feedback_zustand_composite_selector`). The project subscription
/// closes over the other and yields a STRING, so an unrelated project mutation
/// re-runs the predicate and then bails out instead of re-rendering.
export const useDescribeState = (): DescribeState => {
  const primaryId = usePrimaryLayerId();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    describeState(
      primaryId,
      compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS,
    ),
  );
};
