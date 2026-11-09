import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureQueue, type CaptureArgs, type CaptureQueueHooks, type HostLease, type HostSlots } from './captureQueue'
import { MotifFrameSkippedError } from './offscreenFrames'
import { MotifError, motifSuperseded } from '../../shared/motifs/errors'
import type { MotifFramePriority } from '../../shared/motifs/frameTransport'

/// Host slots keyed by Motif id, `capacity` of them; a key without a host
/// replaces the oldest one that is not rendering or kept. Records which keys
/// hold a lease at once.
class FakeSlots implements HostSlots<HostLease> {
  /// `full`: no room among its frames in flight.
  readonly hosts = new Map<string, { rendering: boolean; full: boolean }>()
  /// The most keys rendering at once.
  peak = 0
  private readonly listeners: (() => void)[] = []
  constructor(private readonly capacity = 1) {}
  keyOf(a: CaptureArgs) { return a.motifId }
  state(key: string) {
    const host = this.hosts.get(key)
    return !host ? 'absent' as const : host.rendering || host.full ? 'busy' as const : 'ready' as const
  }
  canOpen(keep: ReadonlySet<string>) { return this.hosts.size < this.capacity || this.victim(keep) !== undefined }
  acquire(key: string, _args: CaptureArgs, keep: ReadonlySet<string>) {
    let host = this.hosts.get(key)
    if (!host) {
      if (this.hosts.size >= this.capacity) this.hosts.delete(this.victim(keep)!)
      host = { rendering: false, full: false }
      this.hosts.set(key, host)
    }
    if (host.rendering) throw new Error('leased twice')
    host.rendering = true
    this.peak = Math.max(this.peak, [...this.hosts.values()].filter(h => h.rendering).length)
    const leased = host
    return { release: () => { leased.rendering = false; for (const l of this.listeners) l() } }
  }
  onChange(listener: () => void) { this.listeners.push(listener) }
  /// The key's host fills up with frames in flight, or a paint makes room.
  setFull(key: string, full: boolean) {
    this.hosts.get(key)!.full = full
    for (const l of this.listeners) l()
  }
  private victim(keep: ReadonlySet<string>) {
    return [...this.hosts].find(([key, h]) => !h.rendering && !keep.has(key))?.[0]
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/// Arrival order within a class unless a test asks for host affinity.
const tuning = { skippedFrameRetries: 3, backgroundAgingMs: 2000, hostAffinityMs: 0 }
const argsOf = (motifId: string): CaptureArgs => ({ motifId, tSec: 0, propsJson: '{}', width: 32, height: 16, contentHash: 'v1' })

let slots: FakeSlots
let queue: CaptureQueue<HostLease>
/// Motif ids in the order their render step started.
let order: string[]
let counts: { started: number; completed: number; skipped: number; failed: number; affinityPicks: number }
let refused: Map<string, Error>

function newQueue(capacity = 1, overrides: Partial<typeof tuning> = {}) {
  slots = new FakeSlots(capacity)
  order = []
  counts = { started: 0, completed: 0, skipped: 0, failed: 0, affinityPicks: 0 }
  refused = new Map()
  const hooks: CaptureQueueHooks = {
    refuse: a => refused.get(a.motifId) ?? null,
    started: () => { counts.started++ },
    settled: outcome => { counts[outcome]++ },
    affinityPick: () => { counts.affinityPicks++ },
  }
  queue = new CaptureQueue(slots, { ...tuning, ...overrides }, hooks)
}
beforeEach(() => newQueue())

interface Step {
  /// Held until it resolves: the render step occupies its host.
  hold?: Promise<unknown>
  /// The frame's paint: by default it arrives at once with the Motif id.
  delivered?: () => Promise<string>
  wanted?: () => boolean
  dispatch?: () => void
  /// Recorded in `order` instead of the Motif id.
  label?: string
}
/// Queues a capture whose render step records its Motif id.
const capture = (motifId: string, priority: MotifFramePriority, step: Step = {}) =>
  queue.enqueue(argsOf(motifId), async () => {
    order.push(step.label ?? motifId)
    await step.hold
    return { delivered: step.delivered?.() ?? Promise.resolve(motifId) }
  }, { priority, wanted: step.wanted, dispatch: step.dispatch })

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

  it('runs dispatch when the ticket reaches its host, before rendering', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    let current = true
    const stale = capture('stale', 'background', { dispatch: () => { if (!current) throw motifSuperseded() } })
    current = false
    gate.resolve()
    await running.result
    await expect(stale.result).rejects.toMatchObject({ code: 'superseded' })
    expect(order).toEqual(['running'])
    expect(counts).toMatchObject({ started: 2, completed: 1, failed: 1 })
  })

  it('asks wanted before leasing a host: an unwanted ticket rejects superseded, uncounted, replacing no host', async () => {
    const gate = deferred()
    const running = capture('running', 'background', { hold: gate.promise })
    let current = true
    const dispatch = vi.fn()
    const stale = capture('stale', 'background', { wanted: () => current, dispatch })
    current = false
    gate.resolve()
    await running.result
    await expect(stale.result).rejects.toMatchObject({ code: 'superseded' })
    expect(order).toEqual(['running'])
    expect(dispatch).not.toHaveBeenCalled()
    expect([...slots.hosts.keys()]).toEqual(['running'])
    expect(counts).toMatchObject({ started: 1, completed: 1, failed: 0 })
  })

  it('a skipped frame nobody wants by its retry rejects superseded without rendering again', async () => {
    let wanted = true, paints = 0
    const skipping = capture('skipping', 'current', {
      wanted: () => wanted,
      delivered: () => { wanted = false; return ++paints === 1 ? Promise.reject(new MotifFrameSkippedError(1)) : Promise.resolve('skipping') },
    })
    await expect(skipping.result).rejects.toMatchObject({ code: 'superseded' })
    expect(order).toEqual(['skipping'])
    expect(counts).toMatchObject({ started: 1, skipped: 1, failed: 0 })
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

  it('with two hosts, a ticket waiting for its busy host holds back no other host', async () => {
    newQueue(2)
    const gateA = deferred(), gateB = deferred()
    const a = capture('a', 'ahead', { hold: gateA.promise })
    const b = capture('b', 'ahead', { hold: gateB.promise })
    const a2 = capture('a', 'ahead')
    const c = capture('c', 'ahead')
    await Promise.resolve()
    expect(order).toEqual(['a', 'b'])
    expect(queue.rendering).toBe(2)
    // `a` again waits for its host; `c`, behind it, takes `b`'s host the
    // moment it is free, and never `a`'s.
    gateB.resolve()
    await b.result
    await c.result
    expect(order).toEqual(['a', 'b', 'c'])
    expect([...slots.hosts.keys()].sort()).toEqual(['a', 'c'])
    gateA.resolve()
    await Promise.all([a.result, a2.result])
    expect(order).toEqual(['a', 'b', 'c', 'a'])
    expect(slots.peak).toBe(2)
  })

  it('rejects a ticket whose host cannot be leased and dispatches the next', async () => {
    const acquire = slots.acquire.bind(slots)
    slots.acquire = (key, a, keep) => {
      if (key === 'broken') throw new Error('no capture host slot is free')
      return acquire(key, a, keep)
    }
    const broken = capture('broken', 'current')
    const next = capture('next', 'current')
    await expect(broken.result).rejects.toThrow('no capture host slot is free')
    await expect(next.result).resolves.toBe('next')
    expect(order).toEqual(['next'])
    expect(queue).toMatchObject({ queued: 0, rendering: 0 })
  })

  it('a current ticket queued last overtakes queued ahead ones at the next free slot', async () => {
    await capture('a', 'ahead').result
    // The host's frames in flight fill its pipeline: nothing leaves the queue.
    slots.setFull('a', true)
    const ahead = [capture('a', 'ahead', { label: 'ahead-1' }), capture('a', 'ahead', { label: 'ahead-2' })]
    const current = capture('a', 'current', { label: 'current' })
    await Promise.resolve()
    expect(order).toEqual(['a'])
    expect(queue.queued).toBe(3)
    // A paint makes room: the current ticket goes first.
    slots.setFull('a', false)
    await Promise.all([current, ...ahead].map(r => r.result))
    expect(order).toEqual(['a', 'current', 'ahead-1', 'ahead-2'])
  })

  describe('host affinity', () => {
    /// Holds `motifId`'s host in a render step until the returned gate opens.
    const occupy = (motifId: string) => {
      const gate = deferred()
      const run = capture(motifId, 'ahead', { hold: gate.promise })
      return { run, open: () => { gate.resolve(); return run.result } }
    }

    it('a ticket whose Motif has a host goes before an older one of its class whose Motif has none', async () => {
      newQueue(1, { hostAffinityMs: 10_000 })
      const held = occupy('a')
      const other = capture('b', 'ahead')
      const same = capture('a', 'ahead')
      await held.open()
      await Promise.all([other.result, same.result])
      expect(order).toEqual(['a', 'a', 'b'])
      expect(counts.affinityPicks).toBe(1)
    })

    it('a ticket without a host goes in arrival order once its Motif has waited hostAffinityMs', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
      try {
        newQueue(1, { hostAffinityMs: 100 })
        const first = occupy('a')
        const other = capture('b', 'ahead')
        const gate = deferred()
        const second = capture('a', 'ahead', { hold: gate.promise })
        await vi.advanceTimersByTimeAsync(50)
        // Within the window the host's own ticket goes first, and it keeps
        // coming.
        await first.open()
        expect(order).toEqual(['a', 'a'])
        const third = capture('a', 'ahead')
        await vi.advanceTimersByTimeAsync(60)
        // Past it, `b` goes before the younger ticket of the host's Motif.
        gate.resolve()
        await Promise.all([second.result, other.result, third.result])
        expect(order).toEqual(['a', 'a', 'b', 'a'])
        expect(counts.affinityPicks).toBe(1)
      } finally { vi.useRealTimers() }
    })

    it('a scrub re-issuing both Motifs\' current tickets still serves the one without a host within hostAffinityMs and one render step', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
      try {
        newQueue(1, { hostAffinityMs: 100 })
        // A render step outlasts a scrub tick, so `a` always has a ticket
        // queued when its host frees.
        const stepMs = 40, tickMs = 16
        const served: Record<string, number[]> = { a: [], b: [] }
        const queued = new Map<string, { ticket: { cancel(): void } }>()
        const issue = (id: string) => {
          queued.get(id)?.ticket.cancel()
          const run = queue.enqueue(argsOf(id), async () => {
            served[id]!.push(performance.now())
            await new Promise(resolve => setTimeout(resolve, stepMs))
            return { delivered: Promise.resolve(id) }
          }, { priority: 'current' })
          run.result.catch(() => {})
          queued.set(id, run)
        }
        await capture('a', 'current').result
        const start = performance.now()
        for (let tick = 0; tick < 40 && served.b!.length === 0; tick++) {
          issue('a'); issue('b')
          await vi.advanceTimersByTimeAsync(tickMs)
        }
        expect(served.a!.length).toBeGreaterThan(1)
        expect(served.b!.length).toBe(1)
        expect(served.b![0]! - start).toBeLessThanOrEqual(100 + stepMs)
      } finally { vi.useRealTimers() }
    })

    it('a Motif none of whose tickets was queued for hostAffinityMs starts its wait again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
      try {
        newQueue(1, { hostAffinityMs: 100 })
        const held = occupy('a')
        const dropped = capture('b', 'ahead')
        dropped.ticket.cancel()
        await expect(dropped.result).rejects.toMatchObject({ code: 'superseded' })
        await vi.advanceTimersByTimeAsync(150)
        const other = capture('b', 'ahead')
        const same = capture('a', 'ahead')
        await vi.advanceTimersByTimeAsync(10)
        await held.open()
        await Promise.all([other.result, same.result])
        expect(order).toEqual(['a', 'a', 'b'])
      } finally { vi.useRealTimers() }
    })

    it('never crosses a class: a current ticket without a host goes before ahead ones with a host', async () => {
      newQueue(1, { hostAffinityMs: 10_000 })
      const held = occupy('a')
      const other = capture('b', 'current')
      const same = capture('a', 'ahead')
      await held.open()
      await Promise.all([other.result, same.result])
      expect(order).toEqual(['a', 'b', 'a'])
      expect(counts.affinityPicks).toBe(0)
    })

    it('hostAffinityMs=0 keeps arrival order', async () => {
      const held = occupy('a')
      const other = capture('b', 'ahead')
      const same = capture('a', 'ahead')
      await held.open()
      await Promise.all([other.result, same.result])
      expect(order).toEqual(['a', 'b', 'a'])
      expect(counts.affinityPicks).toBe(0)
    })

    it('a ticket waiting for its full host keeps a younger one of another Motif from replacing it', async () => {
      await capture('a', 'ahead').result
      slots.setFull('a', true)
      const same = capture('a', 'ahead')
      const other = capture('b', 'ahead')
      await Promise.resolve()
      expect(order).toEqual(['a'])
      slots.setFull('a', false)
      await Promise.all([same.result, other.result])
      expect(order).toEqual(['a', 'a', 'b'])
    })
  })

  it('a throwing dispatch rejects the capture with its error, without rendering', async () => {
    const refusal = new MotifError('capacity', 'no room for the capture')
    const refused = capture('refused', 'current', { dispatch: () => { throw refusal } })
    const next = capture('next', 'current')
    await expect(refused.result).rejects.toMatchObject({ code: 'capacity' })
    await expect(next.result).resolves.toBe('next')
    expect(order).toEqual(['next'])
    expect(queue).toMatchObject({ queued: 0, rendering: 0 })
  })

  it('dispatch runs again on a skipped frame\'s retry', async () => {
    let dispatches = 0, paints = 0
    const skipping = capture('skipping', 'ahead', {
      dispatch: () => { dispatches++ },
      delivered: () => ++paints === 1 ? Promise.reject(new MotifFrameSkippedError(1)) : Promise.resolve('skipping'),
    })
    await expect(skipping.result).resolves.toBe('skipping')
    expect(dispatches).toBe(2)
  })

  it('close rejects every queued ticket at once, and later ones; a running one finishes', async () => {
    const gate = deferred()
    const running = capture('running', 'ahead', { hold: gate.promise })
    const queued = [capture('a', 'current'), capture('b', 'background')]
    queue.close(new MotifError('closed', 'shut down'))
    for (const r of queued) await expect(r.result).rejects.toMatchObject({ code: 'closed' })
    expect(queue.queued).toBe(0)
    await expect(capture('later', 'current').result).rejects.toMatchObject({ code: 'closed' })
    gate.resolve()
    await expect(running.result).resolves.toBe('running')
    expect(order).toEqual(['running'])
  })
})
