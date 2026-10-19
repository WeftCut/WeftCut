// One transcription run, from the press to the cues on a caption track — the
// whole of it, in one place, so the command is the only surface that has to
// state the log rows and the in-flight flag.
//
// The UI checks source levels before starting inference and asks whether to
// proceed when audio is quiet or the check is unavailable. Normalization is
// explicit per run, only for selected quiet sources' inference copies.
//
// A run reads N clips and writes ONCE (ADR 0070). The reads go one at a time,
// in timeline order — two engines on one machine would fight for the same
// cores, and two cloud calls in flight would bill in an order nobody chose —
// and every transcript that came back is applied in one `apply_transcripts`
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
// (`speech/autoCaptionEligibility.ts` folds it into the verdict). It stays the
// renderer's own flag, not the job registry's: it covers the preflight prompt
// and the write-back too, which are not jobs, and an AGENT transcribing some
// clip must not grey out the user's press — a press on the same clip simply
// joins that job (ADR 0121).
//
// Each read is tagged with a fresh `requestId`, which is how the run — and a
// surface showing it — finds the job its call started or joined in
// `compute/computeJobsStore.ts`: the job id is main's to mint, and a joined
// job's id is not this run's to know up front.

import { create } from "zustand";
import type { TranscriptionInputDecision } from "./transcriptionInput";

import { logMutationFailure, refusalText } from "../errors/tryMutate";
import i18n from "../i18n";
import { computeFailureText, computeResourceReason } from "../compute/computeRefusal";
import {
  applyTranscripts,
  ComputeCancelledError,
  logEmit,
  transcribeClip,
  type LogEntryInput,
  type TranscriptResult,
} from "../ipc";
import { jobIdForRequest, useComputeJobsStore } from "../compute/computeJobsStore";

interface TranscribeRunState {
  transcribing: boolean;
  /// The tag of the read in flight, or null — `useComputeJobForRequest` turns
  /// it into the job and its phase.
  requestId: string | null;
  /// The clips whose transcripts are being written as captions, or null. The
  /// write runs after every job has ended, so no job carries it: a surface
  /// shows these clips as `{ kind: 'applying' }`.
  applying: readonly string[] | null;
}

export const useTranscribeRunStore = create<TranscribeRunState>(() => ({
  transcribing: false,
  requestId: null,
  applying: null,
}));

export function setTranscribing(transcribing: boolean): void {
  useTranscribeRunStore.setState(transcribing ? { transcribing } : { transcribing, requestId: null, applying: null });
}

/// The job a tagged read ran under, for a row's `details` — absent when the
/// read never became a job (an unresolved clip is refused as a plain call).
function jobDetails(requestId: string): { job_id?: string } {
  const jobId = jobIdForRequest(useComputeJobsStore.getState(), requestId);
  return jobId === null ? {} : { job_id: jobId };
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
  projectId: string;
  compositionId: string;
  /// In the order they are read — the caller hands them over in timeline
  /// order (`transcribeSubjects`), already reduced to one subject per source.
  clips: readonly TranscribeClip[];
  /// Optional UI preflight. The in-flight guard covers the check and prompt;
  /// false cancels before inference, caption writes or a Started log row.
  confirmInput?: () => Promise<TranscriptionInputDecision>;
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
function failedRow(clip: TranscribeClip, err: unknown, requestId: string, opId: string | null): LogEntryInput {
  const raw = refusalText(err);
  // A resource refusal reads as its summary; the native sentence stays the
  // record, in `details` (`compute/computeRefusal.ts`).
  const reason = computeFailureText(i18n.t, "transcribe_clip", raw);
  const resource = computeResourceReason(raw) !== null;
  return {
    level: "error",
    ...ROW,
    message: `Transcribing ${clip.label} failed: ${raw}`,
    i18n_key: "log.auto_caption_failed",
    i18n_args: { clip: clip.label, reason },
    details: { context: "transcribe_clip", layer_id: clip.layerId, ...jobDetails(requestId), ...(resource ? { refusal: raw } : {}) },
    ...(opId === null ? {} : { op_id: opId, op_state: { state: "Err" } }),
  };
}

/// The clip whose job was cancelled — from the app's cancel button, or by the
/// agents that shared it. Not a failure, so `info` and `Ok`, the way an import
/// or export cancel closes its op (docs/status-log.md): the log has no
/// cancelled state, and an `Err` would count it as an error.
function cancelledRow(clip: TranscribeClip, jobId: string, opId: string | null): LogEntryInput {
  return {
    level: "info",
    ...ROW,
    message: `Transcribing ${clip.label} was cancelled`,
    i18n_key: "log.auto_caption_cancelled",
    i18n_args: { clip: clip.label },
    details: { context: "transcribe_clip", layer_id: clip.layerId, job_id: jobId },
    ...(opId === null ? {} : { op_id: opId, op_state: { state: "Ok" } }),
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
  let normalizeLayerIds: readonly string[] = [];
  if (target.confirmInput) {
    let proceed = false;
    try {
      const decision = await target.confirmInput();
      if (decision === false) return "";
      normalizeLayerIds = decision.normalizeLayerIds;
      proceed = true;
    } catch (err) {
      logMutationFailure(err, "transcription_input");
      return refusalText(err);
    } finally {
      if (!proceed) setTranscribing(false);
    }
  }
  const opId = crypto.randomUUID();
  void logEmit(startedRow(clips, opId));

  // The read half: one call per clip, in order, stopping at the first that
  // fails. No language hint goes on the wire, so the engine detects it.
  const transcripts: TranscriptResult[] = [];
  let failed: { clip: TranscribeClip; err: unknown; requestId: string } | null = null;
  for (const clip of clips) {
    const requestId = crypto.randomUUID();
    useTranscribeRunStore.setState({ requestId });
    try {
      const normalize = normalizeLayerIds.includes(clip.layerId);
      if (normalize) void logEmit({
        level: "info", ...ROW,
        message: `Transcription copy normalization requested: ${clip.label}`,
        i18n_key: "log.auto_caption_normalize_requested", i18n_args: { clip: clip.label },
        details: { context: "transcribe_clip", layer_id: clip.layerId, normalize_audio: true },
      });
      const result = await transcribeClip(
        clip.layerId,
        normalize ? { normalizeAudio: true, requestId } : { requestId },
      );
      transcripts.push(result);
      if (result.input_normalization) {
        const gain = result.input_normalization.gain_db.toFixed(1);
        void logEmit({
          level: "info", ...ROW,
          message: `Transcription copy gain for ${clip.label}: +${gain} dB`,
          i18n_key: "log.auto_caption_normalized", i18n_args: { clip: clip.label, gain },
          details: { context: "transcribe_clip", layer_id: clip.layerId, ...result.input_normalization },
        });
      }
    } catch (err) {
      // A cancel stops the run exactly as a failure does — the clips after it
      // are not read, the transcripts before it still land — and differs only
      // in the row that says so.
      failed = { clip, err, requestId };
      break;
    }
  }
  useTranscribeRunStore.setState({ requestId: null });

  // One write for all successful reads, retaining normalized word timing and
  // source identity with the caption layers. SRT would discard this evidence,
  // making later text correction unable to resegment after reopening a project.
  let applyError: unknown = null;
  if (transcripts.length > 0) {
    const layerIds = clips.slice(0, transcripts.length).map(c => c.layerId);
    useTranscribeRunStore.setState({ applying: layerIds });
    try {
      await applyTranscripts(transcripts, target.projectId, target.compositionId, layerIds);
    } catch (err) {
      applyError = err;
    } finally {
      useTranscribeRunStore.setState({ applying: null });
    }
  }

  // Exactly one row closes the op, whatever happened: the Started row above
  // otherwise never closes and the status bar keeps a transcription spinning
  // that has already ended. The write failure is that row when there is one
  // (it is the half that touches the project), else the clip that failed,
  // else the cues that landed.
  const landed = transcripts.length > 0 && applyError === null;
  const clean = failed === null && applyError === null;
  const cancelled = failed !== null && failed.err instanceof ComputeCancelledError ? failed.err : null;
  if (landed) void logEmit(doneRow(transcripts, clean ? opId : null));
  if (failed !== null) {
    const closer = applyError === null ? opId : null;
    void logEmit(cancelled !== null
      ? cancelledRow(failed.clip, cancelled.jobId, closer)
      : failedRow(failed.clip, failed.err, failed.requestId, closer));
  }
  if (applyError !== null) logMutationFailure(applyError, "apply_transcripts", opId);

  // Cleared before the reveal and on failure too, or the command stays greyed
  // for the rest of the session.
  setTranscribing(false);
  if (landed) target.revealCaptions();
  // A cancel has no remedy to open: the person asked for it.
  if (failed !== null) return cancelled !== null ? "" : refusalText(failed.err);
  if (applyError !== null) return refusalText(applyError);
  return "";
}
