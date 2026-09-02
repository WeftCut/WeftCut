// Whether the selection can be transcribed, and why not when it cannot.
//
// The sibling of `timeline/groupEligibility.ts`, and the same three shapes for
// the same two reasons: a Dock Panel cannot read Timeline's locals and has to
// render the gate it dispatches, and `CommandDef.enabled` is evaluated during
// its caller's own render, so only a subscribed form re-evaluates.
//
// Every disabled state is its own string because the instruction differs: "pick
// a clip", "pick one with audio" and "split a speed-1 segment off first" send
// the user three different places, and one "cannot transcribe that" would send
// them looking.

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
import { useAutoCaptionPromptStore } from "./autoCaptionPrompt";

/// Stable empty reference — a fresh `[]` per selector call would defeat the
/// reference-equality bail-out the hooks below rely on.
const NO_TRACKS: readonly TrackSummary[] = [];

/// `auto_caption` is the live direction; the rest are the disabled reasons, one
/// per tooltip string.
export type AutoCaptionState =
  | "auto_caption"
  | "needs_selection"
  | "needs_audio_kind"
  | "speed_not_one"
  | "transcribing";

/// The layer a transcription would read: the PRIMARY selection, the same one
/// the on-canvas gizmo boxes. Not the whole multi-selection — a transcript is a
/// claim about one source's audio, and `apply_subtitles` writes one caption
/// track per call, so N clips would be N tracks and N undo steps.
///
/// Returns the layer whatever its kind: the kind is the gate's own question
/// below, and answering `null` for a Color layer would collapse "nothing
/// selected" into "the wrong thing selected".
export function primarySelectedLayer(
  primaryId: string | null,
  tracks: readonly TrackSummary[],
): LayerSummary | null {
  if (primaryId === null) return null;
  for (const track of tracks) {
    for (const layer of track.layers) {
      if (layer.id === primaryId) return layer;
    }
  }
  return null;
}

/// The order of the checks is the order the instructions get harder: wait for
/// the run in flight, select something, select something with audio, then go
/// and split a speed-1 segment off it.
///
/// `transcribing` comes in rather than being read here so the whole verdict
/// stays one pure function — the store read belongs to the subscribed form.
export function autoCaptionState(
  primaryId: string | null,
  tracks: readonly TrackSummary[],
  transcribing: boolean,
): AutoCaptionState {
  // First, and regardless of the selection: a second concurrent run would bill
  // a second request and race two caption tracks onto the timeline.
  if (transcribing) return "transcribing";
  const layer = primarySelectedLayer(primaryId, tracks);
  if (!layer) return "needs_selection";
  const params = layer.params;
  if (params.kind !== "VideoClip" && params.kind !== "Audio")
    return "needs_audio_kind";
  // The gesture-side half of the tool's own refusal
  // (`resolve_clip_audio_source`): a re-timed clip's audio does not line up
  // with the timeline the cues land on. `speed` is on the wire for VideoClip
  // and an Audio layer has no speed field at all, so this is the whole check
  // rather than a partial one that leaves Rust to catch the rest.
  if (params.kind === "VideoClip" && params.speed !== 1) return "speed_not_one";
  return "auto_caption";
}

/// Imperative form, for `CommandDef.enabled` and the command handler — both run
/// where there is no React.
export function autoCaptionForSelection(): AutoCaptionState {
  return autoCaptionState(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
    useAutoCaptionPromptStore.getState().transcribing,
  );
}

export function canAutoCaptionSelection(): boolean {
  return autoCaptionForSelection() === "auto_caption";
}

/// The clip a transcription would read, or null — what the command hands to the
/// dialog so it can name the clip it is about to transcribe. Answers even when
/// the gesture is not live, for `addToGroupTarget`'s reason: a greyed row can
/// still say which clip it meant.
export function autoCaptionTarget(): LayerSummary | null {
  return primarySelectedLayer(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
  );
}

/// Subscription form — three stores, three subscriptions, none of them a
/// composite selector (`feedback_zustand_composite_selector`), exactly as
/// `useAddToGroupState` does it. The project subscription closes over the other
/// two and yields a STRING, so an unrelated project mutation re-runs the
/// predicate and then bails out instead of re-rendering.
export const useAutoCaptionState = (): AutoCaptionState => {
  const primaryId = usePrimaryLayerId();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  const transcribing = useAutoCaptionPromptStore((s) => s.transcribing);
  return useProjectStore((s) =>
    autoCaptionState(
      primaryId,
      compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS,
      transcribing,
    ),
  );
};
