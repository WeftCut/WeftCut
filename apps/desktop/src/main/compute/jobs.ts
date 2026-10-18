import { randomUUID } from 'node:crypto'
import { beginModelUse as defaultBeginModelUse } from '../model-usage'
import {
  COMPUTE_JOBS_EVENT, parsePhase, samePhase,
  type ComputeJob, type ComputeJobEnded, type ComputeJobsSnapshot, type ComputeJobsUpdate, type ComputeOutcome,
} from '../../shared/compute-jobs'
import type { ClipJobSpec } from './clipJob'

/** How often every waiting caller hears from a running job, at the least. */
export const HEARTBEAT_MS = 15_000

/** Why a caller's call answers "cancelled": it cancelled itself, the user
 *  cancelled the job from the app, or the native call reported it cancelled. */
export type CancelReason = 'caller' | 'user' | 'native'

/** A cancelled job's answer to a caller. Its message is the whole sentence an
 *  agent reads; `jobId` and `reason` are for the host's own mapping. */
export class ComputeCancelledError extends Error {
  constructor(readonly jobId: string, readonly reason: CancelReason) {
    super(reason === 'user'
      ? 'Cancelled in WeftCut by the user. Nothing was computed; calling again starts a new job.'
      : 'Cancelled. Nothing was computed; calling again starts a new job.')
    this.name = 'ComputeCancelledError'
  }
}

/** One caller of `run`. Every field is optional: a caller with none is a plain
 *  user call that waits for the answer.
 *
 *  `signal` aborts on an EXPLICIT cancel only, and `disconnected` when the
 *  caller's connection went away — the host tells the two apart (the SDK aborts
 *  a handler for both), because only the first may cancel work. */
export interface ComputeCaller {
  signal?: AbortSignal
  disconnected?: AbortSignal
  /** Called on attach, on every phase change and on every heartbeat, until this
   *  caller's promise settles. Disconnected callers still hear phases (their
   *  Activity row is still running) — sending anywhere is the callee's call. */
  onPhase?: (job: ComputeJob, cause: 'attach' | 'phase' | 'heartbeat') => void
  /** The agent's client name; absent = the person at the app. */
  client?: string
  /** The renderer's tag for a human call (`ComputeJob.request_ids`). */
  requestId?: string
}

export interface ComputeJobsDeps {
  /** `backend.mcpCallTool`: resolves with the tool's envelope JSON. */
  call: (tool: string, argsJson: string) => Promise<string>
  /** `backend.cancelComputeJob`: true when native found the job. */
  cancel: (jobId: string) => boolean
  /** Renderer publication (`emitToRenderer`). */
  send?: (event: string, payload: unknown) => void
  beginModelUse?: () => () => void
  newId?: () => string
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  heartbeatMs?: number
}

interface CallerEntry {
  caller: ComputeCaller
  state: 'attached' | 'disconnected'
  resolve: (envelope: string) => void
  reject: (err: unknown) => void
  detach: () => void
}

interface Entry {
  job: ComputeJob
  key: string
  callers: Set<CallerEntry>
  /** Callers that explicitly cancelled — what makes "nobody attached" a cancel. */
  cancels: number
  heartbeat: unknown
  settled: boolean
}

/** The clip-compute job registry (ADR 0121). One per app run, shared by the
 *  agent's MCP calls and the renderer's, so the same question about the same
 *  source span is ONE native job however many callers ask it (singleflight).
 *
 *  Every caller's promise settles exactly once — with the envelope JSON, the
 *  backend's rejection, or a `ComputeCancelledError`. A caller that cancels
 *  settles at once and detaches; the job itself is cancelled only when no
 *  caller is attached any more and at least one of them cancelled. A caller
 *  whose connection went away is not attached but does not cancel: the job runs
 *  on, its promise settles when the job does, and a retry joins. The UI's
 *  cancel (`cancel`) ends the job for everyone.
 *
 *  The model lease (`beginModelUse`) is held from the native call's start until
 *  the native call itself settles — after a cancel, the work is not over until
 *  native says so, whatever the callers were already told. */
export class ComputeJobs {
  private byId = new Map<string, Entry>()
  private byKey = new Map<string, Entry>()
  private revision = 0
  private ended: ComputeJobEnded[] = []
  private scheduled = false
  private readonly now: () => number
  private readonly heartbeatMs: number

  constructor(private deps: ComputeJobsDeps) {
    this.now = deps.now ?? Date.now
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
  }

  /** Run `spec` as a job, or join the running one with its key. Resolves with
   *  the tool's envelope JSON for the caller to unwrap. */
  run(spec: ClipJobSpec, caller: ComputeCaller = {}): Promise<string> {
    if (caller.signal?.aborted) return Promise.reject(new ComputeCancelledError('', 'caller'))
    const joined = this.byKey.get(spec.key)
    const entry = joined ?? this.start(spec, caller)
    return this.attach(entry, caller)
  }

  /** A native `compute:job_phase` payload. An unknown or ended job, or a phase
   *  this build does not know, is ignored. */
  phase(payload: unknown): void {
    const p = payload as { job_id?: unknown; phase?: unknown } | null
    if (!p || typeof p.job_id !== 'string') return
    const entry = this.byId.get(p.job_id)
    const phase = parsePhase(p.phase)
    if (!entry || entry.settled || !phase || samePhase(entry.job.phase, phase)) return
    entry.job.phase = phase
    entry.job.phase_since = this.iso()
    this.notify(entry, 'phase')
    this.publish()
  }

  /** Force-cancel for every caller — the app's cancel button. False when no
   *  such job is running. */
  cancel(jobId: string): boolean {
    const entry = this.byId.get(jobId)
    if (!entry || entry.settled) return false
    this.cancelJob(entry, 'user')
    return true
  }

  snapshot(): ComputeJobsSnapshot {
    return structuredClone({ revision: this.revision, jobs: this.records() })
  }

  private start(spec: ClipJobSpec, caller: ComputeCaller): Entry {
    const id = (this.deps.newId ?? randomUUID)()
    const at = this.iso()
    const job: ComputeJob = {
      job_id: id, tool: spec.tool, layer_id: spec.layer_id, media_id: spec.media_id, window: { ...spec.window },
      phase: { kind: 'queued', reason: null }, phase_since: at, started_at: at,
      origin: caller.client !== undefined ? { kind: 'agent', client: caller.client } : { kind: 'user' },
      callers: 0, caller_disconnected: false, request_ids: [],
    }
    const entry: Entry = { job, key: spec.key, callers: new Set(), cancels: 0, heartbeat: null, settled: false }
    this.byId.set(id, entry)
    this.byKey.set(spec.key, entry)
    entry.heartbeat = (this.deps.setInterval ?? defaultSetInterval)(() => this.notify(entry, 'heartbeat'), this.heartbeatMs)
    const release = (this.deps.beginModelUse ?? defaultBeginModelUse)()
    // Deferred one microtask so the first caller is attached before anything
    // can settle, and a synchronous throw from the call lands as a rejection.
    Promise.resolve()
      .then(() => this.deps.call(spec.tool, JSON.stringify({ ...spec.args, job_id: id })))
      .then((envelope) => this.finish(entry, envelope), (err: unknown) => this.fail(entry, err))
      .catch((err: unknown) => console.warn('[compute] settling a job threw', err))
      .finally(release)
    return entry
  }

  private attach(entry: Entry, caller: ComputeCaller): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onCancel = (): void => this.detach(entry, c, 'cancelled')
      const onGone = (): void => this.detach(entry, c, 'disconnected')
      const c: CallerEntry = {
        caller, state: 'attached', resolve, reject,
        detach: () => {
          caller.signal?.removeEventListener('abort', onCancel)
          caller.disconnected?.removeEventListener('abort', onGone)
        },
      }
      entry.callers.add(c)
      if (caller.requestId !== undefined && !entry.job.request_ids.includes(caller.requestId)) entry.job.request_ids.push(caller.requestId)
      caller.signal?.addEventListener('abort', onCancel, { once: true })
      caller.disconnected?.addEventListener('abort', onGone, { once: true })
      this.recount(entry)
      safely(() => caller.onPhase?.(structuredClone(entry.job), 'attach'))
      this.publish()
      // A connection already gone by the time it attached is gone now.
      if (caller.disconnected?.aborted) onGone()
    })
  }

  private detach(entry: Entry, c: CallerEntry, how: 'cancelled' | 'disconnected'): void {
    if (entry.settled || !entry.callers.has(c) || c.state !== 'attached') return
    if (how === 'cancelled') {
      entry.callers.delete(c)
      c.detach()
      entry.cancels++
      c.reject(new ComputeCancelledError(entry.job.job_id, 'caller'))
    } else {
      c.state = 'disconnected'
    }
    this.recount(entry)
    if (entry.job.callers === 0 && entry.cancels > 0) { this.cancelJob(entry, 'caller'); return }
    this.publish()
  }

  private cancelJob(entry: Entry, reason: CancelReason): void {
    // Native is told first: whatever it answers, the callers are told now, and
    // the lease stays held until the native call itself settles (`start`).
    try { this.deps.cancel(entry.job.job_id) } catch (err) { console.warn('[compute] native cancel threw', err) }
    this.settle(entry, 'cancelled', null, (c) => c.reject(new ComputeCancelledError(entry.job.job_id, reason)))
  }

  private finish(entry: Entry, envelope: string): void {
    if (entry.settled) return
    const error = envelopeError(envelope)
    if (error?.code === 'cancelled') {
      this.settle(entry, 'cancelled', null, (c) => c.reject(new ComputeCancelledError(entry.job.job_id, 'native')))
      return
    }
    this.settle(entry, error ? 'error' : 'ok', error?.message ?? null, (c) => c.resolve(envelope))
  }

  private fail(entry: Entry, err: unknown): void {
    if (entry.settled) return
    this.settle(entry, 'error', err instanceof Error ? err.message : String(err), (c) => c.reject(err))
  }

  /** End the job: out of both maps first, so a call arriving during the
   *  callbacks starts a fresh job rather than joining a finished one. */
  private settle(entry: Entry, outcome: ComputeOutcome, error: string | null, answer: (c: CallerEntry) => void): void {
    entry.settled = true
    this.byId.delete(entry.job.job_id)
    if (this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key)
    ;(this.deps.clearInterval ?? defaultClearInterval)(entry.heartbeat)
    const callers = [...entry.callers]
    entry.callers.clear()
    this.recount(entry)
    this.ended.push({ job: structuredClone(entry.job), outcome, error, ended_at: this.iso() })
    // Published BEFORE the callers are answered, so the update's microtask runs
    // ahead of their continuations: a renderer run reads its job's end from the
    // mirror once its own call returns, and both ride one ordered IPC pipe.
    this.publish()
    for (const c of callers) { c.detach(); answer(c) }
  }

  private notify(entry: Entry, cause: 'phase' | 'heartbeat'): void {
    if (entry.settled) return
    const job = structuredClone(entry.job)
    for (const c of entry.callers) safely(() => c.caller.onPhase?.(job, cause))
  }

  private recount(entry: Entry): void {
    let attached = 0, gone = 0
    for (const c of entry.callers) { if (c.state === 'attached') attached++; else gone++ }
    entry.job.callers = attached
    entry.job.caller_disconnected = gone > 0 && attached === 0
  }

  private records(): ComputeJob[] { return [...this.byId.values()].map((e) => e.job) }

  /** Coalesced to one update per turn: an extraction reports per frame. */
  private publish(): void {
    this.revision++
    if (this.scheduled || !this.deps.send) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const update: ComputeJobsUpdate = structuredClone({ revision: this.revision, jobs: this.records(), ended: this.ended })
      this.ended = []
      this.deps.send?.(COMPUTE_JOBS_EVENT, update)
    })
  }

  private iso(): string { return new Date(this.now()).toISOString() }
}

function envelopeError(envelope: string): { code?: string; message?: string } | null {
  try {
    const env = JSON.parse(envelope) as { ok?: boolean; error?: { code?: string; message?: string } }
    return env.ok === false ? env.error ?? {} : null
  } catch { return null }
}

/** A caller's callback must not break the job or the other callers. */
function safely(fn: () => void): void {
  try { fn() } catch (err) { console.warn('[compute] caller callback threw', err) }
}

function defaultSetInterval(fn: () => void, ms: number): unknown {
  const t = setInterval(fn, ms)
  // A heartbeat must never keep the process alive on its own.
  ;(t as { unref?: () => void }).unref?.()
  return t
}
function defaultClearInterval(handle: unknown): void { clearInterval(handle as ReturnType<typeof setInterval>) }
