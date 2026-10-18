/** Clip-compute jobs (`transcribe_clip` / `describe_clip`): one record per
 *  piece of native work, however many callers wait on it (ADR 0121). Runtime
 *  only — never project state, never persisted. Main owns the registry
 *  (`main/compute/jobs.ts`); the renderer mirrors it (`renderer/compute/`). */

/** Why a queued job is still waiting for admission — Phase 02's wire tags
 *  (ADR 0120). `null` = not told yet: every job starts here, before native has
 *  said anything, so no job is ever phase-less. */
export type ComputeQueueReason = 'memory' | 'finalization' | 'budget' | null

/** Where a job is. `extracting` counts sampled frames for a description and
 *  goes 0/1 → 1/1 for a transcription's audio slice; `inferring` carries counts
 *  only where the engine reports them, never estimated. `applying` is the human
 *  transcription's write-back, which runs after the job has ended — the
 *  registry never sets it; it is here so a surface that shows the whole run has
 *  one vocabulary. */
export type ComputePhase =
  | { kind: 'queued'; reason: ComputeQueueReason }
  | { kind: 'extracting'; done: number; total: number }
  | { kind: 'normalizing' }
  | { kind: 'loading_model' }
  | { kind: 'inferring'; done?: number; total?: number }
  | { kind: 'applying' }

export type ComputeTool = 'transcribe_clip' | 'describe_clip'
export const COMPUTE_TOOLS: ReadonlySet<string> = new Set<ComputeTool>(['transcribe_clip', 'describe_clip'])

/** Who started the job: the person at the app, or an agent by its client name.
 *  A job keeps the origin of its FIRST caller; later joiners only count. */
export type ComputeOrigin = { kind: 'user' } | { kind: 'agent'; client: string }

export interface ComputeJob {
  job_id: string
  tool: ComputeTool
  /** The layer the first caller named. A caller on another layer over the same
   *  source span joins this job without changing it. */
  layer_id: string
  media_id: string
  /** Timeline µs — the window the first caller asked for, or the layer's own
   *  span when it named none. */
  window: { t_start_us: number; t_end_us: number }
  phase: ComputePhase
  /** ISO time the phase last changed, counts included — what a stall reads. */
  phase_since: string
  started_at: string
  origin: ComputeOrigin
  /** Callers still waiting on the result. A caller that disconnected or
   *  cancelled is not counted. */
  callers: number
  /** At least one caller's connection went away and nobody is waiting any
   *  more: the work runs on (a retry joins it), but no one will read it yet. */
  caller_disconnected: boolean
  /** The renderer's own tags for the human calls attached to this job — how a
   *  run learns the id of a job it may have JOINED rather than started. */
  request_ids: string[]
}

export type ComputeOutcome = 'ok' | 'error' | 'cancelled'

/** A job that ended since the previous update: its last record and how it
 *  ended. `error` is the failure's message (`null` unless `outcome` is
 *  `error`). */
export interface ComputeJobEnded {
  job: ComputeJob
  outcome: ComputeOutcome
  error: string | null
  ended_at: string
}

/** Every running job. `revision` only grows, for the whole app run. */
export interface ComputeJobsSnapshot {
  revision: number
  jobs: ComputeJob[]
}

/** The full running set again (it is small) plus whatever ended since the last
 *  update, so a mirror needs no gap repair. */
export interface ComputeJobsUpdate extends ComputeJobsSnapshot {
  ended: ComputeJobEnded[]
}

export const COMPUTE_JOBS_EVENT = 'compute_jobs:changed'
/** `backend:invoke` channels, served by main's registry. */
export const COMPUTE_JOBS_SNAPSHOT_CHANNEL = 'compute_jobs_snapshot'
/** `{ job_id }` → boolean: force-cancel for every caller (the UI's button). */
export const COMPUTE_JOB_CANCEL_CHANNEL = 'compute_job_cancel'
/** Host-only arg the renderer adds to a clip-compute call; main strips it. */
export const COMPUTE_REQUEST_ID_ARG = 'request_id'
/** What the renderer's clip-compute channel answers for a cancelled job, in
 *  place of the tool's payload: a cancel is not a failure, and a thrown
 *  Error's identity does not survive Electron's `invoke`. */
export const COMPUTE_CANCELLED_FIELD = 'compute_cancelled'
export interface ComputeCancelledPayload { [COMPUTE_CANCELLED_FIELD]: { job_id: string } }

/** The phase as a translatable label: the same key + args form log rows carry.
 *  Keys live under `compute.phase.*`. */
export function phaseLabel(phase: ComputePhase): { i18n_key: string; i18n_args?: Record<string, string | number> } {
  switch (phase.kind) {
    case 'queued':
      return phase.reason === null
        ? { i18n_key: 'compute.phase.queued' }
        : { i18n_key: `compute.phase.queued_${phase.reason}` }
    case 'extracting':
      return { i18n_key: 'compute.phase.extracting', i18n_args: { done: phase.done, total: phase.total } }
    case 'inferring':
      return phase.done !== undefined && phase.total !== undefined
        ? { i18n_key: 'compute.phase.inferring_counted', i18n_args: { done: phase.done, total: phase.total } }
        : { i18n_key: 'compute.phase.inferring' }
    default:
      return { i18n_key: `compute.phase.${phase.kind}` }
  }
}

const QUEUED_TEXT: Record<Exclude<ComputeQueueReason, null>, string> = {
  memory: 'Queued: waiting for memory',
  finalization: 'Queued: waiting for an export to finish',
  budget: 'Queued: waiting for CPU/memory budget',
}

/** The phase in canonical English — the MCP progress `message`, and the
 *  fallback a surface shows without a translation. */
export function phaseText(phase: ComputePhase): string {
  switch (phase.kind) {
    case 'queued': return phase.reason === null ? 'Queued' : QUEUED_TEXT[phase.reason]
    case 'extracting': return `Extracting ${phase.done}/${phase.total}`
    case 'normalizing': return 'Normalizing audio'
    case 'loading_model': return 'Loading model'
    case 'inferring':
      return phase.done !== undefined && phase.total !== undefined ? `Inferring ${phase.done}/${phase.total}` : 'Inferring'
    case 'applying': return 'Applying'
  }
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined

/** A native `compute:job_phase` phase → a `ComputePhase`, or null when it is
 *  not one (an unknown kind from a newer core). Only the fields of its kind
 *  survive; an unknown queue reason reads as "not told". */
export function parsePhase(raw: unknown): ComputePhase | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  switch (p.kind) {
    case 'queued': {
      const r = p.reason
      return { kind: 'queued', reason: r === 'memory' || r === 'finalization' || r === 'budget' ? r : null }
    }
    case 'extracting': return { kind: 'extracting', done: count(p.done) ?? 0, total: count(p.total) ?? 0 }
    case 'normalizing': return { kind: 'normalizing' }
    case 'loading_model': return { kind: 'loading_model' }
    case 'inferring': {
      const done = count(p.done), total = count(p.total)
      return { kind: 'inferring', ...(done === undefined ? {} : { done }), ...(total === undefined ? {} : { total }) }
    }
    default: return null
  }
}

export function samePhase(a: ComputePhase, b: ComputePhase): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
