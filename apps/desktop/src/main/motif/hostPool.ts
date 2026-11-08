import { MotifError } from '../../shared/motifs/errors.js'
import type { CaptureArgs, HostLease, HostSlots } from './captureQueue.js'

/** What a capture host shows: one Motif content version, as shared textures
 * or bitmaps. A host never changes key. */
export interface HostKey { motifId: string; contentHash: string; texture: boolean }

/** The part of a capture host (`CaptureHost`) the pool manages. */
export interface PooledHost {
  readonly retired: boolean
  readonly framesInFlight: number
  /** Room for another frame in flight. */
  readonly hasRoom: boolean
  readonly size: { width: number; height: number }
  /** Settles once every frame rendered on the host has its paint. */
  drain(): Promise<void>
  /** Closes the host; its frames in flight fail. */
  retire(): void
  /** Calls `listener` after each frame in flight settles. */
  onFrameSettled(listener: () => void): void
}

export interface HostPoolDeps<H extends PooledHost> {
  /// Hosts open at once (tuning `captureHosts`).
  capacity: number
  hostKeyOf(args: CaptureArgs): HostKey
  /// Opens a host for `key`, sized to `args`.
  open(key: HostKey, args: CaptureArgs): Promise<H>
  /// A host was retired to make room for another key.
  evicted(): void
}

export interface HostPoolLease<H extends PooledHost> extends HostLease {
  /** The key's host, opened once a host it replaces has drained and retired.
   * It may have retired by the time it is used: ask again. */
  host(args: CaptureArgs): Promise<H>
}

interface Slot<H> {
  /// The key the slot was leased under. Its host's own key differs only after
  /// a texture switch reopened it; `release` re-keys the slot then.
  key: string
  hostKey: HostKey
  host: H | null
  /// Leased to a ticket, from dispatch until its frame has committed.
  rendering: boolean
  usedAt: number
  /// Render steps leased on this slot's hosts.
  captures: number
  /// The idle slot this one replaces once it opens.
  evicts: Slot<H> | null
  /// The slot replacing this one: no ticket may lease it any more.
  evictedBy: Slot<H> | null
}

const keyString = (key: HostKey) => `${key.motifId}\0${key.contentHash}\0${key.texture ? 'texture' : 'bitmap'}`

/** The capture hosts, at most one per key and `capacity` in all. A key without
 * a host takes a free slot, else replaces the least recently used host that is
 * not rendering: that host's frames in flight drain, it retires, and only then
 * does the new one open, so the pool never holds more than `capacity` windows.
 * A host that retires itself (a transport failure) leaves its slot. */
export class HostPool<H extends PooledHost> implements HostSlots<HostPoolLease<H>> {
  private readonly slots = new Map<string, Slot<H>>()
  private readonly listeners: (() => void)[] = []
  private closed = false
  /// Retired hosts whose painted frames are still with their consumers. Those
  /// hold the host's shared textures, so no host opens until they are done,
  /// as for a replaced host's frames.
  private readonly retiring = new Set<H>()
  /// Counts `retireAll`s: a host that opened across one shows the old mode.
  private generation = 0

  constructor(private readonly deps: HostPoolDeps<H>) {}

  keyOf(args: CaptureArgs): string {
    return keyString(this.deps.hostKeyOf(args))
  }

  state(key: string): 'ready' | 'busy' | 'absent' {
    this.sweep()
    const slot = this.slots.get(key)
    if (!slot) return 'absent'
    return slot.rendering || slot.evictedBy || !slot.host?.hasRoom ? 'busy' : 'ready'
  }

  canOpen(keep: ReadonlySet<string> = new Set()): boolean {
    this.sweep()
    return this.live() < this.deps.capacity || this.idle(keep) !== null
  }

  acquire(key: string, args: CaptureArgs, keep: ReadonlySet<string> = new Set()): HostPoolLease<H> {
    this.sweep()
    let slot = this.slots.get(key)
    if (slot) {
      if (slot.rendering || slot.evictedBy) throw new Error('capture host is already leased')
    } else {
      slot = { key, hostKey: this.deps.hostKeyOf(args), host: null, rendering: false, usedAt: 0, captures: 0, evicts: null, evictedBy: null }
      if (this.live() >= this.deps.capacity) {
        const victim = this.idle(keep)
        if (!victim) throw new Error('no capture host slot is free')
        victim.evictedBy = slot
        slot.evicts = victim
      }
      this.slots.set(key, slot)
    }
    slot.rendering = true
    const leased = slot
    let released = false
    return {
      host: a => this.hostFor(leased, a),
      release: () => {
        if (released) return
        released = true
        this.release(leased)
      },
    }
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener)
  }

  /** Retires every host at once; frames in flight on them fail. A slot that is
   * rendering keeps its lease and opens a new host if it asks for one. */
  retireAll(): void {
    this.generation++
    for (const slot of [...this.slots.values()]) {
      slot.host?.retire()
      this.forget(slot)
      if (!slot.rendering) this.remove(slot)
    }
    this.changed()
  }

  /** Retires every host and refuses to open another. */
  shutdown(): void {
    this.closed = true
    this.retireAll()
  }

  diagnostics(now = performance.now()) {
    this.sweep()
    return [...this.slots.values()].flatMap(slot => slot.host ? [{
      ...slot.hostKey,
      width: slot.host.size.width, height: slot.host.size.height,
      framesInFlight: slot.host.framesInFlight,
      rendering: slot.rendering,
      captures: slot.captures,
      idleMs: slot.rendering ? 0 : Math.max(0, now - slot.usedAt),
    }] : [])
  }

  private async hostFor(slot: Slot<H>, args: CaptureArgs): Promise<H> {
    slot.captures++
    if (slot.host && !slot.host.retired) return slot.host
    this.forget(slot)
    const victim = slot.evicts
    if (victim) {
      await victim.host?.drain()
      victim.host?.retire()
      this.remove(victim)
      slot.evicts = null
      victim.evictedBy = null
      this.deps.evicted()
    }
    for (const old of this.retiring) {
      await old.drain()
      this.retiring.delete(old)
    }
    if (this.closed) throw closedError()
    // Keyed only now: a texture switch during the waits above changes the
    // kind of host the capture gets.
    const hostKey = this.deps.hostKeyOf(args)
    const generation = this.generation
    const host = await this.deps.open(hostKey, args)
    // Shut down while it opened: nothing may keep a window past quit.
    if (this.closed) { host.retire(); throw closedError() }
    // Every host retired while it opened, so it shows the old mode; the
    // caller asks again.
    if (generation !== this.generation) host.retire()
    // A paint makes room on the host, or retires it.
    host.onFrameSettled(() => this.changed())
    slot.hostKey = hostKey
    slot.host = host
    return host
  }

  private release(slot: Slot<H>): void {
    slot.rendering = false
    slot.usedAt = performance.now()
    const victim = slot.evicts
    if (victim) { victim.evictedBy = null; slot.evicts = null }
    if (!slot.host || slot.host.retired) this.remove(slot)
    else this.rekey(slot)
    this.changed()
  }

  /// Files a slot under its host's key once it differs from the leased one.
  /// Should another slot hold that key meanwhile, this one stays put and is
  /// replaced like any idle host.
  private rekey(slot: Slot<H>): void {
    const key = keyString(slot.hostKey)
    if (key === slot.key || this.slots.has(key)) return
    this.slots.delete(slot.key)
    slot.key = key
    this.slots.set(key, slot)
  }

  private remove(slot: Slot<H>): void {
    this.forget(slot)
    if (this.slots.get(slot.key) === slot) this.slots.delete(slot.key)
  }

  /// Drops a slot's host, already retired, keeping it for the next open to
  /// wait on while its frames are in flight.
  private forget(slot: Slot<H>): void {
    const host = slot.host
    slot.host = null
    if (host?.retired && host.framesInFlight > 0) this.retiring.add(host)
  }

  /// Forgets idle slots whose host retired itself.
  private sweep(): void {
    for (const slot of [...this.slots.values()]) {
      if (!slot.rendering && !slot.evictedBy && (!slot.host || slot.host.retired)) this.remove(slot)
    }
  }

  /// Slots counted against capacity: a slot being replaced is its successor's.
  private live(): number {
    let n = 0
    for (const slot of this.slots.values()) if (!slot.evictedBy) n++
    return n
  }

  /// The least recently used host that is not rendering, being replaced or
  /// kept.
  private idle(keep: ReadonlySet<string> = new Set()): Slot<H> | null {
    let lru: Slot<H> | null = null
    for (const slot of this.slots.values()) {
      if (slot.rendering || slot.evictedBy || keep.has(slot.key)) continue
      if (!lru || slot.usedAt < lru.usedAt) lru = slot
    }
    return lru
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

const closedError = () => new MotifError('closed', 'motif capture host is shut down (the app is quitting)')
