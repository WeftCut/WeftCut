// The completion notice for a long clip-compute job: once a transcription or
// description a person started (or joined) ends, say so — the person pressed
// it minutes ago and may be looking at another panel, or another app.
//
// Where it goes follows the export notice (`app/useExportFlow.ts`): the OS
// notification while the window is unfocused, the one place a person working
// in another app sees. While it is focused the app has no toast of its own, so
// the notice is a small non-modal card (`ComputeJobNotice.tsx`) reading the
// one slot below — the latest notice replaces the one before it.
//
// Which jobs: a person's (`origin` user, or any `request_ids` — a press that
// joined an agent's job). An agent-only job is the agent's to report; its
// Activity row already shows the end, and an agent sweeping thirty shots would
// otherwise post thirty notices.
//
// A cancel the person just pressed in this window gets no notice: they know.
// One pressed elsewhere (another window's Activity row) or by the job's other
// callers does.

import { create } from "zustand";
import type { TFunction } from "i18next";
import i18n from "../i18n";
import { sendNotification } from "@/bridge/notification";
import { cancelComputeJob, type ComputeJob, type ComputeJobEnded } from "../ipc";
import { layerDisplayName } from "../lib/layerName";
import { useProjectStore } from "../state/projectStore";
import { useComputeJobsStore, type ComputeJobsState } from "./computeJobsStore";
import { computeFailureText, computeResourceReason, settingsCanHelp } from "./computeRefusal";

/// A job shorter than this ended while the person was still looking at it: the
/// surface they pressed already shows the result, and a notice would only
/// interrupt. Twenty seconds is about how long a person waits on a spinner
/// before turning to something else — and a short clip's description, the
/// common case, stays under it.
export const NOTICE_MIN_RUN_MS = 20_000;

// ---- Cancels pressed in this window ----

/// Job ids this window's Cancel buttons cancelled. Bounded by the ended list's
/// lifetime: an id is dropped once its job's notice has been decided.
const cancelledHere = new Set<string>();

/// The UI's force-cancel, remembering that THIS window asked, so the job's end
/// is not announced back to the person who just pressed Cancel.
export async function cancelComputeJobHere(jobId: string): Promise<boolean> {
  cancelledHere.add(jobId);
  try {
    const cancelled = await cancelComputeJob(jobId);
    // False: it had already ended, so whatever ended it was not this press.
    if (!cancelled) cancelledHere.delete(jobId);
    return cancelled;
  } catch (err) {
    cancelledHere.delete(jobId);
    throw err;
  }
}

export const wasCancelledHere = (jobId: string): boolean => cancelledHere.has(jobId);

// ---- What a notice says ----

export interface ComputeJobNoticeContent {
  /// The ended job's id — the card's key, so a newer notice remounts it.
  jobId: string;
  outcome: ComputeJobEnded["outcome"];
  title: string;
  body: string;
  /// A resource refusal a Performance setting can help with: the card offers
  /// the pane (`computeRefusal.ts`).
  settings?: true;
}

/// Whether a person waits on this job: they started it, or a press of theirs
/// joined it.
export const isPersonsJob = (job: ComputeJob): boolean =>
  job.origin.kind === "user" || job.request_ids.length > 0;

/// How long the job ran, start to end.
export function jobRunMs(ended: ComputeJobEnded): number {
  const start = Date.parse(ended.job.started_at);
  const end = Date.parse(ended.ended_at);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/// The notice for one ended job, or null when it gets none: someone else's
/// job, a short one, or a cancel this window pressed. Pure.
export function computeJobNotice(
  t: TFunction,
  ended: ComputeJobEnded,
  ctx: { clip: string; cancelledHere: boolean },
): ComputeJobNoticeContent | null {
  if (!isPersonsJob(ended.job)) return null;
  if (jobRunMs(ended) < NOTICE_MIN_RUN_MS) return null;
  if (ended.outcome === "cancelled" && ctx.cancelledHere) return null;
  const tool = ended.job.tool === "transcribe_clip" ? "transcribe" : "describe";
  const clip = ctx.clip;
  const base = { jobId: ended.job.job_id, outcome: ended.outcome };
  switch (ended.outcome) {
    case "ok":
      return { ...base, title: t(`compute.ui.notice_${tool}_done_title`), body: t(`compute.ui.notice_${tool}_done_body`, { clip }) };
    case "error": {
      // A resource refusal reads as its summary, not the native sentence.
      const raw = ended.error ?? "";
      const reason = computeResourceReason(raw);
      return {
        ...base,
        title: t(`compute.ui.notice_${tool}_failed_title`),
        body: t(`compute.ui.notice_${tool}_failed_body`, { clip, reason: computeFailureText(t, ended.job.tool, raw) }),
        ...(reason !== null && settingsCanHelp(reason) ? { settings: true as const } : {}),
      };
    }
    case "cancelled":
      return { ...base, title: t(`compute.ui.notice_${tool}_cancelled_title`), body: t(`compute.ui.notice_${tool}_cancelled_body`, { clip }) };
  }
}

/// The clip a job read, by the name its Activity row and the status bar pill
/// give it; the source's name when the layer has gone since.
function clipLabel(t: TFunction, job: ComputeJob): string {
  const { layerById, mediaById } = useProjectStore.getState();
  const layer = layerById.get(job.layer_id);
  if (layer) return layerDisplayName(layer, t);
  return mediaById.get(job.media_id)?.label ?? t("kinds.videoclip");
}

// ---- The in-app slot ----

interface ComputeJobNoticeState {
  notice: ComputeJobNoticeContent | null;
}

export const useComputeJobNoticeStore = create<ComputeJobNoticeState>(() => ({ notice: null }));

export function dismissComputeJobNotice(jobId?: string): void {
  useComputeJobNoticeStore.setState((s) =>
    jobId === undefined || s.notice?.jobId === jobId ? { notice: null } : s,
  );
}

// ---- Wiring ----

export interface ComputeJobNoticeDeps {
  /// Whether this window has focus. `document.hasFocus()`: the window bridge's
  /// `isFocused` has no backend and always answers true.
  isFocused?: () => boolean;
  notifyOs?: (opts: { title: string; body: string }) => void;
  t?: TFunction;
}

/// Watch the job mirror for jobs that end, and announce the long ones. Jobs
/// that ended before wiring are not announced. Mounted once, beside the
/// mirror's own wiring (`app/useAppWiring.ts`).
export function wireComputeJobNotices(deps: ComputeJobNoticeDeps = {}): () => void {
  const isFocused = deps.isFocused ?? (() => document.hasFocus());
  const notifyOs = deps.notifyOs ?? sendNotification;
  const t = deps.t ?? (i18n.t.bind(i18n) as TFunction);
  const seen = new Set(useComputeJobsStore.getState().ended.map((e) => e.job.job_id));

  const announce = (state: ComputeJobsState): void => {
    for (const ended of state.ended) {
      const id = ended.job.job_id;
      if (seen.has(id)) continue;
      seen.add(id);
      const notice = computeJobNotice(t, ended, { clip: clipLabel(t, ended.job), cancelledHere: wasCancelledHere(id) });
      cancelledHere.delete(id);
      if (notice === null) continue;
      if (isFocused()) useComputeJobNoticeStore.setState({ notice });
      else notifyOs({ title: notice.title, body: notice.body });
    }
    // Bounded like the ended list itself.
    if (seen.size > state.ended.length * 2 + 16) {
      const live = new Set(state.ended.map((e) => e.job.job_id));
      for (const id of seen) if (!live.has(id)) seen.delete(id);
    }
  };

  return useComputeJobsStore.subscribe((state, prev) => {
    if (state.ended !== prev.ended) announce(state);
  });
}
