/** Runs while the caller still holds its pixels, then returns the step that
 * encodes and stores them after the caller has let go. */
export type FrameRead = () => Promise<() => Promise<void>>

export interface QueuedWrite { written: Promise<void> }

/** Stored frames leave the capture lease here (ADR 0158). A frame holds one of
 * `slots` from before its pixels are read until its file is written, so the
 * slots bound the frames of pixels held (`writeSlots`). `wait` is for a frame
 * someone asked to keep: waiting inside the lease is the backpressure on
 * capture. `skip` is for a frame that can be captured again. One write per
 * address is `MotifFrameJobs`' rule (ADR 0160), not this queue's. */
export class MotifFrameWriteQueue {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(slots: number) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error('Invalid Motif write slot count')
    this.free = slots
  }

  /** Rejects when `read` does; a slot is free again by then. `written` rejects
   * when encoding or storing fails. */
  offer(mode: 'wait', read: FrameRead): Promise<QueuedWrite>
  offer(mode: 'skip', read: FrameRead): Promise<QueuedWrite | null>
  async offer(mode: 'wait' | 'skip', read: FrameRead): Promise<QueuedWrite | null> {
    if (mode === 'skip' && this.free === 0) return null
    await this.takeSlot()
    let store: () => Promise<void>
    try { store = await read() }
    catch (error) { this.giveSlot(); throw error }
    const written = Promise.resolve().then(store).finally(() => this.giveSlot())
    // A caller that has moved on may never look at the outcome.
    written.catch(() => {})
    return { written }
  }

  private takeSlot(): Promise<void> {
    if (this.free > 0) { this.free--; return Promise.resolve() }
    return new Promise(resolve => this.waiting.push(resolve))
  }

  /** The next waiter inherits the slot, so `free` stays 0 while anyone waits. */
  private giveSlot(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free++
  }
}
