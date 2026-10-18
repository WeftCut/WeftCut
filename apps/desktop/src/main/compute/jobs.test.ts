// The clip-compute registry's contract (ADR 0121), against a fake native call:
// singleflight join, the explicit-cancel / disconnect split, the UI's force
// cancel, phase propagation, the heartbeat, one settlement per caller, and the
// model lease held for the native call's life.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeCancelledError, ComputeJobs, HEARTBEAT_MS, type ComputeCaller } from './jobs'
import type { ClipJobSpec } from './clipJob'
import { COMPUTE_JOBS_EVENT, type ComputeJobsUpdate } from '../../shared/compute-jobs'

const OK = '{"ok":true,"result":{"content":[{"type":"text","text":"{}"}]}}'
const CANCELLED = '{"ok":false,"error":{"code":"cancelled","message":"Cancelled"}}'

function spec(key = 'k1', over: Partial<ClipJobSpec> = {}): ClipJobSpec {
  return { tool: 'transcribe_clip', key, args: { layer_id: 'l1' }, layer_id: 'l1', media_id: 'm1', window: { t_start_us: 0, t_end_us: 10 }, ...over }
}

/** A registry over a native call the test resolves by hand. */
function harness() {
  const pending: Array<{ tool: string; args: Record<string, unknown>; resolve: (s: string) => void; reject: (e: unknown) => void }> = []
  const call = vi.fn((tool: string, argsJson: string) => new Promise<string>((resolve, reject) => {
    pending.push({ tool, args: JSON.parse(argsJson) as Record<string, unknown>, resolve, reject })
  }))
  const cancel = vi.fn((_id: string) => true)
  const send = vi.fn()
  let leases = 0
  const beginModelUse = vi.fn(() => { leases++; return () => { leases-- } })
  let n = 0, tick = 0
  // Every read of the clock is a second later, so a changed time is visible.
  const jobs = new ComputeJobs({ call, cancel, send, beginModelUse, newId: () => `job-${++n}`, now: () => Date.UTC(2026, 0, 1) + 1000 * tick++ })
  return { jobs, call, cancel, send, pending, beginModelUse, leases: () => leases }
}

/** A run whose settlement is recorded rather than awaited. */
function track(p: Promise<string>) {
  const r = { settled: 0, value: undefined as string | undefined, error: undefined as unknown }
  p.then((v) => { r.settled++; r.value = v }, (e: unknown) => { r.settled++; r.error = e })
  return r
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function caller(over: ComputeCaller = {}) {
  const cancel = new AbortController(), gone = new AbortController()
  const onPhase = vi.fn()
  return { cancel, gone, onPhase, caller: { signal: cancel.signal, disconnected: gone.signal, onPhase, ...over } satisfies ComputeCaller }
}

afterEach(() => { vi.useRealTimers() })

describe('singleflight', () => {
  it('joins the same key into one native call with the job id injected', async () => {
    const h = harness()
    const a = track(h.jobs.run(spec(), { client: 'claude' }))
    const b = track(h.jobs.run(spec(), { requestId: 'req-1' }))
    await flush()
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.pending[0]!.args).toEqual({ layer_id: 'l1', job_id: 'job-1' })
    const [job] = h.jobs.snapshot().jobs
    expect(job).toMatchObject({ job_id: 'job-1', callers: 2, origin: { kind: 'agent', client: 'claude' }, request_ids: ['req-1'], phase: { kind: 'queued', reason: null } })
    h.pending[0]!.resolve(OK)
    await flush()
    expect([a.value, b.value]).toEqual([OK, OK])
    expect(h.jobs.snapshot().jobs).toEqual([])
  })

  it('runs different keys as different jobs, and a finished key afresh', async () => {
    const h = harness()
    void h.jobs.run(spec('a'))
    void h.jobs.run(spec('b'))
    await flush()
    expect(h.call).toHaveBeenCalledTimes(2)
    h.pending[0]!.resolve(OK)
    await flush()
    void h.jobs.run(spec('a'))
    await flush()
    expect(h.call).toHaveBeenCalledTimes(3)
    expect(h.pending[2]!.args.job_id).toBe('job-3')
  })

  it('a user caller with no client is origin user', async () => {
    const h = harness()
    void h.jobs.run(spec())
    expect(h.jobs.snapshot().jobs[0]!.origin).toEqual({ kind: 'user' })
  })
})

describe('cancel and disconnect', () => {
  it('the last attached caller cancelling cancels native and settles at once', async () => {
    const h = harness()
    const c = caller()
    const r = track(h.jobs.run(spec(), c.caller))
    await flush()
    c.cancel.abort()
    await flush()
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith('job-1')
    expect(r.error).toBeInstanceOf(ComputeCancelledError)
    expect((r.error as ComputeCancelledError).reason).toBe('caller')
    expect(h.jobs.snapshot().jobs).toEqual([])
  })

  it('one of two callers cancelling detaches it and leaves the job running', async () => {
    const h = harness()
    const a = caller(), b = caller()
    const ra = track(h.jobs.run(spec(), a.caller))
    const rb = track(h.jobs.run(spec(), b.caller))
    await flush()
    a.cancel.abort()
    await flush()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(ra.error).toBeInstanceOf(ComputeCancelledError)
    expect(h.jobs.snapshot().jobs[0]!.callers).toBe(1)
    h.pending[0]!.resolve(OK)
    await flush()
    expect(rb.value).toBe(OK)
    expect(ra.settled).toBe(1)
  })

  it('a disconnect does not cancel: the job runs on and its caller settles with it', async () => {
    const h = harness()
    const c = caller()
    const r = track(h.jobs.run(spec(), c.caller))
    await flush()
    c.gone.abort()
    await flush()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(r.settled).toBe(0)
    expect(h.jobs.snapshot().jobs[0]).toMatchObject({ callers: 0, caller_disconnected: true })
    // A retry joins the job that kept running.
    const retry = track(h.jobs.run(spec()))
    expect(h.jobs.snapshot().jobs[0]).toMatchObject({ callers: 1, caller_disconnected: false })
    h.pending[0]!.resolve(OK)
    await flush()
    expect(h.call).toHaveBeenCalledTimes(1)
    expect([r.value, retry.value]).toEqual([OK, OK])
  })

  it('cancels when nobody is attached and someone cancelled, even if others merely left', async () => {
    const h = harness()
    const gone = caller(), cancelling = caller()
    const rg = track(h.jobs.run(spec(), gone.caller))
    const rc = track(h.jobs.run(spec(), cancelling.caller))
    await flush()
    gone.gone.abort()
    await flush()
    expect(h.cancel).not.toHaveBeenCalled()
    cancelling.cancel.abort()
    await flush()
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(rc.error).toBeInstanceOf(ComputeCancelledError)
    expect(rg.error).toBeInstanceOf(ComputeCancelledError)
  })

  it('a caller already cancelled never starts a job', async () => {
    const h = harness()
    const c = caller()
    c.cancel.abort()
    await expect(h.jobs.run(spec(), c.caller)).rejects.toBeInstanceOf(ComputeCancelledError)
    await flush()
    expect(h.call).not.toHaveBeenCalled()
  })

  it('force-cancels for everyone, attached or disconnected, with reason user', async () => {
    const h = harness()
    const a = caller(), b = caller()
    const ra = track(h.jobs.run(spec(), a.caller))
    const rb = track(h.jobs.run(spec(), b.caller))
    await flush()
    b.gone.abort()
    expect(h.jobs.cancel('job-1')).toBe(true)
    await flush()
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith('job-1')
    for (const r of [ra, rb]) {
      expect(r.error).toBeInstanceOf(ComputeCancelledError)
      expect((r.error as ComputeCancelledError).reason).toBe('user')
    }
    expect(h.jobs.cancel('job-1')).toBe(false)
    expect(h.jobs.cancel('nope')).toBe(false)
  })

  it('still answers every caller when native does not know the job', async () => {
    const h = harness()
    h.cancel.mockReturnValue(false)
    const r = track(h.jobs.run(spec()))
    await flush()
    expect(h.jobs.cancel('job-1')).toBe(true)
    await flush()
    expect(r.error).toBeInstanceOf(ComputeCancelledError)
  })

  it('reads a native cancelled envelope as a cancel', async () => {
    const h = harness()
    const r = track(h.jobs.run(spec()))
    await flush()
    h.pending[0]!.resolve(CANCELLED)
    await flush()
    expect((r.error as ComputeCancelledError).reason).toBe('native')
  })
})

describe('settlement', () => {
  it('settles every caller exactly once, whatever arrives after', async () => {
    const h = harness()
    const a = caller(), b = caller()
    const ra = track(h.jobs.run(spec(), a.caller))
    const rb = track(h.jobs.run(spec(), b.caller))
    await flush()
    h.jobs.cancel('job-1')
    a.cancel.abort()
    b.gone.abort()
    h.pending[0]!.resolve(OK)
    await flush()
    expect([ra.settled, rb.settled]).toEqual([1, 1])
  })

  it('a refusal envelope resolves for each caller to unwrap; a rejection rejects', async () => {
    const h = harness()
    const refused = '{"ok":false,"error":{"code":"invalid_params","message":"no such layer"}}'
    const r1 = track(h.jobs.run(spec('a')))
    const r2 = track(h.jobs.run(spec('b')))
    await flush()
    h.pending[0]!.resolve(refused)
    h.pending[1]!.reject(new Error('engine crashed'))
    await flush()
    expect(r1.value).toBe(refused)
    expect((r2.error as Error).message).toBe('engine crashed')
  })

  it('a synchronous throw from the native call is a rejection, not a crash', async () => {
    const jobs = new ComputeJobs({ call: () => { throw new Error('boom') }, cancel: () => false, beginModelUse: () => () => {} })
    await expect(jobs.run(spec())).rejects.toThrow('boom')
  })

  it('publishes the running set, and each end with its outcome, before answering callers', async () => {
    const h = harness()
    let seenAtAnswer: number | null = null
    const p = h.jobs.run(spec(), { requestId: 'r' })
    void p.then(() => { seenAtAnswer = h.send.mock.calls.length })
    await flush()
    expect(h.send).toHaveBeenCalledWith(COMPUTE_JOBS_EVENT, expect.objectContaining({ jobs: [expect.objectContaining({ job_id: 'job-1' })] }))
    const before = h.send.mock.calls.length
    h.pending[0]!.resolve(OK)
    await flush()
    const last = h.send.mock.calls.at(-1)![1] as ComputeJobsUpdate
    expect(last.jobs).toEqual([])
    expect(last.ended).toEqual([expect.objectContaining({ outcome: 'ok', error: null, job: expect.objectContaining({ job_id: 'job-1', request_ids: ['r'] }) })])
    expect(seenAtAnswer).toBe(before + 1)
  })
})

describe('phases', () => {
  it('propagates native phases to the record and to every waiting caller', async () => {
    const h = harness()
    const a = caller(), b = caller()
    void h.jobs.run(spec(), a.caller)
    void h.jobs.run(spec(), b.caller)
    expect(a.onPhase).toHaveBeenCalledWith(expect.objectContaining({ phase: { kind: 'queued', reason: null } }), 'attach')
    const since = h.jobs.snapshot().jobs[0]!.phase_since
    h.jobs.phase({ job_id: 'job-1', phase: { kind: 'extracting', done: 1, total: 4 } })
    const job = h.jobs.snapshot().jobs[0]!
    expect(job.phase).toEqual({ kind: 'extracting', done: 1, total: 4 })
    expect(job.phase_since).not.toBe(since)
    for (const c of [a, b]) expect(c.onPhase).toHaveBeenLastCalledWith(expect.objectContaining({ phase: job.phase }), 'phase')
    // A repeat, an unknown job and an unknown kind change nothing.
    a.onPhase.mockClear()
    h.jobs.phase({ job_id: 'job-1', phase: { kind: 'extracting', done: 1, total: 4 } })
    h.jobs.phase({ job_id: 'job-9', phase: { kind: 'loading_model' } })
    h.jobs.phase({ job_id: 'job-1', phase: { kind: 'teleporting' } })
    expect(a.onPhase).not.toHaveBeenCalled()
    h.jobs.phase({ job_id: 'job-1', phase: { kind: 'queued', reason: 'memory' } })
    expect(h.jobs.snapshot().jobs[0]!.phase).toEqual({ kind: 'queued', reason: 'memory' })
  })

  it('heartbeats every waiting caller until the job settles', async () => {
    vi.useFakeTimers()
    const h = harness()
    const c = caller()
    void h.jobs.run(spec(), c.caller).catch(() => {})
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(c.onPhase.mock.calls.filter(([, cause]) => cause === 'heartbeat')).toHaveLength(2)
    h.pending[0]!.resolve(OK)
    await vi.advanceTimersByTimeAsync(0)
    c.onPhase.mockClear()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(c.onPhase).not.toHaveBeenCalled()
  })
})

describe('the model lease', () => {
  it('is one per job, held until the native call itself settles — even after a cancel', async () => {
    const h = harness()
    void h.jobs.run(spec()).catch(() => {})
    void h.jobs.run(spec()).catch(() => {})
    await flush()
    expect(h.beginModelUse).toHaveBeenCalledTimes(1)
    expect(h.leases()).toBe(1)
    h.jobs.cancel('job-1')
    await flush()
    expect(h.leases()).toBe(1)
    h.pending[0]!.resolve(CANCELLED)
    await flush()
    expect(h.leases()).toBe(0)
  })
})
