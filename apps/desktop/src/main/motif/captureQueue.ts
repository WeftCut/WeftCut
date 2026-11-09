import { MotifFrameSkippedError } from './offscreenFrames.js'
import { motifSuperseded } from '../../shared/motifs/errors.js'
import type { MotifTuning } from '../../shared/motifs/tuning.js'
import type { MotifCaptureArgs, MotifFramePriority } from '../../shared/motifs/frameTransport.js'

export interface CaptureArgs extends MotifCaptureArgs {
  /// PNG captures only: the page still renders at width × height, and the
  /// image comes back scaled by this factor (MCP previews). Absent means 1.
  scale?: number
}

/** A capture's place in the queue. Only a queued capture moves or leaves it;
 * a running one finishes, and the caller drops what it no longer wants. */
export interface CaptureTicket {
  /// Moves a queued capture to the back of `priority`'s queue, down as well as
  /// up. A running one keeps the priority for a skipped frame's retry.
  setPriority(priority: MotifFramePriority): void
  /// Rejects a queued capture as superseded without rendering it.
  cancel(): void
}
export interface CaptureOptions {
  priority: MotifFramePriority
  /// Asked when a host could take the ticket, before it is leased, on every
  /// attempt (a skipped frame's retry too). False rejects the capture as
  /// superseded, uncounted and without a lease.
  wanted?: () => boolean
  /// Runs when the ticket reaches its host, before any page IO, on every
  /// attempt. A throw rejects the capture with that error.
  dispatch?: () => void
}
export interface CaptureRun<T> { result: Promise<T>; ticket: CaptureTicket }

/** A rendered frame: `delivered` settles once its paint is consumed. */
export interface Rendered<T> { delivered: Promise<T> }

/** What the queue holds while a ticket renders on a host. */
export interface HostLease { release(): void }

/** Where tickets render (`HostPool`). Keys are opaque to the queue: one key,
 * one host, one render step at a time on it. */
export interface HostSlots<L extends HostLease> {
  keyOf(args: CaptureArgs): string
  /// `ready`: the key's host can take a frame now (no render step on it, room
  /// among its frames in flight). `busy`: it cannot yet, or it is being
  /// replaced. `absent`: the key has no host.
  state(key: string): 'ready' | 'busy' | 'absent'
  /// A key without a host could have one now for a capture of `priority`
  /// queued at `queuedAt`: a slot is free, or a host whose key is not in
  /// `keep`, not rendering, and that the capture may take.
  canOpen(keep: ReadonlySet<string>, priority: MotifFramePriority, queuedAt: number): boolean
  /// Reserves the key's host, or a slot for it, until the lease is released;
  /// a host it replaces is never one in `keep`, and one a capture of
  /// `priority` may take.
  acquire(key: string, args: CaptureArgs, keep: ReadonlySet<string>, priority: MotifFramePriority, queuedAt: number): L
  /// Called whenever a host may have become available.
  onChange(listener: () => void): void
}

/** How the capturer counts and gates the queue's tickets. */
export interface CaptureQueueHooks {
  /// The error a ticket rejects with when it reaches its host, before it is
  /// counted (its lane failed while it waited); null to go on.
  refuse(args: CaptureArgs): unknown
  /// A ticket's first attempt began, `queuedMs` after it was queued.
  started(args: CaptureArgs, queuedMs: number): void
  /// One attempt settled after `captureMs`: its frame was consumed, skipped and
  /// queued again, or failed.
  settled(outcome: 'completed' | 'skipped' | 'failed', captureMs: number): void
  /// A ticket went ahead of an older one of its class by host affinity.
  affinityPick(): void
}

export type CaptureQueueTuning = Pick<MotifTuning, 'skippedFrameRetries' | 'backgroundAgingMs' | 'hostAffinityMs'>

type HostState = ReturnType<HostSlots<HostLease>['state']>

interface Ticket<L> {
  args: CaptureArgs
  priority: MotifFramePriority
  queuedAt: number
  wanted: (() => boolean) | undefined
  /// In its priority's queue, not running.
  queued: boolean
  /// Withdrawn by its caller: a skipped frame is not rendered again.
  cancelled: boolean
  /// Renders the ticket's frame on `lease`'s host and returns once it has
  /// committed; the ticket's own waiter settles when its paint is consumed.
  /// Must never throw (a throw would strand the lease).
  run: (lease: L) => Promise<void>
  /// Rejects the ticket without rendering it.
  fail: (error: unknown) => void
}

/** A queued ticket in dispatch order. */
interface Candidate<L> {
  ticket: Ticket<L>
  key: string
  /// An aged background ticket, ranked ahead of the foreground ones.
  aged: boolean
  /// Ranked ahead of an older ticket of its class whose Motif has no host.
  affinity: boolean
}

/** A host key whose tickets wait without a host. */
interface HostlessWait {
  /// When its Motif began waiting without a host.
  since: number
  /// When the last of its tickets left the queue; null while one is queued.
  goneAt: number | null
}

const PRIORITIES: readonly MotifFramePriority[] = ['current', 'ahead', 'background']

const settledTicket: CaptureTicket = { setPriority: () => {}, cancel: () => {} }

/** Orders every capture (preview, export, preparation, MCP) onto the capture
 * hosts. A ticket stays queued until a host can take its frame, so the order
 * is decided at each free slot and a ticket queued later can still go first.
 *
 * Rank: one FIFO queue per priority, `current` ahead of `ahead` ahead of
 * `background`; a `background` ticket waiting `backgroundAgingMs` gets one
 * frame between higher ones, so enabled background work cannot starve. Within
 * a class, a ticket whose Motif has no host counts its wait from when its
 * Motif began waiting without one, which a ticket cancelled and queued again
 * keeps (a scrub re-issues `current` every tick). Until that wait reaches
 * `hostAffinityMs`, the class's tickets whose Motif has a host go first: a
 * switch costs a window build and the replaced host's drain (ADR 0159). Then
 * it ranks as if queued when its Motif began waiting. Affinity never crosses a
 * class.
 *
 * Dispatch: the best-ranked ticket a host can take now goes. One whose host
 * cannot take a frame yet keeps that host from tickets ranked below it being
 * replaced, and the hosts it does not need go on serving the others. A host
 * takes a frame when it is not mid render step and has room among its frames
 * in flight. A running ticket is never preempted. So a `current` ticket whose
 * Motif has a host waits for the `current` tickets ahead of it (export frames
 * are `current` too), at most one aged background frame, the step in progress
 * and one paint on its host, and a resize drains that host's frames in flight
 * first. One whose Motif has none waits up to `hostAffinityMs`, then for the
 * replaced host to drain and a window build. */
export class CaptureQueue<L extends HostLease> {
  private readonly queues: Record<MotifFramePriority, Ticket<L>[]> = { current: [], ahead: [], background: [] }
  private pumping = false
  /// The last dispatch was an aged background ticket: the next one is not.
  private agedLast = false
  private renderingCount = 0
  /// Set by `close`: every ticket queued from then on rejects with it.
  private closed: { error: unknown } | null = null
  /// By host key, kept across a gap shorter than `hostAffinityMs` with none of
  /// its tickets queued; every queue change ranks, so the gap is seen as it
  /// opens.
  private readonly hostless = new Map<string, HostlessWait>()

  constructor(
    private readonly slots: HostSlots<L>,
    private readonly tuning: CaptureQueueTuning,
    private readonly hooks: CaptureQueueHooks,
  ) {
    slots.onChange(() => this.pump())
  }

  get queued(): number { return PRIORITIES.reduce((sum, priority) => sum + this.queues[priority].length, 0) }
  /// Tickets dispatched whose frame has not committed yet.
  get rendering(): number { return this.renderingCount }

  /** Queues a capture. `render` renders its frame on the leased host; a frame
   * the compositor skipped goes back to the head of its queue, as the same
   * ticket, up to `skippedFrameRetries` times. */
  enqueue<T>(args: CaptureArgs, render: (lease: L) => Promise<Rendered<T>>, { priority, wanted, dispatch }: CaptureOptions): CaptureRun<T> {
    const queuedAt = performance.now()
    let resolve!: (value: T) => void, reject!: (e: unknown) => void
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    const attempt = async (retries: number, lease: L): Promise<void> => {
      const refused = this.hooks.refuse(args)
      if (refused) { reject(refused); return }
      const started = performance.now()
      if (retries === 0) this.hooks.started(args, started - queuedAt)
      const finish = (error: unknown | null, value?: T) => {
        const captureMs = performance.now() - started
        if (error === null) { this.hooks.settled('completed', captureMs); resolve(value as T); return }
        if (error instanceof MotifFrameSkippedError && retries < this.tuning.skippedFrameRetries && !ticket.cancelled) {
          this.hooks.settled('skipped', captureMs)
          ticket.run = next => attempt(retries + 1, next)
          this.schedule(ticket, true)
          return
        }
        this.hooks.settled('failed', captureMs)
        reject(ticket.cancelled && error instanceof MotifFrameSkippedError ? motifSuperseded() : error)
      }
      try {
        dispatch?.()
        const { delivered } = await render(lease)
        delivered.then(value => finish(null, value), finish)
      } catch (e) { finish(e) }
    }
    const ticket: Ticket<L> = { args, priority, queuedAt, wanted, queued: false, cancelled: false, run: lease => attempt(0, lease), fail: reject }
    this.schedule(ticket)
    return {
      result,
      ticket: {
        setPriority: next => {
          if (next === ticket.priority) return
          if (!ticket.queued) { ticket.priority = next; return }
          this.unschedule(ticket)
          ticket.priority = next
          this.schedule(ticket)
        },
        cancel: () => {
          ticket.cancelled = true
          if (!ticket.queued) return
          this.unschedule(ticket)
          reject(motifSuperseded())
          // It may have kept a host from the tickets ranked below it.
          this.pump()
        },
      },
    }
  }

  /** A capture that settled before it was queued. */
  static rejected<T>(error: unknown): CaptureRun<T> {
    return { result: Promise.reject(error), ticket: settledTicket }
  }

  /** Rejects every queued ticket with `error` at once, and every ticket queued
   * from now on, a skipped frame's retry included. Running ones finish. */
  close(error: unknown): void {
    this.closed = { error }
    this.hostless.clear()
    for (const priority of PRIORITIES) {
      for (const ticket of this.queues[priority].splice(0)) {
        ticket.queued = false
        ticket.fail(error)
      }
    }
  }

  private schedule(t: Ticket<L>, first = false): void {
    if (this.closed) { t.fail(this.closed.error); return }
    const queue = this.queues[t.priority]
    if (first) queue.unshift(t)
    else queue.push(t)
    t.queued = true
    this.pump()
  }

  private unschedule(t: Ticket<L>): void {
    const queue = this.queues[t.priority]
    const i = queue.indexOf(t)
    if (i >= 0) queue.splice(i, 1)
    t.queued = false
  }

  /// Every queued ticket, best first (see the class comment).
  private ranked(now: number, stateOf: (key: string) => HostState): Candidate<L>[] {
    const queues = this.queues
    const affinityMs = this.tuning.hostAffinityMs
    const waiting = queues.background[0]
    const aged = !this.agedLast && waiting !== undefined && queues.current.length + queues.ahead.length > 0
      && now - waiting.queuedAt >= this.tuning.backgroundAgingMs
    const queuedKeys = new Set<string>()
    const ranked: Candidate<L>[] = []
    if (aged) {
      const key = this.slots.keyOf(waiting.args)
      queuedKeys.add(key)
      ranked.push({ ticket: waiting, key, aged: true, affinity: false })
    }
    for (const priority of PRIORITIES) {
      const hosted: Candidate<L>[] = []
      // Tickets whose Motif has no host, ranked from `at`: waited out, or
      // not yet.
      const due: { candidate: Candidate<L>; at: number }[] = []
      const later: { candidate: Candidate<L>; at: number }[] = []
      for (const ticket of queues[priority]) {
        if (aged && ticket === waiting) continue
        const key = this.slots.keyOf(ticket.args)
        queuedKeys.add(key)
        const candidate = { ticket, key, aged: false, affinity: false }
        if (stateOf(key) !== 'absent') {
          this.hostless.delete(key)
          hosted.push(candidate)
          continue
        }
        const since = this.hostlessSince(key, now)
        const ranking = { candidate, at: Math.min(ticket.queuedAt, since) }
        if (now - since < affinityMs) later.push(ranking)
        else due.push(ranking)
      }
      due.sort((a, b) => a.at - b.at)
      const oldestLater = later.reduce((oldest, l) => Math.min(oldest, l.at), Infinity)
      let d = 0
      for (const candidate of hosted) {
        while (d < due.length && due[d]!.at <= candidate.ticket.queuedAt) ranked.push(due[d++]!.candidate)
        candidate.affinity = oldestLater <= candidate.ticket.queuedAt
        ranked.push(candidate)
      }
      for (; d < due.length; d++) ranked.push(due[d]!.candidate)
      for (const { candidate } of later.sort((a, b) => a.at - b.at)) ranked.push(candidate)
    }
    for (const [key, wait] of this.hostless) {
      if (queuedKeys.has(key)) continue
      if (wait.goneAt === null) wait.goneAt = now
      else if (now - wait.goneAt >= affinityMs) this.hostless.delete(key)
    }
    return ranked
  }

  /// Since when `key`, absent and with a ticket queued, has waited for a host.
  private hostlessSince(key: string, now: number): number {
    let wait = this.hostless.get(key)
    if (!wait || (wait.goneAt !== null && now - wait.goneAt >= this.tuning.hostAffinityMs)) {
      wait = { since: now, goneAt: null }
      this.hostless.set(key, wait)
    }
    wait.goneAt = null
    return wait.since
  }

  /// The best-ranked ticket a host can take now, and the hosts it may not
  /// replace: those that better-ranked tickets wait for.
  private pick(): (Candidate<L> & { keep: ReadonlySet<string> }) | null {
    const states = new Map<string, HostState>()
    const stateOf = (key: string) => {
      let state = states.get(key)
      if (!state) { state = this.slots.state(key); states.set(key, state) }
      return state
    }
    const keep = new Set<string>()
    for (const candidate of this.ranked(performance.now(), stateOf)) {
      const state = stateOf(candidate.key)
      if (state === 'ready' || (state === 'absent' && this.slots.canOpen(keep, candidate.ticket.priority, candidate.ticket.queuedAt))) return { ...candidate, keep }
      if (state === 'busy') keep.add(candidate.key)
    }
    return null
  }

  private pump(): void {
    if (this.pumping) return // the running loop dispatches whatever lands behind it
    this.pumping = true
    try {
      for (;;) {
        const next = this.pick()
        if (!next) {
          if (this.queued === 0) this.agedLast = false
          return
        }
        const { ticket, key, keep } = next
        this.unschedule(ticket)
        let lease: L
        // Unscheduled, a ticket whose check or acquire throws would otherwise
        // never settle.
        try {
          // Before the lease: no host is held, nor a victim marked, for a
          // ticket nobody wants.
          if (ticket.wanted && !ticket.wanted()) { ticket.fail(motifSuperseded()); continue }
          lease = this.slots.acquire(key, ticket.args, keep, ticket.priority, ticket.queuedAt)
        } catch (e) { ticket.fail(e); continue }
        this.agedLast = next.aged
        if (next.affinity) this.hooks.affinityPick()
        void this.dispatch(ticket, lease)
      }
    } finally {
      this.pumping = false
    }
  }

  private async dispatch(ticket: Ticket<L>, lease: L): Promise<void> {
    this.renderingCount++
    try { await ticket.run(lease) } finally {
      this.renderingCount--
      lease.release()
    }
  }
}
