import { MotifError } from '../../shared/motifs/errors.js'
import type { MotifFramePriority } from '../../shared/motifs/frameTransport.js'
import type { CaptureArgs, HostLease, HostSlots } from './captureQueue.js'

/** What a capture host shows: one Motif content version, as shared textures
 * or bitmaps. A host changes key only to another content version of its Motif
 * on the same lane (`HostPoolDeps.swap`). */
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
  /// A host used within this long may still be wanted for its version: another
  /// version takes it only when no slot is free (tuning `hostAffinityMs`).
  affinityMs: number
  /// How long a host keeps the content it opened or switched to before a
  /// `current` capture of another may take it, and how long a `current`
  /// capture's use protects it from other classes (tuning `hostResidencyMs`).
  residencyMs: number
  /// How long an `ahead` or `background` capture waits before it may take a
  /// warm or held host as a `current` one does (tuning `hostAgingMs`).
  agingMs: number
  /// Whether memory has room for one more host beside the `live` ones. Never
  /// asked for the first: one host can always open.
  mayGrow(live: number): boolean
  hostKeyOf(args: CaptureArgs): HostKey
  /// Opens a host for `key`, sized to `args`.
  open(key: HostKey, args: CaptureArgs): Promise<H>
  /// A host was retired to make room for another key.
  evicted(): void
  /// Shows `key`, another content version of the host's Motif on its lane, in
  /// the host's window; its frames in flight have drained. False: the host
  /// retired and the slot opens a new one.
  swap(host: H, key: HostKey): Promise<boolean>
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
  /// The content version the slot's host switches to before its next frame.
  swapTo: HostKey | null
  /// When the host began showing its content version: opened or switched.
  shownAt: number
  /// When a `current` capture last leased the slot.
  currentAt: number
}

/** The Motif content versions on screen (`visible`) and the next to enter
 * (`warm`) in a playing preview, as `motifId\0contentHash`. */
export interface HostDemand { visible: ReadonlySet<string>; warm: ReadonlySet<string> }

/** What a host is to the pool's eviction, most expendable first: `spare` (no
 * playing preview needs it, no `current` capture used it within
 * `residencyMs`), `warm` (the next Motif to enter a playing preview), `held`
 * (visible in a playing preview, or a `current` capture used it within
 * `residencyMs`, an export's included). */
type Role = 'spare' | 'warm' | 'held'
const ROLE_RANK: Record<Role, number> = { spare: 0, warm: 1, held: 2 }

const contentOf = (key: HostKey) => `${key.motifId}\0${key.contentHash}`

/// A capture asking for a host: `current`, or side traffic that may take
/// warm and held hosts from `agesAt` on.
interface Claim { current: boolean; agesAt: number }

const keyString = (key: HostKey) => `${key.motifId}\0${key.contentHash}\0${key.texture ? 'texture' : 'bitmap'}`

/** The capture hosts, at most one per key and `capacity` in all, and more
 * than one only while memory has room for another (`mayGrow`); under memory
 * pressure the expendable idle ones retire, keeping at least one (`shed`).
 *
 * Which host a key without one may take follows the host's role (`Role`) and
 * the capture's class: an `ahead` or `background` capture takes only spare
 * hosts until it has waited `agingMs`, so side traffic (bakes, panel previews,
 * covers, MCP) does not evict what playback needs, and never waits for ever;
 * a `current` capture, or aged side traffic, takes a spare, then a warm, then
 * a held host that has shown its content for `residencyMs`, the longest-shown
 * first, so more visible Motifs than hosts rotate at that pace instead of
 * every frame. A key without
 * a host takes an idle host of another content version of its Motif on its
 * lane, which drains and switches its window's frame to the key's version:
 * first one unused for `affinityMs`, then a free slot, then any such host.
 * Else it replaces the least recently used host that is not rendering: that
 * host's frames in flight drain, it retires, and only then does the new one
 * open, so the pool never holds more than `capacity` windows. A host that
 * retires itself (a transport failure) leaves its slot. */
export class HostPool<H extends PooledHost> implements HostSlots<HostPoolLease<H>> {
  private readonly slots = new Map<string, Slot<H>>()
  private readonly listeners: (() => void)[] = []
  private demand: HostDemand = { visible: new Set(), warm: new Set() }
  /// A repaint of the queue when a host's protection ends, the earliest one.
  private wake: { at: number; timer: ReturnType<typeof setTimeout> } | null = null
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

  /** `queuedAt`: when the capture asking began to wait. */
  canOpen(keep: ReadonlySet<string> = new Set(), priority: MotifFramePriority = 'background', queuedAt = performance.now()): boolean {
    this.sweep()
    return this.free() || this.victim(keep, this.claimOf(priority, queuedAt)) !== null
  }

  /** The previews' demand: the hosts it names are visible or warm. */
  setDemand(demand: HostDemand): void {
    this.demand = demand
    this.changed()
  }

  /** Under memory pressure: retires the spare, then the warm hosts that render
   * nothing and have no frames in flight, least recently used first, keeping
   * at least one host; held ones stay. The number retired. */
  shed(): number {
    this.sweep()
    const now = performance.now()
    let live = this.live()
    let shed = 0
    const idle = [...this.slots.values()]
      .filter(slot => !slot.rendering && !slot.evictedBy && !slot.evicts && slot.host && !slot.host.retired && slot.host.framesInFlight === 0
        && this.role(slot, now) !== 'held')
      .sort((a, b) => ROLE_RANK[this.role(a, now)] - ROLE_RANK[this.role(b, now)] || a.usedAt - b.usedAt)
    for (const slot of idle) {
      if (live <= 1) break
      slot.host!.retire()
      this.remove(slot)
      live--
      shed++
    }
    if (shed) this.changed()
    return shed
  }

  acquire(key: string, args: CaptureArgs, keep: ReadonlySet<string> = new Set(), priority: MotifFramePriority = 'background', queuedAt = performance.now()): HostPoolLease<H> {
    this.sweep()
    const slot = this.slots.get(key) ?? this.reserve(key, args, keep, this.claimOf(priority, queuedAt))
    if (slot.rendering || slot.evictedBy) throw new Error('capture host is already leased')
    slot.rendering = true
    if (priority === 'current') slot.currentAt = performance.now()
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
    if (this.wake) clearTimeout(this.wake.timer)
    this.wake = null
    this.retireAll()
  }

  /** The open hosts. */
  hosts(): H[] {
    this.sweep()
    return [...this.slots.values()].flatMap(slot => slot.host && !slot.host.retired ? [slot.host] : [])
  }

  /** Each open host's key, size and state, with what `detail` adds. */
  diagnostics<D extends object = object>(now = performance.now(), detail?: (host: H) => D) {
    this.sweep()
    return [...this.slots.values()].flatMap(slot => slot.host ? [{
      ...(detail ? detail(slot.host) : {} as D),
      ...slot.hostKey,
      width: slot.host.size.width, height: slot.host.size.height,
      framesInFlight: slot.host.framesInFlight,
      rendering: slot.rendering,
      captures: slot.captures,
      idleMs: slot.rendering ? 0 : Math.max(0, now - slot.usedAt),
      role: this.role(slot, now),
    }] : [])
  }

  /// A slot for a key without one: an idle host of another content version of
  /// its Motif that the capture's class may take, which switches before its
  /// next frame, unless it was used within `affinityMs` and a slot is free;
  /// else a free slot; else one replacing a host the class may take.
  private reserve(key: string, args: CaptureArgs, keep: ReadonlySet<string>, claim: Claim): Slot<H> {
    const hostKey = this.deps.hostKeyOf(args)
    const sibling = this.sibling(hostKey, keep, claim)
    const free = this.free()
    if (sibling && (!free || performance.now() - sibling.usedAt >= this.deps.affinityMs)) {
      this.slots.delete(sibling.key)
      sibling.key = key
      sibling.swapTo = hostKey
      this.slots.set(key, sibling)
      return sibling
    }
    const slot: Slot<H> = { key, hostKey, host: null, rendering: false, usedAt: 0, captures: 0, evicts: null, evictedBy: null, swapTo: null, shownAt: Infinity, currentAt: -Infinity }
    if (!free) {
      const victim = this.victim(keep, claim)
      if (!victim) throw new Error('no capture host slot is free')
      victim.evictedBy = slot
      slot.evicts = victim
    }
    this.slots.set(key, slot)
    return slot
  }

  private async hostFor(slot: Slot<H>, args: CaptureArgs): Promise<H> {
    slot.captures++
    const swapTo = slot.swapTo
    if (swapTo) {
      slot.swapTo = null
      const host = slot.host
      if (host && !host.retired) {
        // The old version's frames commit before its document goes.
        await host.drain()
        // Keyed again after the wait, as an open is: a texture switch meanwhile
        // wants another kind of host.
        const hostKey = this.deps.hostKeyOf(args)
        if (!this.closed && !host.retired && hostKey.texture === slot.hostKey.texture && await this.deps.swap(host, hostKey).catch(() => false)) {
          slot.hostKey = hostKey
          slot.shownAt = performance.now()
          return host
        }
        host.retire()
      }
    }
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
    slot.shownAt = performance.now()
    return host
  }

  private release(slot: Slot<H>): void {
    slot.rendering = false
    // A switch its lease never asked for: the host still shows its version,
    // under which `rekey` files the slot again.
    slot.swapTo = null
    slot.usedAt = performance.now()
    const victim = slot.evicts
    if (victim) { victim.evictedBy = null; slot.evicts = null }
    if (!slot.host || slot.host.retired) this.remove(slot)
    else this.rekey(slot)
    this.changed()
  }

  /// Files a slot under its host's key once it differs from the leased one.
  /// Should another slot hold that key meanwhile, the host retires: filed
  /// under the leased key, it would serve that key's captures with what it
  /// shows, another kind of host or another content version.
  private rekey(slot: Slot<H>): void {
    const key = keyString(slot.hostKey)
    if (key === slot.key) return
    if (this.slots.has(key)) { slot.host!.retire(); this.remove(slot); return }
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

  /// Room for one more host: under `capacity`, and memory has room unless
  /// there is none yet.
  private free(): boolean {
    const live = this.live()
    return live < this.deps.capacity && (live === 0 || this.deps.mayGrow(live))
  }

  /// Slots counted against capacity: a slot being replaced is its successor's.
  private live(): number {
    let n = 0
    for (const slot of this.slots.values()) if (!slot.evictedBy) n++
    return n
  }

  /// An idle host showing another content version of `key`'s Motif on its
  /// lane that `claim` may take, the least recently used first.
  private sibling(key: HostKey, keep: ReadonlySet<string>, claim: Claim): Slot<H> | null {
    const now = performance.now()
    let lru: Slot<H> | null = null
    for (const slot of this.slots.values()) {
      if (slot.rendering || slot.evictedBy || keep.has(slot.key) || !slot.host || slot.host.retired) continue
      const k = slot.hostKey
      if (k.motifId !== key.motifId || k.texture !== key.texture || k.contentHash === key.contentHash) continue
      if (!this.takes(claim, slot, now)) continue
      if (!lru || slot.usedAt < lru.usedAt) lru = slot
    }
    return lru
  }

  /// The host `claim` replaces: not rendering, being replaced
  /// or kept, and one its class may take (`takes`); the most expendable role
  /// first, then the least recently used, and among held hosts the one shown
  /// longest.
  private victim(keep: ReadonlySet<string>, claim: Claim): Slot<H> | null {
    const now = performance.now()
    let best: Slot<H> | null = null
    let bestRole: Role = 'held'
    for (const slot of this.slots.values()) {
      if (slot.rendering || slot.evictedBy || keep.has(slot.key)) continue
      if (!this.takes(claim, slot, now)) continue
      const role = this.role(slot, now)
      const better = !best || ROLE_RANK[role] < ROLE_RANK[bestRole]
        || role === bestRole && (role === 'held' ? slot.shownAt < best.shownAt : slot.usedAt < best.usedAt)
      if (better) { best = slot; bestRole = role }
    }
    return best
  }

  /// What a capture may take: `current`, or side traffic waiting since
  /// `queuedAt`, which ages into `current`'s reach after `agingMs`.
  private claimOf(priority: MotifFramePriority, queuedAt: number): Claim {
    return { current: priority === 'current', agesAt: priority === 'current' ? -Infinity : queuedAt + this.deps.agingMs }
  }

  /// Whether `claim` may take `slot`'s host. When the answer will change by
  /// time alone, the queue is woken then.
  private takes(claim: Claim, slot: Slot<H>, now: number): boolean {
    const role = this.role(slot, now)
    if (role === 'spare') return true
    // Recent `current` use ends; a held host's residency ends; side traffic ages.
    if (slot.currentAt + this.deps.residencyMs > now) this.wakeAt(slot.currentAt + this.deps.residencyMs)
    if (!claim.current && claim.agesAt > now) { this.wakeAt(claim.agesAt); return false }
    if (role === 'warm') return true
    if (slot.shownAt + this.deps.residencyMs <= now) return true
    this.wakeAt(slot.shownAt + this.deps.residencyMs)
    return false
  }

  private role(slot: Slot<H>, now: number): Role {
    const content = contentOf(slot.hostKey)
    if (this.demand.visible.has(content) || now - slot.currentAt < this.deps.residencyMs) return 'held'
    return this.demand.warm.has(content) ? 'warm' : 'spare'
  }

  private wakeAt(at: number): void {
    if (this.closed || !Number.isFinite(at)) return
    if (this.wake && this.wake.at <= at) return
    if (this.wake) clearTimeout(this.wake.timer)
    const timer = setTimeout(() => { this.wake = null; this.changed() }, Math.max(0, at - performance.now()) + 1)
    ;(timer as { unref?: () => void }).unref?.()
    this.wake = { at, timer }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

const closedError = () => new MotifError('closed', 'motif capture host is shut down (the app is quitting)')
