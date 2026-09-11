// One transcription run, from the press to the cues on a caption track — the
// whole of it, in one place, so the command is the only surface that has to
// state the log rows and the in-flight flag.
//
// There is no dialog in front of it. The one field a dialog used to carry, a
// language hint, was optional and empty was the recommended answer: every
// engine detects the language at least as well as a user guesses it —
// whisper.cpp runs `-l auto`, OpenAI omits the form field, and FunASR's model
// IS the language — so a box whose right answer is "leave it empty" was a click
// that asked nothing. The clips are the selection, so nothing is left to confirm.
//
// A run reads N clips and writes ONCE (ADR 0070). The reads go one at a time,
// in timeline order — two engines on one machine would fight for the same
// cores, and two cloud calls in flight would bill in an order nobody chose —
// and every transcript that came back is applied in one `apply_subtitles`
// call, so a six-clip transcription is one history row and one undo, and the
// caption packing sees every cue at once. The run stops at the first clip that
// fails and still lands what it has: the engine-wide failures (no model, no
// key, no network) fail the first clip before anything is billed, and a
// per-clip one (a clip over the provider's payload cap) should not throw away
// the transcripts already paid for. The status log then says both things — the
// cues that landed, and the clip that did not, by name.
//
// `transcribing` is module-level state rather than a component's local because
// the COMMAND has to grey out while a run is in flight — a second concurrent
// run would bill a second request and race two caption tracks onto the
// timeline — and a command gate cannot read a component's local state
// (`speech/autoCaptionEligibility.ts` folds it into the verdict).

import { create } from "zustand";

import { logMutationFailure, refusalText } from "../errors/tryMutate";
import {
  applySubtitles,
  logEmit,
  transcribeClip,
  type LogEntryInput,
  type TranscriptResult,
} from "../ipc";

interface TranscribeRunState {
  transcribing: boolean;
}

export const useTranscribeRunStore = create<TranscribeRunState>(() => ({
  transcribing: false,
}));

export function setTranscribing(transcribing: boolean): void {
  useTranscribeRunStore.setState({ transcribing });
}

/// One clip a run reads.
export interface TranscribeClip {
  layerId: string;
  /// What the log rows call the clip: its display name, resolved by the caller
  /// because the run itself has no React and no i18n hook.
  label: string;
}

/// What to transcribe, and what to do once the cues have landed.
export interface TranscribeRunTarget {
  /// In the order they are read — the caller hands them over in timeline
  /// order (`transcribeSubjects`), already reduced to one subject per source.
  clips: readonly TranscribeClip[];
  /// Reveals the Caption Panel once cues have landed. Without it a successful
  /// transcription looks like nothing happened: the cues land on a track whose
  /// editor may well be closed.
  revealCaptions: () => void;
}

const ROW = {
  category: { kind: "Project" },
  source: { kind: "User" },
} as const;

/// Multi-second and network-dependent, so the run announces itself: without a
/// Started row the status badge has nothing to spin on and the user cannot tell
/// a slow engine from a dead one. One `op_id` pairs it with the terminal row
/// (docs/status-log.md). One clip is named; several are counted — the names
/// are in the Caption Panel the moment the cues land.
function startedRow(clips: readonly TranscribeClip[], opId: string): LogEntryInput {
  const base = { level: "info", ...ROW, op_id: opId, op_state: { state: "Started" } } as const;
  const [only] = clips;
  return clips.length === 1 && only
    ? {
        ...base,
        message: `Transcribing ${only.label}`,
        i18n_key: "log.auto_caption_started",
        i18n_args: { clip: only.label },
      }
    : {
        ...base,
        message: `Transcribing ${clips.length} clips`,
        i18n_key: "log.auto_caption_started_many",
        i18n_args: { count: clips.length },
      };
}

/// What came back and landed: the cue count over every transcript, and the
/// engine that served them — engines, should the resolver have changed its
/// mind between clips, so a fallback is visible rather than averaged away.
/// Terminal (closes the op as `Ok`) when nothing went wrong; a plain row when
/// a later clip failed and the failure is the row that closes the op.
function doneRow(transcripts: readonly TranscriptResult[], opId: string | null): LogEntryInput {
  const cues = transcripts.reduce((n, t) => n + t.segments.length, 0);
  const engine = [...new Set(transcripts.map((t) => t.backend))].join(", ");
  return {
    level: "info",
    ...ROW,
    message: `${cues} caption cues added`,
    i18n_key: "log.auto_caption_done",
    i18n_args: { cues, engine },
    ...(opId === null ? {} : { op_id: opId, op_state: { state: "Ok" } }),
  };
}

/// The clip that failed, BY NAME, and the tool's own sentence: "no
/// transcription model available" names Settings → Transcription,
/// `PayloadTooLarge` names the ~13-minute cap, and a speed refusal names
/// `split_layer`. A generic "transcription failed" would throw away the only
/// actionable half, and a row that did not name the clip would leave a
/// six-clip run's user guessing which one to fix. Terminal (closes the op as
/// `Err`) unless the write step failed too, in which case that row closes it.
function failedRow(clip: TranscribeClip, err: unknown, opId: string | null): LogEntryInput {
  const reason = refusalText(err);
  return {
    level: "error",
    ...ROW,
    message: `Transcribing ${clip.label} failed: ${reason}`,
    i18n_key: "log.auto_caption_failed",
    i18n_args: { clip: clip.label, reason },
    details: { context: "transcribe_clip", layer_id: clip.layerId },
    ...(opId === null ? {} : { op_id: opId, op_state: { state: "Err" } }),
  };
}

/// Transcribe the clips, then apply every transcript that came back as caption
/// cues in ONE commit. The module note says why the reads are serial, why the
/// write is single, and what a mid-run failure leaves behind.
///
/// There is no review gate, and that is deliberate: the result is editable
/// `Text` layers on a caption track and `CaptionsPanel` already edits them per
/// cue, which is strictly more than a review list could offer. Every comparable
/// NLE generates directly for the same reason.
///
/// Answers the first failure's own sentence, or `""` when everything landed —
/// the command needs it to decide whether the failure has a remedy to open. The
/// sentence is also in the status log by the time this returns; the return
/// value adds nothing a log row lacks except the chance to act on it.
///
/// Refuses to start while another run is going, for the store's reason above.
export async function runTranscribe(target: TranscribeRunTarget): Promise<string> {
  if (useTranscribeRunStore.getState().transcribing) return "";
  const { clips } = target;
  // Prevented by the command's gate; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (clips.length === 0) return "";
  setTranscribing(true);
  const opId = crypto.randomUUID();
  void logEmit(startedRow(clips, opId));

  // The read half: one call per clip, in order, stopping at the first that
  // fails. No language hint goes on the wire, so every engine runs its own
  // detection (the module note says why that is the right default, not a
  // missing option).
  const transcripts: TranscriptResult[] = [];
  let failed: { clip: TranscribeClip; err: unknown } | null = null;
  for (const clip of clips) {
    try {
      transcripts.push(await transcribeClip(clip.layerId));
    } catch (err) {
      failed = { clip, err };
      break;
    }
  }

  // The write half: one `apply_subtitles` over every transcript. The SRT
  // bodies concatenate as they are — each ends in a blank line, and the parser
  // takes its cues from the `-->` lines, never from the per-body numbering —
  // so no body is rebuilt here from `segments`.
  let applyError: unknown = null;
  if (transcripts.length > 0) {
    try {
      await applySubtitles(transcripts.map((t) => t.srt).join(""));
    } catch (err) {
      applyError = err;
    }
  }

  // Exactly one row closes the op, whatever happened: the Started row above
  // otherwise never closes and the status bar keeps a transcription spinning
  // that has already ended. The write failure is that row when there is one
  // (it is the half that touches the project), else the clip that failed,
  // else the cues that landed.
  const landed = transcripts.length > 0 && applyError === null;
  const clean = failed === null && applyError === null;
  if (landed) void logEmit(doneRow(transcripts, clean ? opId : null));
  if (failed !== null) void logEmit(failedRow(failed.clip, failed.err, applyError === null ? opId : null));
  if (applyError !== null) logMutationFailure(applyError, "apply_subtitles", opId);

  // Cleared before the reveal and on failure too, or the command stays greyed
  // for the rest of the session.
  setTranscribing(false);
  if (landed) target.revealCaptions();
  if (failed !== null) return refusalText(failed.err);
  if (applyError !== null) return refusalText(applyError);
  return "";
}
