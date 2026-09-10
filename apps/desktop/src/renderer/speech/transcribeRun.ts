// One transcription run, from the press to the cues on a caption track — the
// whole of it, in one place, so the command is the only surface that has to
// state the log pair and the in-flight flag.
//
// There is no dialog in front of it. The one field a dialog used to carry, a
// language hint, was optional and empty was the recommended answer: every
// engine detects the language at least as well as a user guesses it —
// whisper.cpp runs `-l auto`, OpenAI omits the form field, and FunASR's model
// IS the language — so a box whose right answer is "leave it empty" was a click
// that asked nothing. The clip is the selection, so nothing is left to confirm.
//
// `transcribing` is module-level state rather than a component's local because
// the COMMAND has to grey out while a run is in flight — a second concurrent
// run would bill a second request and race two caption tracks onto the
// timeline — and a command gate cannot read a component's local state
// (`speech/autoCaptionEligibility.ts` folds it into the verdict).

import { create } from "zustand";

import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { applySubtitles, logEmit, transcribeClip } from "../ipc";

interface TranscribeRunState {
  transcribing: boolean;
}

export const useTranscribeRunStore = create<TranscribeRunState>(() => ({
  transcribing: false,
}));

export function setTranscribing(transcribing: boolean): void {
  useTranscribeRunStore.setState({ transcribing });
}

/// What to transcribe, and what to do once the cues have landed.
export interface TranscribeRunTarget {
  layerId: string;
  /// What the log rows call the run's subject: the clip's display name,
  /// resolved by the caller because the run itself has no React and no i18n
  /// hook.
  label: string;
  /// Reveals the Caption Panel on success. Without it a successful
  /// transcription looks like nothing happened: the cues land on a track whose
  /// editor may well be closed.
  revealCaptions: () => void;
}

/// Transcribe one clip, then apply the returned SRT as a caption track. One
/// gesture, two steps, and only the second touches the project — so one undo
/// removes the whole track (`add_caption_track` commits once).
///
/// There is no review gate, and that is deliberate: the result is a track of
/// editable `Text` layers and `CaptionsPanel` already edits them per cue, which
/// is strictly more than a review list could offer. Every comparable NLE
/// generates directly for the same reason.
///
/// Answers the failure's own sentence, or `""` on success — the command needs
/// it to decide whether the failure has a remedy to open. The sentence is also
/// in the status log by the time this returns; the return value adds nothing a
/// log row lacks except the chance to act on it.
///
/// Refuses to start while another run is going, for the store's reason above.
export async function runTranscribe(target: TranscribeRunTarget): Promise<string> {
  if (useTranscribeRunStore.getState().transcribing) return "";
  setTranscribing(true);
  // Multi-second and network-dependent, so the run announces itself: without
  // a Started row the status badge has nothing to spin on and the user cannot
  // tell a slow engine from a dead one. One `op_id` pairs it with the
  // terminal row (docs/status-log.md).
  const opId = crypto.randomUUID();
  void logEmit({
    level: "info",
    category: { kind: "Project" },
    source: { kind: "User" },
    message: `Transcribing ${target.label}`,
    i18n_key: "log.auto_caption_started",
    i18n_args: { clip: target.label },
    op_id: opId,
    op_state: { state: "Started" },
  });
  try {
    // No language hint goes on the wire, so every engine runs its own
    // detection (the module note says why that is the right default, not a
    // missing option).
    const transcript = await transcribeClip(target.layerId);
    await applySubtitles(transcript.srt);
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `${transcript.segments.length} caption cues added`,
      i18n_key: "log.auto_caption_done",
      i18n_args: { cues: transcript.segments.length, engine: transcript.backend },
      op_id: opId,
      op_state: { state: "Ok" },
    });
    setTranscribing(false);
    target.revealCaptions();
    return "";
  } catch (err) {
    // The tool's own message, verbatim: "no transcription model available"
    // names Settings → Transcription, `PayloadTooLarge` names the ~13-minute
    // cap, and a speed refusal names `split_layer`. A generic "transcription
    // failed" would throw away the only actionable half.
    const message = refusalText(err);
    // Under the run's own `op_id`, or the Started row above never closes and
    // the status bar keeps a transcription spinning that has already failed.
    logMutationFailure(err, "transcribe_clip", opId);
    // Cleared on failure too, or the command stays greyed for the rest of the
    // session.
    setTranscribing(false);
    return message;
  }
}
