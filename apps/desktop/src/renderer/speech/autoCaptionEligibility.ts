// Whether the selection is a clip with analyzable audio, and why not when it is
// not — plus transcription's own extra condition on top of that.
//
// Two layers, because two features ask the same first question: the
// `AudioClipState` half is the material's own gate (the silence entry reads it
// too), and `AutoCaptionState` is that verdict plus "a transcription is already
// running". The generic half stays here rather than moving to a module of its
// own so there is one place to look for it.
//
// The sibling of `timeline/groupEligibility.ts`, and the same three shapes for
// the same two reasons: a Dock Panel cannot read Timeline's locals and has to
// render the gate it dispatches, and `CommandDef.enabled` is evaluated during
// its caller's own render, so only a subscribed form re-evaluates.
//
// Every disabled state is its own string because the instruction differs: "pick
// a clip", "pick one with audio" and "split a speed-1 segment off first" send
// the user three different places, and one "cannot do that" would send them
// looking.

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

/// Whether the selection is a clip whose AUDIO can be analyzed — the half of
/// the verdict that is not about transcription at all, and the reason it is
/// named for the material rather than for one of its readers: silence detection
/// asks the identical question (`commands/silenceCommands.ts`), and two copies
/// of it would be two answers to "does this clip have usable audio".
///
/// `ok` is the live direction; the rest are the disabled reasons, and each
/// reader owns its own wording for them because the instruction differs by verb.
export type AudioClipState =
  | "ok"
  | "needs_selection"
  | "needs_audio_kind"
  | "speed_not_one";

/// `auto_caption` is the live direction; the rest are the disabled reasons, one
/// per tooltip string. The middle three are `AudioClipState`'s, carried through
/// unchanged so one gate can explain itself in either vocabulary.
export type AutoCaptionState =
  | "auto_caption"
  | Exclude<AudioClipState, "ok">
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

/// The order of the checks is the order the instructions get harder: select
/// something, select something with audio, then go and split a speed-1 segment
/// off it.
///
/// Pure, so the store reads belong to the forms below it.
export function audioClipState(
  primaryId: string | null,
  tracks: readonly TrackSummary[],
): AudioClipState {
  const layer = primarySelectedLayer(primaryId, tracks);
  if (!layer) return "needs_selection";
  const params = layer.params;
  if (params.kind !== "VideoClip" && params.kind !== "Audio")
    return "needs_audio_kind";
  // The gesture-side half of the tool's own refusal
  // (`resolve_clip_audio_source`): a re-timed clip's audio does not line up
  // with the timeline its result lands on. `speed` is on the wire for VideoClip
  // and an Audio layer has no speed field at all, so this is the whole check
  // rather than a partial one that leaves Rust to catch the rest.
  //
  // It is the SAME wall for silence: `detect_silences` maps source time onto the
  // timeline by one addition, with no speed factor, so a re-timed clip's ranges
  // would be marked at times its audio never reaches.
  if (params.kind === "VideoClip" && params.speed !== 1) return "speed_not_one";
  return "ok";
}

/// Imperative form, for `CommandDef.enabled` and the command handlers — both
/// run where there is no React.
export function audioClipForSelection(): AudioClipState {
  return audioClipState(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
  );
}

export function canTargetAudioClip(): boolean {
  return audioClipForSelection() === "ok";
}

/// The clip an audio analysis would read, or null — what a command hands to its
/// dialog so it can name the clip it is about to work on. Answers even when the
/// gesture is not live, for `addToGroupTarget`'s reason: a greyed row can still
/// say which clip it meant.
export function audioClipTarget(): LayerSummary | null {
  return primarySelectedLayer(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
  );
}

/// Auto-caption's verdict: the shared audio-clip gate plus the one condition
/// that belongs to transcription alone.
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
  const state = audioClipState(primaryId, tracks);
  return state === "ok" ? "auto_caption" : state;
}

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

/// Subscription form of the shared gate — two stores, two subscriptions,
/// neither a composite selector (`feedback_zustand_composite_selector`), exactly
/// as `useAddToGroupState` does it. The project subscription closes over the
/// other and yields a STRING, so an unrelated project mutation re-runs the
/// predicate and then bails out instead of re-rendering.
export const useAudioClipState = (): AudioClipState => {
  const primaryId = usePrimaryLayerId();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    audioClipState(
      primaryId,
      compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS,
    ),
  );
};

/// Subscription form of auto-caption's verdict — the shared gate's two stores
/// plus the in-flight flag, on the same rules.
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
