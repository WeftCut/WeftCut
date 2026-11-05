import type { MotifCacheAddress } from '../../shared/motifs/frameTransport'

/** Runs while the caller still holds its pixels, then returns the step that
 * encodes and stores them after the caller has let go. */
export type FrameRead = () => Promise<() => Promise<void>>

export interface QueuedWrite { written: Promise<void> }

/** Two writes hold at most two frames of pixels: one encoding, one behind it.
 * Encoding outruns capture, so a third frame would only be memory. */
const WRITE_SLOTS = 2

/** Stored frames leave the capture lease here (ADR 0158). A frame holds a slot
 * from before its pixels are read until its file is written, and one address
 * has one write per store. `wait` is for a frame someone asked to keep: waiting
 * inside the lease is the backpressure on capture. `skip` is for a frame that
 * can be captured again. */
export class MotifFrameWriteQueue {
  private free = WRITE_SLOTS
  private readonly waiting: (() => void)[] = []
  private readonly writes = new WeakMap<object, Map<string, Promise<void>>>()

  inFlight(store: object, address: MotifCacheAddress): Promise<void> | undefined {
    return this.writes.get(store)?.get(addressKey(address))
  }

  /** Rejects when `read` does; a slot is free again by then. `written` rejects
   * when encoding or storing fails. */
  offer(store: object, address: MotifCacheAddress, mode: 'wait', read: FrameRead): Promise<QueuedWrite>
  offer(store: object, address: MotifCacheAddress, mode: 'skip', read: FrameRead): Promise<QueuedWrite | null>
  async offer(store: object, address: MotifCacheAddress, mode: 'wait' | 'skip', read: FrameRead): Promise<QueuedWrite | null> {
    const joined = this.inFlight(store, address)
    if (joined) return { written: joined }
    if (mode === 'skip' && this.free === 0) return null

    let writes = this.writes.get(store)
    if (!writes) this.writes.set(store, writes = new Map())
    const key = addressKey(address)
    let resolve!: () => void, reject!: (error: unknown) => void
    const written = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    // A caller that has moved on may never look at the outcome.
    written.catch(() => {})
    writes.set(key, written)
    // Leave the map before settling: a waiter that retries must not join this write.
    const finish = () => { writes.delete(key); this.giveSlot() }

    await this.takeSlot()
    let store_: () => Promise<void>
    try { store_ = await read() }
    catch (error) { finish(); reject(error); throw error }
    void Promise.resolve().then(store_).then(
      () => { finish(); resolve() },
      error => { finish(); reject(error) },
    )
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

const addressKey = (address: MotifCacheAddress) => `${address.hash}:${address.frame}`
