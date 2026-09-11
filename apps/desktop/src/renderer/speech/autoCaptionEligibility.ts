// Whether the selection is a clip with analyzable audio, and why not when it is
// not — plus transcription's own verdict over the WHOLE selection on top of it.
//
// Two layers, because two features ask a similar first question but of
// different subjects: the `AudioClipState` half is the material's own gate over
// the PRIMARY selection (the pause entry builds on it), and `AutoCaptionState`
// is transcription's verdict over every selected clip at once — which clips a
// press would read (`transcribeSubjects`) plus "a transcription is already
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

import type {
  CompositionSummary,
  LayerParamsView,
  LayerSummary,
  TrackSummary,
} from "../ipc";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import {
  compositionOrRoot,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import {
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
  usePrimaryLayerId,
  useSelectionStore,
  type Selection,
} from "../state/selectionStore";
import { useTranscribeRunStore } from "./transcribeRun";

/// Stable empty reference — a fresh `[]` per selector call would defeat the
/// reference-equality bail-out the hooks below rely on.
const NO_TRACKS: readonly TrackSummary[] = [];

/// Whether the selection is a clip whose AUDIO can be analyzed — the half of
/// the verdict that is not about transcription at all, and the reason it is
/// named for the material rather than for one of its readers: pause detection
/// asks the identical first question (`commands/pauseCommands.ts`, which adds
/// one condition of its own on top), and two copies of it would be two answers
/// to "does this clip have usable audio".
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

/// The PRIMARY selected layer, the same one the on-canvas gizmo boxes — what
/// the per-clip analyses (pauses) act on.
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
  // It is the SAME wall for pauses: `detect_pauses` maps source time onto the
  // timeline by one addition, with no speed factor, so a re-timed clip's pauses
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

/// A layer whose media carries an audio stream — the two `LayerParams`
/// variants `resolve_clip_audio_source` accepts, with the fields the subject
/// rules below read narrowed in the type rather than re-checked at every use.
export type AudioBearingLayer = LayerSummary & {
  params: Extract<LayerParamsView, { kind: "VideoClip" | "Audio" }>;
};

function isAudioBearing(layer: LayerSummary): layer is AudioBearingLayer {
  return layer.params.kind === "VideoClip" || layer.params.kind === "Audio";
}

/// Every selected layer the summary knows, in track order. Empty both for no
/// selection and for a selection the summary has not caught up with — the
/// gate tells those two apart by this list's length, not by the id set's.
function selectedLayers(
  selection: Selection,
  composition: CompositionSummary | null,
): LayerSummary[] {
  const ids = layerIdsOf(selection);
  if (ids.size === 0 || composition === null) return [];
  const out: LayerSummary[] = [];
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (ids.has(layer.id)) out.push(layer);
    }
  }
  return out;
}

/// The clips ONE Transcribe press reads, from the whole selection, in timeline
/// order — the subject rule ADR 0070 states. Every selected `VideoClip` or
/// `Audio` layer, less two kinds of repeat that would caption the same speech
/// twice:
///
/// 1. **One subject per link.** A plain click on a linked clip selects its
///    picture AND its sound, so the ordinary single-clip press is already a
///    two-layer selection. A `VideoClip` whose link holds a SELECTED `Audio`
///    member of the same media is dropped in favour of that member: it is the
///    layer that plays (ADR 0068), and its own `src_in_us` / `t_start_us` put
///    the words where the sound is even after an A/V slip. A picture clip whose
///    sound is not selected — an `Alt`-click escaped the link, or the link has
///    no same-media audio — stays its own subject and is read from its own
///    file, as it always was.
/// 2. **The same source span once.** Two layers of one media with the same
///    in-point at the same timeline start, at the same speed, are the same
///    audio in two places (a separated-then-unlinked pair, a duplicated bed);
///    the longer one is kept.
///
/// Layers of other kinds in the selection are ignored, not refused: a marquee
/// that also caught a title or a caption row has not changed what the user
/// meant. The gate below refuses only when NOTHING selected can be transcribed.
export function transcribeSubjects(
  selection: Selection,
  composition: CompositionSummary | null,
): AudioBearingLayer[] {
  const selected = selectedLayers(selection, composition).filter(isAudioBearing);
  if (selected.length === 0 || composition === null) return [];
  const linkMembersOf = new Map<string, readonly string[]>();
  for (const link of composition.links) {
    for (const id of link.layer_ids) linkMembersOf.set(id, link.layer_ids);
  }
  const spoken = selected.filter((layer) => {
    if (layer.params.kind !== "VideoClip") return true;
    const members = linkMembersOf.get(layer.id);
    if (!members) return true;
    const mediaId = layer.params.media_id;
    return !selected.some(
      (other) =>
        other.params.kind === "Audio" &&
        other.params.media_id === mediaId &&
        members.includes(other.id),
    );
  });
  // Same media, same in-point, same start, same RATE: a re-timed copy of a clip
  // plays different audio over the same span, so it is a subject of its own
  // (and the gate then refuses it by name rather than quietly reading its twin).
  const bySpan = new Map<string, AudioBearingLayer>();
  for (const layer of spoken) {
    const speed = layer.params.kind === "VideoClip" ? layer.params.speed : 1;
    const key = `${layer.params.media_id} ${layer.params.src_in_us} ${layer.t_start_us} ${speed}`;
    const held = bySpan.get(key);
    if (!held || layer.t_end_us > held.t_end_us) bySpan.set(key, layer);
  }
  return [...bySpan.values()].sort((a, b) => a.t_start_us - b.t_start_us);
}

/// Transcription's verdict over the whole selection. The order of the checks is
/// the order the instructions get harder, as in `audioClipState`, and the
/// wording is shared with it: "pick a clip", "pick one with sound", "split a
/// normal-speed segment off" are the same errands whether one clip or six are
/// selected. A re-timed subject ANYWHERE in the selection refuses the whole
/// press rather than skipping that clip: the user selected it meaning to
/// caption it, and a run that quietly left one clip out would read as a
/// transcription that missed some speech.
///
/// `transcribing` comes in rather than being read here so the whole verdict
/// stays one pure function — the store read belongs to the subscribed form.
export function autoCaptionState(
  selection: Selection,
  composition: CompositionSummary | null,
  transcribing: boolean,
): AutoCaptionState {
  // First, and regardless of the selection: a second concurrent run would bill
  // a second request and race two caption tracks onto the timeline.
  if (transcribing) return "transcribing";
  if (selectedLayers(selection, composition).length === 0) return "needs_selection";
  const subjects = transcribeSubjects(selection, composition);
  if (subjects.length === 0) return "needs_audio_kind";
  if (subjects.some((s) => s.params.kind === "VideoClip" && s.params.speed !== 1))
    return "speed_not_one";
  return "auto_caption";
}

export function autoCaptionForSelection(): AutoCaptionState {
  return autoCaptionState(
    currentSelection(),
    currentOpenComposition(),
    useTranscribeRunStore.getState().transcribing,
  );
}

export function canAutoCaptionSelection(): boolean {
  return autoCaptionForSelection() === "auto_caption";
}

/// The clips a Transcribe press would read right now, in the order the run
/// reads them — for the command handler, which runs where there is no React.
export function transcribeTargets(): AudioBearingLayer[] {
  return transcribeSubjects(currentSelection(), currentOpenComposition());
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

/// Subscription form of transcription's verdict — the whole selection (one
/// stable reference per change, so it is safe to hand a selector) plus the
/// in-flight flag, on the same rules.
export const useAutoCaptionState = (): AutoCaptionState => {
  const selection = useSelectionStore((s) => s.selection);
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  const transcribing = useTranscribeRunStore((s) => s.transcribing);
  return useProjectStore((s) =>
    autoCaptionState(
      selection,
      compositionOrRoot(s.summary, focusedId),
      transcribing,
    ),
  );
};
