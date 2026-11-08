import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureQueue, type CaptureArgs, type CaptureQueueHooks, type HostLease, type HostSlots } from './captureQueue'
import { MotifFrameSkippedError } from './offscreenFrames'
import { MotifError } from '../../shared/motifs/errors'
import type { MotifFramePriority } from '../../shared/motifs/frameTransport'

/// Host slots keyed by Motif id, `capacity` of them; a key without a host
/// replaces any idle one. Records which keys hold a lease at once.
class FakeSlots implements HostSlots<HostLease> {
  readonly hosts = new Map<string, { rendering: boolean }>()
  /// The most keys rendering at once.
  peak = 0
  private readonly listeners: (() => void)[] = []
  constructor(private readonly capacity = 1) {}
  keyOf(a: CaptureArgs) { return a.motifId }
  state(key: string) {
    const host = this.hosts.get(key)
    return !host ? 'absent' as const : host.rendering ? 'busy' as const : 'ready' as const
  }
  canOpen() { return this.hosts.size < this.capacity || [...this.hosts.values()].some(h => !h.rendering) }
  acquire(key: string) {
    let host = this.hosts.get(key)
    if (!host) {
      if (this.hosts.size >= this.capacity) this.hosts.delete([...this.hosts].find(([, h]) => !h.rendering)![0])
      host = { rendering: false }
      this.hosts.set(key, host)
    }
    if (host.rendering) throw new Error('leased twice')
    host.rendering = true
    this.peak = Math.max(this.peak, [...this.hosts.values()].filter(h => h.rendering).length)
    const leased = host
    return { release: () => { leased.rendering = false; for (const l of this.listeners) l() } }
  }
  onChange(listener: () => void) { this.listeners.push(listener) }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tuning = { skippedFrameRetries: 3, backgroundAgingMs: 2000 }
const argsOf = (motifId: string): CaptureArgs => ({ motifId, tSec: 0, propsJson: '{}', width: 32, height: 16, contentHash: 'v1' })

let slots: FakeSlots
let queue: CaptureQueue<HostLease>
/// Motif ids in the order their render step started.
let order: string[]
let counts: { started: number; completed: number; skipped: number; failed: number }
let refused: Map<string, Error>

function newQueue(capacity = 1) {
  slots = new FakeSlots(capacity)
  order = []
  counts = { started: 0, completed: 0, skipped: 0, failed: 0 }
  refused = new Map()
  const hooks: CaptureQueueHooks = {
    refuse: a => refused.get(a.motifId) ?? null,
    started: () => { counts.started++ },
    settled: outcome => { counts[outcome]++ },
  }
  queue = new CaptureQueue(slots, tuning, hooks)
}
beforeEach(() => newQueue())

interface Step {
  /// Held until it resolves: the render step occupies its host.
  hold?: Promise<unknown>
  /// The frame's paint: by default it arrives at once with the Motif id.
  delivered?: () => Promise<string>
  isCurrent?: () => boolean
}
/// Queues a capture whose render step records its Motif id.
const capture = (motifId: string, priority: MotifFramePriority, step: Step = {}) =>
  queue.enqueue(argsOf(motifId), async () => {
    order.push(motifId)
    await step.hold
    return { delivered: step.delivered?.() ?? Promise.resolve(motifId) }
  }, { priority, isCurrent: step.isCurrent })

describe('CaptureQueue', () => {
  it('serves queued captures current, then ahead, then background, never preempting a running one', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    const queued = [capture('background', 'background'), capture('ahead', 'ahead'), capture('current', 'current')]
    gate.resolve()
    await Promise.all([running, ...queued].map(r => r.result))
    expect(order).toEqual(['running', 'current', 'ahead', 'background'])
  })

  it('moves a queued capture up or down when its priority changes', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    const promoted = capture('promoted', 'background')
    const demoted = capture('demoted', 'current')
    const ahead = capture('ahead', 'ahead')
    promoted.ticket.setPriority('current')
    demoted.ticket.setPriority('background')
    gate.resolve()
    await Promise.all([running, promoted, demoted, ahead].map(r => r.result))
    expect(order).toEqual(['running', 'promoted', 'ahead', 'demoted'])
  })

  it('cancels a queued capture without rendering it', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    const queued = capture('queued', 'current')
    queued.ticket.cancel()
    await expect(queued.result).rejects.toMatchObject({ code: 'superseded' })
    gate.resolve()
    await running.result
    expect(order).toEqual(['running'])
  })

  it('a capture cancelled once it runs still answers', async () => {
    const gate = deferred()
    const running = capture('running', 'current', { hold: gate.promise })
    await vi.waitFor(() => expect(order).toEqual(['running']))
    running.ticket.cancel()
    running.ticket.setPriority('background')
    gate.resolve()
    await expect(running.result).resolves.toBe('running')
  })

  it('checks currency when the ticket reaches its host, before rendering', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    let current = true
    const stale = capture('stale', 'background', { isCurrent: () => current })
    current = false
    gate.resolve()
    await running.result
    await expect(stale.result).rejects.toMatchObject({ code: 'superseded' })
    expect(order).toEqual(['running'])
    expect(counts).toMatchObject({ started: 2, completed: 1, failed: 1 })
  })

  it('rejects a ticket the hooks refuse when it reaches its host, without counting it', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    const latched = capture('latched', 'background')
    refused.set('latched', new MotifError('content', 'latched while queued'))
    gate.resolve()
    await running.result
    await expect(latched.result).rejects.toThrow('latched while queued')
    expect(order).toEqual(['running'])
    expect(counts).toMatchObject({ started: 1, completed: 1, failed: 0 })
  })

  it('renders a skipped frame again as the same ticket, counting the skip', async () => {
    let paints = 0
    const skipFirst = () => ++paints === 1 ? Promise.reject(new MotifFrameSkippedError(1)) : Promise.resolve('skipping')
    const gate = deferred()
    const skipping = capture('skipping', 'ahead', { hold: gate.promise, delivered: skipFirst })
    const next = capture('next', 'ahead')
    gate.resolve()
    await expect(skipping.result).resolves.toBe('skipping')
    await next.result
    expect(order.filter(id => id === 'skipping')).toHaveLength(2)
    expect(counts).toMatchObject({ started: 2, completed: 2, skipped: 1, failed: 0 })
  })

  it('a skipped frame goes back ahead of its class', async () => {
    const paint = deferred<string>()
    const gate = deferred()
    let paints = 0
    const skipping = capture('skipping', 'ahead', { delivered: () => ++paints === 1 ? paint.promise : Promise.resolve('skipping') })
    await vi.waitFor(() => expect(order).toEqual(['skipping']))
    const blocker = capture('blocker', 'ahead', { hold: gate.promise })
    await vi.waitFor(() => expect(order).toEqual(['skipping', 'blocker']))
    const later = capture('later', 'ahead')
    paint.reject(new MotifFrameSkippedError(1))
    await Promise.resolve()
    gate.resolve()
    await Promise.all([skipping, blocker, later].map(r => r.result))
    expect(order).toEqual(['skipping', 'blocker', 'skipping', 'later'])
  })

  it('a frame skipped more than skippedFrameRetries times fails', async () => {
    const skipping = capture('skipping', 'current', { delivered: () => Promise.reject(new MotifFrameSkippedError(1)) })
    await expect(skipping.result).rejects.toBeInstanceOf(MotifFrameSkippedError)
    expect(order).toHaveLength(tuning.skippedFrameRetries + 1)
    expect(counts).toMatchObject({ started: 1, skipped: tuning.skippedFrameRetries, failed: 1 })
  })

  it('does not render a skipped frame again once its capture is cancelled', async () => {
    const paint = deferred<string>()
    const skipping = capture('skipping', 'current', { delivered: () => paint.promise })
    await vi.waitFor(() => expect(order).toEqual(['skipping']))
    skipping.ticket.cancel()
    paint.reject(new MotifFrameSkippedError(1))
    await expect(skipping.result).rejects.toMatchObject({ code: 'superseded' })
    await capture('next', 'background').result
    expect(order).toEqual(['skipping', 'next'])
  })

  it('a priority change keeps the time a capture has waited for aging', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      const running = capture('running', 'background', { hold: new Promise(r => setTimeout(r, 2500)) })
      await vi.advanceTimersByTimeAsync(1)
      const demoted = capture('demoted', 'current')
      const high = capture('high', 'current')
      demoted.ticket.setPriority('background')
      await vi.advanceTimersByTimeAsync(2501)
      await Promise.all([running, demoted, high].map(r => r.result))
      expect(order).toEqual(['running', 'demoted', 'high'])
    } finally { vi.useRealTimers() }
  })

  it('ages waiting background frames without letting an old batch monopolize foreground', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      const running = capture('running', 'background', { hold: new Promise(r => setTimeout(r, 2500)) })
      await vi.advanceTimersByTimeAsync(1)
      const queued = [
        capture('low-a', 'background'), capture('low-b', 'background'),
        // Background ages past `ahead` as well as `current`.
        capture('high-a', 'current'), capture('high-b', 'ahead'),
      ]
      await vi.advanceTimersByTimeAsync(2501)
      await Promise.all([running, ...queued].map(r => r.result))
      expect(order).toEqual(['running', 'low-a', 'high-a', 'low-b', 'high-b'])
    } finally { vi.useRealTimers() }
  })

  it('with one host, another Motif waits until the running render step returns', async () => {
    const gate = deferred()
    const first = capture('a', 'background', { hold: gate.promise })
    const other = capture('b', 'current')
    await Promise.resolve()
    expect(order).toEqual(['a'])
    expect(queue).toMatchObject({ queued: 1, rendering: 1 })
    gate.resolve()
    await Promise.all([first.result, other.result])
    expect(order).toEqual(['a', 'b'])
    expect(slots.peak).toBe(1)
  })

  it('with two hosts, different Motifs render at once and the same Motif waits for its host', async () => {
    newQueue(2)
    const gateA = deferred(), gateB = deferred()
    const a = capture('a', 'ahead', { hold: gateA.promise })
    const b = capture('b', 'ahead', { hold: gateB.promise })
    const a2 = capture('a', 'ahead')
    const c = capture('c', 'ahead')
    await Promise.resolve()
    expect(order).toEqual(['a', 'b'])
    expect(queue.rendering).toBe(2)
    // `a` again waits for its host, and `c`, behind it, waits too: dispatch
    // keeps arrival order.
    gateB.resolve()
    await b.result
    expect(order).toEqual(['a', 'b'])
    gateA.resolve()
    await Promise.all([a.result, a2.result, c.result])
    expect(order).toEqual(['a', 'b', 'a', 'c'])
    expect(slots.peak).toBe(2)
  })

  it('rejects a ticket whose host cannot be leased and dispatches the next', async () => {
    const acquire = slots.acquire.bind(slots)
    slots.acquire = (key: string) => {
      if (key === 'broken') throw new Error('no capture host slot is free')
      return acquire(key)
    }
    const broken = capture('broken', 'current')
    const next = capture('next', 'current')
    await expect(broken.result).rejects.toThrow('no capture host slot is free')
    await expect(next.result).resolves.toBe('next')
    expect(order).toEqual(['next'])
    expect(queue).toMatchObject({ queued: 0, rendering: 0 })
  })
})
