// apps/desktop/src/main/state/derivative-jobs.ts
//
// The background derivative jobs, as an agent reads them. A pool item's paths
// say what is READY; what is being made, and what failed and why, only the
// native job events say (`media:job_started` / `media:job_complete` /
// `media:job_error`, `native/src/jobs/mod.rs`). Those events reach main and
// the renderer, never an MCP session, so main keeps the last one per media and
// job here. The media card, the `project://media` rows, `import_media` and
// every `DerivativeNotReady` refusal read it (docs/mcp.md, constraint 4).
//
// Shot detection is not a job: `analyze_clip` and `auto_split_by_shot` run it
// inside the call that needs it, so nothing waits on it and it has no state.
import type { MediaItem } from './model'

/** The derivatives an import makes, by the name the card uses. */
export type DerivativeName = 'waveform' | 'conform' | 'thumbnails' | 'proxy'
/** `pending` = not started (queued, or waiting for a route decision);
 *  `running` = its job has started, admission wait included. */
export type DerivativeState = 'pending' | 'running' | 'ready' | { failed: string }
export type DerivativeStates = Partial<Record<DerivativeName, DerivativeState>>

type JobState = 'running' | 'complete' | { failed: string }
/** The native job kinds that make a card's derivative (`jobs::JobKind`). */
const TRACKED = new Set(['waveform', 'conform', 'thumbnails', 'proxy', 'quick_proxy'])
const jobs = new Map<string, JobState>()
const key = (mediaId: string, kind: string) => `${mediaId}\n${kind}`
/** A reason is the job's own error text; a whole ffmpeg log is cut. */
const REASON_MAX = 300

/** When a retry may find a derivative that is not ready yet. */
export const DERIVATIVE_RETRY_AFTER_S = { pending: 10, running: 5 } as const

/** Fold one native event into the registry. Events of other kinds, and the
 *  ones this module does not track, are ignored. */
export function recordDerivativeJob(event: string, payload: unknown): void {
  const p = payload as { media_id?: unknown; kind?: unknown; error?: unknown } | null
  if (typeof p?.media_id !== 'string' || typeof p.kind !== 'string' || !TRACKED.has(p.kind)) return
  const k = key(p.media_id, p.kind)
  if (event === 'media:job_started') jobs.set(k, 'running')
  else if (event === 'media:job_complete') jobs.set(k, 'complete')
  else if (event === 'media:job_error') {
    const text = typeof p.error === 'string' && p.error.trim() ? p.error.trim() : 'the job failed without a reason'
    jobs.set(k, { failed: text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text })
  }
}

/** A project switch: the jobs of the outgoing project no longer report. */
export function resetDerivativeJobs(): void { jobs.clear() }

function fromJobs(mediaId: string, ...kinds: string[]): DerivativeState {
  const states = kinds.map((k) => jobs.get(key(mediaId, k)))
  const failed = states.find((s): s is { failed: string } => typeof s === 'object')
  if (failed) return failed
  if (states.includes('running')) return 'running'
  return 'pending'
}

/** One state per derivative the item gets. A path on the item is ready;
 *  otherwise the last job event decides. A still or a subtitle file has none,
 *  and a source that plays as it is (decode route `bypass`) has no proxy. */
export function derivativeStates(item: MediaItem): DerivativeStates {
  const out: DerivativeStates = {}
  const audio = item.kind === 'Audio' || item.metadata.audio != null
  if (audio) {
    out.waveform = item.waveform_path ? 'ready' : fromJobs(item.id, 'waveform')
    out.conform = item.conform_path ? 'ready' : fromJobs(item.id, 'conform')
  }
  if (item.kind === 'Video') {
    out.thumbnails = item.thumbnails_dir ? 'ready' : fromJobs(item.id, 'thumbnails')
    const r = item.decode_route
    if (r.route === 'direct-export') out.proxy = r.quick_proxy ? 'ready' : fromJobs(item.id, 'quick_proxy')
    else if (r.route !== 'bypass') out.proxy = r.full_proxy ? 'ready' : fromJobs(item.id, 'proxy', 'quick_proxy')
  }
  return out
}

/** Whether a re-import should run the item's jobs again. */
export function hasFailedDerivative(item: MediaItem): boolean {
  return Object.values(derivativeStates(item)).some((s) => typeof s === 'object')
}

/** The native readers name the derivative they could not find. */
const READER_NAME: Record<string, DerivativeName> = { waveform: 'waveform', thumbnail: 'thumbnails', thumbnails: 'thumbnails' }

/** A reader's `DerivativeNotReady` refusal, said with the job's state: the
 *  reader saw only that the file is missing. `state` and `retry_after_s` join
 *  the data; a failed job is said as failed, with its reason, because waiting
 *  will not make it appear. Anything else comes back unchanged. */
export function withDerivativeState(err: { message: string; data?: unknown }): { message: string; data?: unknown } {
  const d = err.data as { error?: unknown; media_id?: unknown; derivative?: unknown } | undefined
  if (d?.error !== 'DerivativeNotReady' || typeof d.media_id !== 'string' || typeof d.derivative !== 'string') return err
  const derivative = READER_NAME[d.derivative] ?? d.derivative
  const kinds = derivative === 'proxy' ? ['proxy', 'quick_proxy'] : [derivative]
  // The file is missing, so a job that reported complete made a file that is
  // gone since (a cache sweep): pending, like one never run.
  const state = fromJobs(d.media_id, ...kinds)
  if (typeof state === 'object') {
    return {
      message: `${derivative} failed for media ${d.media_id}: ${state.failed} — waiting will not make it; fix the cause, then call import_media with the same file to run the job again`,
      data: { ...d, derivative, state: 'failed', reason: state.failed, retry_after_s: null },
    }
  }
  return { message: err.message, data: { ...d, derivative, state, retry_after_s: state === 'ready' ? null : DERIVATIVE_RETRY_AFTER_S[state] } }
}
