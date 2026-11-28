// apps/desktop/src/main/companion/polledViewer.ts
//
// A companion viewer that is asked rather than written to: a view that reaches
// the app only through tool calls polls for the events a page's stream would
// carry. One serves every such view; each keeps its own place in the sequence.
// It counts as a viewer (`CompanionHub.watch`) while it is polled, and stops
// counting once nobody has polled it for a while.
import { randomUUID } from 'node:crypto'
import type { CompanionEventName } from '../../shared/companion.js'

/** How long after the last poll the viewer keeps counting as one: a view
 *  that closed without a word stops the editor's transport pushes after this. */
export const POLL_LEASE_MS = 30_000
/** The longest a poll with nothing new is held before it answers empty. A
 *  host may run a view's calls one at a time, so a longer hold would delay
 *  its controls by as much. */
export const POLL_HOLD_MS = 1000
/** Events kept for views that have not asked yet. A view further behind is
 *  told to read the state afresh. */
export const POLL_BUFFER_EVENTS = 256

export interface PolledEvent { name: CompanionEventName; data: unknown }

/** `seq` is the place to ask from next, within `stream`. `reset`: the view's
 *  place is not in this stream (a first poll, a restarted app, a view too far
 *  behind), so it reads the state again and continues from `seq`. */
export interface PollAnswer {
  stream: string
  seq: number
  events: PolledEvent[]
  reset?: true
}

export interface PollTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export class PolledViewer {
  /** Changes whenever events may have been missed: at start, and once the
   *  lease ended and nothing was recorded. */
  private stream = randomUUID()
  private seq = 0
  private buffered: Array<PolledEvent & { seq: number }> = []
  private unwatch: (() => void) | null = null
  private lease: unknown = null
  private readonly held = new Set<() => void>()

  /** `watch` is the hub's: it counts this viewer until the returned close. */
  constructor(
    private readonly watch: (viewer: { send(name: CompanionEventName, data: unknown): void }) => () => void,
    private readonly timers: PollTimers = globalThis as unknown as PollTimers,
  ) {}

  /** The events after `since` in `stream`, held up to `POLL_HOLD_MS` while
   *  there are none. */
  poll(since: number | undefined, stream: string | undefined): Promise<PollAnswer> {
    this.renew()
    const floor = this.buffered.length > 0 ? this.buffered[0]!.seq - 1 : this.seq
    if (stream !== this.stream || since === undefined || since < floor || since > this.seq) {
      return Promise.resolve({ stream: this.stream, seq: this.seq, events: [], reset: true })
    }
    if (since < this.seq) return Promise.resolve(this.after(since))
    return new Promise((resolve) => {
      const answer = (): void => {
        this.held.delete(answer)
        this.timers.clearTimeout(timer)
        // The hold counts as being polled: the lease runs from its answer.
        this.renew()
        resolve(this.after(since))
      }
      const timer = this.timers.setTimeout(answer, POLL_HOLD_MS)
      this.held.add(answer)
    })
  }

  private send(name: CompanionEventName, data: unknown): void {
    this.buffered.push({ seq: ++this.seq, name, data })
    if (this.buffered.length > POLL_BUFFER_EVENTS) this.buffered.splice(0, this.buffered.length - POLL_BUFFER_EVENTS)
    for (const answer of [...this.held]) answer()
  }

  private after(since: number): PollAnswer {
    const events = this.buffered.filter((e) => e.seq > since).map(({ name, data }) => ({ name, data }))
    return { stream: this.stream, seq: this.seq, events }
  }

  private renew(): void {
    if (this.unwatch === null) this.unwatch = this.watch({ send: (name, data) => { this.send(name, data) } })
    if (this.lease !== null) this.timers.clearTimeout(this.lease)
    this.lease = this.timers.setTimeout(() => { this.expire() }, POLL_LEASE_MS)
  }

  private expire(): void {
    this.lease = null
    this.unwatch?.()
    this.unwatch = null
    // Nothing is recorded from here on, so a view coming back has missed
    // whatever happened meanwhile.
    this.buffered = []
    this.stream = randomUUID()
  }
}
