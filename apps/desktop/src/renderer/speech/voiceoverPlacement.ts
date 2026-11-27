// Where a voiceover lands, and what the dialog says about it.
//
// The numbers are the hybrid arm's own defaults (`main/state/hybrids.ts`:
// `ensureAudioTrack` takes the LAST track of the root composition, and
// `t_start_us` falls back to the root's `duration_us`). They are mirrored rather
// than left implicit because the dialog has to STATE where the audio will land —
// and mirroring them is also what lets `target_track_id` be sent explicitly, so
// the destination shown is the destination written.
//
// Pure, so the arithmetic is tested without a dialog.

import type { CompositionSummary, ProjectSummary, TrackSummary } from "../ipc";

/// Append at the end of the film, or start at the playhead. Two options and not
/// a free time field: those are the two answers a human actually means, and a
/// timecode entry would make the common case the laborious one.
export type VoiceoverPlacement = "append" | "playhead";

/// The root composition, or null before a project is open. Not
/// `rootCompositionOf`, which throws: this runs during a dialog's render, where
/// "no project yet" is an ordinary state rather than a bug.
export function rootOrNull(
  summary: ProjectSummary | null,
): CompositionSummary | null {
  if (!summary) return null;
  return summary.compositions[summary.root_id] ?? null;
}

/// The track the hybrid would pick on its own: the LAST track of the root
/// composition. Null when the project has none — the pathological case the arm
/// answers by creating a "Voiceover" track, which the dialog cannot name in
/// advance and therefore leaves to it.
export function defaultVoiceoverTrackId(
  root: CompositionSummary | null,
): string | null {
  const tracks = root?.tracks ?? [];
  return tracks.length > 0 ? tracks[tracks.length - 1]!.id : null;
}

/// Every track a voiceover may be sent to, in the order the picker lists them.
/// Every track, not only the audio-role ones: a track carries no kind
/// restriction (docs/data-model.md#track), so filtering here would hide
/// destinations the actor accepts.
export function voiceoverTrackOptions(
  root: CompositionSummary | null,
): readonly TrackSummary[] {
  return root?.tracks ?? [];
}

/// The timeline start each placement resolves to, in the ROOT composition's
/// clock — the clock `playheadStore` already holds and the one the hybrid's
/// `duration_us` fallback is expressed in.
///
/// Clamped at zero only; deliberately NOT frame-snapped. An audio layer is not
/// on the frame lattice (ADR 0038 gives audio sub-frame placement its own
/// gestures), so quantizing here would move the voiceover off the moment the
/// user pointed at.
export function voiceoverStartUs(
  placement: VoiceoverPlacement,
  root: CompositionSummary | null,
  playheadUs: number,
): number {
  if (placement === "playhead") return Math.max(0, Math.round(playheadUs));
  return Math.max(0, Math.round(root?.duration_us ?? 0));
}
