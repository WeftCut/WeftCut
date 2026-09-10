// The pause gesture as a command: open the Pauses section on the clip that
// plays.
//
// Only OPENS. Every parameter, every read and both write verbs live in
// `properties/PausesSection.tsx`, because tuning a threshold needs the timeline
// visible and playable beside it (spec Decision 3). What this module owns is
// the half a section cannot: resolving the SUBJECT of a selection, and the gate
// and refusal wording that go with it.
//
// The subject rule (spec Decision 1) is stated here as the renderer twin of
// main's `state/pauseSubject.ts`: an Audio layer is its own subject; a
// VideoClip delegates to the Audio member of its link that shares its media,
// else to the link's sole Audio member, else it has none. Two implementations
// because the two sides read different shapes — main reads `Layer`, this reads
// `LayerSummary` — and one wrong answer here would grey a row the tool would
// have accepted, or offer one it will refuse.
//
// Self-contained, so App lends `detectPausesSelected` a `HandlerMap` slot and
// the Panel reveal only — the same split `commands/describeCommands.ts`
// documents, and for the same reason: a command registered by Timeline vanishes
// with the Timeline Panel, and the clip context menu must not lose rows when a
// Panel is closed (`menu/contextMenuCommands.test.ts` states the rule).

import type { CompositionSummary, LayerSummary } from "../ipc";
import { requestPropSectionExpand } from "../properties/PropSection";
import {
  audioClipState,
  audioClipTarget,
  type AudioClipState,
} from "../speech/autoCaptionEligibility";
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

/// The section id every surface here agrees on — the command's expand request
/// and the section's own `PropSection` must name the same one or the command
/// opens nothing.
export const PAUSES_SECTION_ID = "pauses";

/// The shared audio-clip verdict plus the one condition that belongs to pauses
/// alone: a clip whose sound is played by nobody has no subject to measure.
///
/// `plays_no_sound` is last for a reason — it is only reachable once the kind
/// and speed checks have passed, so a re-timed VideoClip still reads
/// `speed_not_one` and gets the instruction that actually unblocks it.
export type PauseSubjectState = AudioClipState | "plays_no_sound";

/// The Audio layer a detection reads and both verbs write to, or `null`.
///
/// A VideoClip's OWN audio track is not what plays: only `LayerParams::Audio`
/// reaches either mixer, so reading the picture clip's source file would make a
/// muted, slipped or deleted partner invisible to the detector and cut picture
/// by sound nobody hears. Resolving on the Audio layer also makes A/V slip
/// correct for free — its own `src_in_us` / `t_start_us` map the ranges.
///
/// Same-media first, sole-Audio-member second: a link holding one picture clip
/// and its own detached audio is the ordinary case, and a link that also
/// carries a music bed is the one where "the audio that belongs to this
/// picture" has to be said by the media id rather than by counting.
export function resolvePauseSubjectSummary(
  layer: LayerSummary,
  composition: CompositionSummary | null,
): LayerSummary | null {
  if (layer.params.kind === "Audio") return layer;
  if (layer.params.kind !== "VideoClip" || composition === null) return null;
  const clipMediaId = layer.params.media_id;
  const link = composition.links.find((l) => l.layer_ids.includes(layer.id));
  if (!link) return null;
  const members: LayerSummary[] = [];
  for (const track of composition.tracks) {
    for (const member of track.layers) {
      if (member.id !== layer.id && link.layer_ids.includes(member.id)) {
        members.push(member);
      }
    }
  }
  const audio = members.filter((m) => m.params.kind === "Audio");
  const sameMedia = audio.find(
    (m) => m.params.kind === "Audio" && m.params.media_id === clipMediaId,
  );
  if (sameMedia) return sameMedia;
  return audio.length === 1 ? (audio[0] ?? null) : null;
}

/// The whole verdict for one selection. Pure, so the store reads belong to the
/// two forms below it.
export function pauseSubjectState(
  primaryId: string | null,
  composition: CompositionSummary | null,
): PauseSubjectState {
  const base = audioClipState(primaryId, composition?.tracks ?? []);
  if (base !== "ok") return base;
  for (const track of composition?.tracks ?? []) {
    for (const layer of track.layers) {
      if (layer.id !== primaryId) continue;
      return resolvePauseSubjectSummary(layer, composition) === null
        ? "plays_no_sound"
        : "ok";
    }
  }
  return "needs_selection";
}

/// Imperative form, for `CommandDef.enabled` and the command handler — both run
/// where there is no React.
export function pauseSubjectForSelection(): PauseSubjectState {
  return pauseSubjectState(
    primaryLayerIdOf(currentSelection()),
    currentOpenComposition(),
  );
}

export function canDetectPausesSelection(): boolean {
  return pauseSubjectForSelection() === "ok";
}

/// Subscription form — two stores, two subscriptions, neither a composite
/// selector (`feedback_zustand_composite_selector`). The project subscription
/// closes over the other and yields a STRING, so an unrelated project mutation
/// re-runs the predicate and then bails out instead of re-rendering.
export const usePauseSubjectState = (): PauseSubjectState => {
  const primaryId = usePrimaryLayerId();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    pauseSubjectState(primaryId, compositionOrRoot(s.summary, focusedId)),
  );
};

/// Expand the Pauses section for the primary selected clip.
///
/// Keyed by the SELECTED layer's kind and not by the subject's: the section is
/// mounted by the panel showing that layer, so a delegating VideoClip's section
/// lives under `VideoClip:pauses` even though what it measures is an Audio
/// layer.
///
/// The selection is read from the store, not from a captured value: the gate is
/// evaluated live for the same reason, and App does not re-render on a
/// multi-select change.
export function openPausesForSelection(): void {
  const layer = audioClipTarget();
  // Prevented by the command's `enabled`; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (!layer) return;
  requestPropSectionExpand(layer.kind, PAUSES_SECTION_ID);
}
