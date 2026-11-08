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
  /// Checked when the ticket reaches its host, before any page IO.
  isCurrent?: () => boolean
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
  /// `ready`: the key's host can take a frame now. `busy`: it is rendering (or
  /// being replaced). `absent`: the key has no host.
  state(key: string): 'ready' | 'busy' | 'absent'
  /// A key without a host could have one now: a slot is free or a host is idle.
  canOpen(): boolean
  /// Reserves the key's host, or a slot for it, until the lease is released.
  acquire(key: string, args: CaptureArgs): L
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
}

export type CaptureQueueTuning = Pick<MotifTuning, 'skippedFrameRetries' | 'backgroundAgingMs'>

interface Ticket<L> {
  args: CaptureArgs
  priority: MotifFramePriority
  queuedAt: number
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
const PRIORITIES: readonly MotifFramePriority[] = ['current', 'ahead', 'background']

const settledTicket: CaptureTicket = { setPriority: () => {}, cancel: () => {} }

/** Orders every capture (preview, export, preparation, MCP) onto the capture
 * hosts. One FIFO queue per priority: a `current` ticket dispatches ahead of
 * any queued `ahead` one, and both ahead of `background`, so lookahead and
 * preparation never hold the frame the user is looking at. A `background`
 * ticket waiting `backgroundAgingMs` gets one frame between higher ones, so
 * enabled background work cannot starve. A running ticket is never preempted.
 *
 * Dispatch is strictly in that order: the next ticket waits while its host is
 * rendering, or while every host is rendering and it has none, and holds back
 * every ticket behind it. A host's slot is held from dispatch until its frame
 * has committed, not until its paint: the next frame renders while earlier
 * ones are still on their way to the capture (ADR 0159). */
export class CaptureQueue<L extends HostLease> {
  private readonly queues: Record<MotifFramePriority, Ticket<L>[]> = { current: [], ahead: [], background: [] }
  private pumping = false
  /// The last dispatch was an aged background ticket: the next one is not.
  private agedLast = false
  private renderingCount = 0

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
  enqueue<T>(args: CaptureArgs, render: (lease: L) => Promise<Rendered<T>>, { priority, isCurrent = () => true }: CaptureOptions): CaptureRun<T> {
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
        if (!isCurrent()) throw motifSuperseded()
        const { delivered } = await render(lease)
        delivered.then(value => finish(null, value), finish)
      } catch (e) { finish(e) }
    }
    const ticket: Ticket<L> = { args, priority, queuedAt, queued: false, cancelled: false, run: lease => attempt(0, lease), fail: reject }
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
          // It may have held back the tickets behind it.
          this.pump()
        },
      },
    }
  }

  /** A capture that settled before it was queued. */
  static rejected<T>(error: unknown): CaptureRun<T> {
    return { result: Promise.reject(error), ticket: settledTicket }
  }

  private schedule(t: Ticket<L>, first = false): void {
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

  /// The ticket that dispatches next, and whether it is an aged background one.
  private next(): { ticket: Ticket<L>; aged: boolean } | null {
    const queues = this.queues
    const next = queues.current[0] ?? queues.ahead[0]
    const waiting = queues.background[0]
    const aged = !this.agedLast && next !== undefined && waiting !== undefined
      && performance.now() - waiting.queuedAt >= this.tuning.backgroundAgingMs
    const ticket = aged || !next ? waiting : next
    return ticket ? { ticket, aged } : null
  }

  private pump(): void {
    if (this.pumping) return // the running loop dispatches whatever lands behind it
    this.pumping = true
    try {
      for (;;) {
        const next = this.next()
        if (!next) { this.agedLast = false; return }
        const { ticket, aged } = next
        const key = this.slots.keyOf(ticket.args)
        const state = this.slots.state(key)
        if (state === 'busy' || (state === 'absent' && !this.slots.canOpen())) return
        this.unschedule(ticket)
        let lease: L
        // Unscheduled, a ticket whose acquire throws would otherwise never settle.
        try { lease = this.slots.acquire(key, ticket.args) } catch (e) { ticket.fail(e); continue }
        this.agedLast = aged
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
