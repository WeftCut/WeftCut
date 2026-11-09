import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HostPool, type HostKey, type PooledHost } from './hostPool'
import { CaptureQueue, type CaptureArgs } from './captureQueue'
import type { MotifFramePriority } from '../../shared/motifs/frameTransport'

/// Pool events in order: `open:<motif>`, `drain:<motif>`, `retire:<motif>`.
let events: string[]
let evictions: number

/// A host whose frames in flight drain when the test says so.
class FakeHost implements PooledHost {
  retired = false
  framesInFlight = 0
  /// Frames in flight the host has room for.
  bound = 3
  private paints: (() => void)[] = []
  private settled: (() => void)[] = []
  constructor(public key: HostKey, readonly size: { width: number; height: number }) {}
  get hasRoom(): boolean { return this.framesInFlight < this.bound }
  /// A frame rendered on this host whose paint has not arrived.
  inFlight(): void {
    this.framesInFlight++
  }
  paint(): void {
    this.framesInFlight = 0
    for (const resolve of this.paints.splice(0)) resolve()
    for (const listener of this.settled) listener()
  }
  onFrameSettled(listener: () => void): void {
    this.settled.push(listener)
  }
  drain(): Promise<void> {
    events.push(`drain:${this.key.motifId}`)
    return this.framesInFlight ? new Promise(resolve => this.paints.push(resolve)) : Promise.resolve()
  }
  /// Frames already painted stay with their consumers until `paint`.
  retire(): void {
    if (this.retired) return
    this.retired = true
    events.push(`retire:${this.key.motifId}`)
  }
}

const argsOf = (motifId: string, contentHash = 'v1'): CaptureArgs => ({ motifId, tSec: 0, propsJson: '{}', width: 32, height: 16, contentHash })

function newPool(capacity: number, affinityMs = 0, residencyMs = 0, agingMs = 60_000) {
  const opened: FakeHost[] = []
  /// The capturer's texture switch.
  const mode = { texture: false }
  const pool = new HostPool<FakeHost>({
    capacity,
    affinityMs,
    residencyMs,
    agingMs,
    mayGrow: () => memory.room,
    hostKeyOf: a => ({ motifId: a.motifId, contentHash: a.contentHash, texture: mode.texture }),
    open: async (key, a) => {
      events.push(`open:${key.motifId}`)
      const host = new FakeHost(key, { width: a.width, height: a.height })
      opened.push(host)
      return host
    },
    evicted: () => { evictions++ },
    swap: async (host, key) => {
      events.push(`swap:${host.key.motifId}@${key.contentHash}`)
      if (swapFails) { host.retire(); return false }
      host.key = key
      return true
    },
  })
  /// Leases `motifId`'s host at `contentHash` for a capture of `priority` and opens it.
  const lease = async (motifId: string, contentHash = 'v1', priority: MotifFramePriority = 'background') => {
    const a = argsOf(motifId, contentHash)
    const leased = pool.acquire(pool.keyOf(a), a, new Set(), priority)
    return { host: await leased.host(a), release: leased.release }
  }
  return { pool, opened, mode, lease, key: (motifId: string, contentHash = 'v1') => pool.keyOf(argsOf(motifId, contentHash)) }
}

/// The next swaps fail: the host's frame does not load the version.
let swapFails = false
/// Whether memory has room for another host.
const memory = { room: true }

beforeEach(() => { events = []; evictions = 0; swapFails = false; memory.room = true })

/// Opens and releases `a`'s host at v1.
async function lease1(pool: HostPool<FakeHost>, key: (m: string, h?: string) => string): Promise<FakeHost> {
  const a = argsOf('a', 'v1')
  const leased = pool.acquire(key('a', 'v1'), a)
  const host = await leased.host(a)
  leased.release()
  return host
}

describe('HostPool', () => {
  it('keeps one host per key and reuses it', async () => {
    const { pool, opened, lease, key } = newPool(2)
    const first = await lease('a')
    expect(pool.state(key('a'))).toBe('busy')
    first.release()
    expect(pool.state(key('a'))).toBe('ready')
    const second = await lease('a')
    expect(second.host).toBe(first.host)
    expect(opened).toHaveLength(1)
  })

  it('at capacity, replaces the least recently used host that is not rendering', async () => {
    const { pool, lease, key } = newPool(2)
    const a = await lease('a'); a.release()
    const b = await lease('b'); b.release()
    ;(await lease('a')).release()
    const c = await lease('c')
    expect(b.host.retired).toBe(true)
    expect(a.host.retired).toBe(false)
    expect(pool.state(key('b'))).toBe('absent')
    expect(evictions).toBe(1)
    c.release()
    expect(pool.diagnostics().map(h => h.motifId).sort()).toEqual(['a', 'c'])
  })

  it('never replaces a rendering host', async () => {
    const { pool, lease } = newPool(2)
    const a = await lease('a')
    const b = await lease('b')
    expect(pool.canOpen()).toBe(false)
    b.release()
    expect(pool.canOpen()).toBe(true)
    await lease('c')
    expect(a.host.retired).toBe(false)
    expect(b.host.retired).toBe(true)
  })

  it('a host without room among its frames in flight is busy until a paint, which tells the queue', async () => {
    const { pool, lease, key } = newPool(1)
    const changed = vi.fn()
    pool.onChange(changed)
    const a = await lease('a')
    a.release()
    a.host.bound = 1
    a.host.inFlight()
    expect(pool.state(key('a'))).toBe('busy')
    changed.mockClear()
    a.host.paint()
    expect(changed).toHaveBeenCalled()
    expect(pool.state(key('a'))).toBe('ready')
  })

  it('never replaces a host the queue keeps for a better-ranked ticket', async () => {
    const { pool, lease, key } = newPool(2)
    ;(await lease('a')).release()
    ;(await lease('b')).release()
    const keep = new Set([key('a')])
    expect(pool.canOpen(keep)).toBe(true)
    const c = argsOf('c')
    const leased = pool.acquire(key('c'), c, keep)
    await leased.host(c)
    leased.release()
    expect(pool.diagnostics().map(h => h.motifId).sort()).toEqual(['a', 'c'])
    expect(pool.canOpen(new Set([key('a'), key('c')]))).toBe(false)
  })

  it('drains a replaced host\'s frames in flight, then retires it, then opens the new one', async () => {
    const { pool, lease, key } = newPool(1)
    const a = await lease('a')
    a.host.inFlight()
    a.release()
    events.length = 0
    const opening = lease('b')
    // The replaced host is not leasable while it drains.
    expect(pool.state(key('a'))).toBe('busy')
    await Promise.resolve()
    expect(events).toEqual(['drain:a'])
    a.host.paint()
    await opening
    expect(events).toEqual(['drain:a', 'retire:a', 'open:b'])
  })

  it('a lease released without opening leaves the host it would have replaced', async () => {
    const { pool, key } = newPool(1)
    const a = argsOf('a'), b = argsOf('b')
    const first = pool.acquire(key('a'), a)
    const host = await first.host(a)
    first.release()
    const unused = pool.acquire(key('b'), b)
    unused.release()
    expect(host.retired).toBe(false)
    expect(pool.state(key('a'))).toBe('ready')
    expect(pool.state(key('b'))).toBe('absent')
    expect(evictions).toBe(0)
  })

  it('another content version takes an idle host of its Motif, after its frames in flight, before a free slot', async () => {
    const { pool, opened, lease, key } = newPool(2)
    const v1 = await lease('a', 'v1')
    v1.host.inFlight()
    v1.release()
    events.length = 0
    const switching = lease('a', 'v2')
    await Promise.resolve()
    expect(events).toEqual(['drain:a'])
    v1.host.paint()
    const v2 = await switching
    expect(events).toEqual(['drain:a', 'swap:a@v2'])
    expect(v2.host).toBe(v1.host)
    expect(opened).toHaveLength(1)
    expect(evictions).toBe(0)
    v2.release()
    expect(pool.state(key('a', 'v1'))).toBe('absent')
    expect(pool.state(key('a', 'v2'))).toBe('ready')
  })

  it('a host used within affinityMs keeps its version while a slot is free; with none free, it switches', async () => {
    const { opened, lease } = newPool(2, 60_000)
    const v1 = await lease('a', 'v1'); v1.release()
    const v2 = await lease('a', 'v2'); v2.release()
    expect(v2.host).not.toBe(v1.host)
    expect(opened).toHaveLength(2)
    events.length = 0
    const v3 = await lease('a', 'v3')
    expect(events).toEqual(['drain:a', 'swap:a@v3'])
    expect(v3.host).toBe(v1.host) // the least recently used of the two
    expect(evictions).toBe(0)
  })

  it('a version switch takes no host that renders, that the queue keeps, or of another Motif or lane', async () => {
    const { pool, opened, mode, lease, key } = newPool(4)
    const rendering = await lease('a', 'v1')
    const b = await lease('b', 'v1'); b.release()
    const switching = await lease('a', 'v2')
    expect(switching.host).not.toBe(rendering.host)
    rendering.release(); switching.release()
    // v1 is kept for a better-ranked ticket: v3 opens its own host.
    const v3 = argsOf('a', 'v3')
    const kept = pool.acquire(key('a', 'v3'), v3, new Set([key('a', 'v1'), key('a', 'v2')]))
    await kept.host(v3)
    kept.release()
    expect(opened).toHaveLength(4)
    // Another lane: a texture host is not a bitmap host's sibling.
    mode.texture = true
    expect(pool.canOpen()).toBe(true)
    events.length = 0
    ;(await lease('b', 'v2')).release()
    expect(events.some(e => e.startsWith('swap:'))).toBe(false)
  })

  it('a version whose page does not load retires the host and opens one in its slot', async () => {
    const { pool, opened, lease } = newPool(1)
    const v1 = await lease('a', 'v1'); v1.release()
    swapFails = true
    const v2 = await lease('a', 'v2')
    expect(v1.host.retired).toBe(true)
    expect(v2.host).not.toBe(v1.host)
    expect(opened).toHaveLength(2)
    expect(evictions).toBe(0)
    v2.release()
    expect(pool.diagnostics().map(h => h.contentHash)).toEqual(['v2'])
  })

  it('a version switch whose lease is released unused leaves the host on its version', async () => {
    const { pool, key } = newPool(1)
    const v1 = await lease1(pool, key)
    const v2 = argsOf('a', 'v2')
    const unused = pool.acquire(key('a', 'v2'), v2)
    unused.release()
    expect(v1.retired).toBe(false)
    expect(events.some(e => e.startsWith('swap:'))).toBe(false)
    expect(pool.state(key('a', 'v1'))).toBe('ready')
    expect(pool.state(key('a', 'v2'))).toBe('absent')
  })

  it('a version switch released unused while its version opened elsewhere retires the host, which never serves the switch', async () => {
    const { pool, lease, key } = newPool(2)
    const v1 = await lease1(pool, key)
    const v2 = argsOf('a', 'v2')
    const unused = pool.acquire(key('a', 'v2'), v2)
    // v1's captures meanwhile open their own host in the free slot.
    const again = await lease('a', 'v1')
    again.release()
    unused.release()
    expect(v1.retired).toBe(true)
    expect(events.some(e => e.startsWith('swap:'))).toBe(false)
    expect(pool.state(key('a', 'v2'))).toBe('absent')
    expect(pool.state(key('a', 'v1'))).toBe('ready')
    expect(pool.diagnostics()).toHaveLength(1)
  })

  it('without memory for another host, the first still opens and the others replace the least recently used', async () => {
    const { pool, opened, lease } = newPool(4)
    memory.room = false
    const a = await lease('a'); a.release()
    expect(opened).toHaveLength(1)
    expect(pool.canOpen()).toBe(true) // by replacing `a`
    const b = await lease('b'); b.release()
    expect(a.host.retired).toBe(true)
    expect(evictions).toBe(1)
    memory.room = true
    ;(await lease('c')).release()
    expect(b.host.retired).toBe(false)
    expect(pool.diagnostics().map(h => h.motifId).sort()).toEqual(['b', 'c'])
  })

  it('shed retires the idle hosts without frames in flight, least recently used first, down to one', async () => {
    const { pool, lease } = newPool(4)
    const a = await lease('a'); a.release()
    const b = await lease('b'); b.release()
    const c = await lease('c'); c.release()
    const d = await lease('d')
    c.host.inFlight()
    expect(pool.shed()).toBe(2) // a and b; c paints, d renders
    expect([a, b, c, d].map(l => l.host.retired)).toEqual([true, true, false, false])
    d.release()
    c.host.paint()
    expect(pool.shed()).toBe(1) // c; d, used last, stays
    expect(pool.diagnostics().map(h => h.motifId)).toEqual(['d'])
    expect(pool.shed()).toBe(0)
  })

  describe('roles', () => {
    const demand = (visible: string[], warm: string[] = []) => ({
      visible: new Set(visible.map(m => `${m}\0v1`)), warm: new Set(warm.map(m => `${m}\0v1`)),
    })
    beforeEach(() => { vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] }) })
    afterEach(() => { vi.useRealTimers() })

    it('side traffic takes only a spare host; current takes a warm one at once and a visible one after residency', async () => {
      const { pool, lease, key } = newPool(2, 0, 1000)
      ;(await lease('shown')).release()
      ;(await lease('next')).release()
      pool.setDemand(demand(['shown'], ['next']))
      expect(pool.canOpen(new Set(), 'background')).toBe(false)
      expect(pool.canOpen(new Set(), 'ahead')).toBe(false)
      // The warm host goes first, to a current capture.
      const now = await lease('urgent', 'v1', 'current'); now.release()
      expect(pool.state(key('next'))).toBe('absent')
      pool.setDemand(demand(['shown', 'urgent']))
      // Both held: a current capture waits for the longest-shown one's residency.
      expect(pool.canOpen(new Set(), 'current')).toBe(false)
      const woken = vi.fn()
      pool.onChange(woken)
      vi.advanceTimersByTime(1001)
      expect(woken).toHaveBeenCalled()
      expect(pool.canOpen(new Set(), 'current')).toBe(true)
      ;(await lease('third', 'v1', 'current')).release()
      expect(pool.diagnostics().map(h => h.motifId).sort()).toEqual(['third', 'urgent'])
    })

    it('side traffic that has waited agingMs takes a warm or held host as a current capture does', async () => {
      const { pool, lease } = newPool(1, 0, 0, 500)
      ;(await lease('shown')).release()
      pool.setDemand(demand(['shown']))
      const queuedAt = performance.now()
      expect(pool.canOpen(new Set(), 'background', queuedAt)).toBe(false)
      const woken = vi.fn()
      pool.onChange(woken)
      vi.advanceTimersByTime(501)
      expect(woken).toHaveBeenCalled()
      expect(pool.canOpen(new Set(), 'background', queuedAt)).toBe(true)
      expect(pool.canOpen(new Set(), 'ahead', performance.now())).toBe(false)
    })

    it('warm builds a host as side traffic: in a free slot or for a spare one, never for a held one', async () => {
      const { pool, opened } = newPool(1, 0, 1000)
      expect(await pool.warm(argsOf('a'))).toBe('built')
      expect(await pool.warm(argsOf('a'))).toBe('present')
      expect(pool.diagnostics()).toEqual([expect.objectContaining({ motifId: 'a', captures: 0 })])
      pool.setDemand(demand(['a']))
      expect(await pool.warm(argsOf('b'))).toBe('refused')
      pool.setDemand(demand([]))
      expect(await pool.warm(argsOf('b'))).toBe('built')
      expect(opened).toHaveLength(2)
      expect(evictions).toBe(1)
    })

    it('warm takes no spare host a queued capture will render on', async () => {
      const { pool, key } = newPool(1)
      expect(await pool.warm(argsOf('a'))).toBe('built')
      expect(await pool.warm(argsOf('b'), new Set([key('a')]))).toBe('refused')
      expect(await pool.warm(argsOf('b'))).toBe('built')
    })

    it('a current capture keeps its host from side traffic for the residency', async () => {
      const { pool, lease } = newPool(1, 0, 1000)
      ;(await lease('exported', 'v1', 'current')).release()
      expect(pool.canOpen(new Set(), 'background')).toBe(false)
      vi.advanceTimersByTime(1001)
      expect(pool.canOpen(new Set(), 'background')).toBe(true)
    })

    it('shed gives back spare hosts before warm ones and keeps the held', async () => {
      const { pool, lease } = newPool(4)
      for (const m of ['warm', 'spare', 'shown']) (await lease(m)).release()
      pool.setDemand(demand(['shown'], ['warm']))
      expect(pool.shed()).toBe(2)
      expect(pool.diagnostics().map(h => h.motifId)).toEqual(['shown'])
      expect(evictions).toBe(0)
    })

    it('shed keeps one host when every host is warm or spare', async () => {
      const { pool, lease } = newPool(4)
      for (const m of ['spare', 'warm']) (await lease(m)).release()
      pool.setDemand(demand([], ['warm']))
      expect(pool.shed()).toBe(1)
      expect(pool.diagnostics().map(h => [h.motifId, h.role])).toEqual([['warm', 'warm']])
    })
  })

  it('a host that retires itself leaves its slot; the other hosts and their frames stay', async () => {
    const { pool, opened, lease, key } = newPool(2)
    const a = await lease('a')
    const b = await lease('b')
    b.host.inFlight()
    a.host.retire() // a transport failure mid-render
    a.release(); b.release()
    expect(pool.state(key('a'))).toBe('absent')
    expect(b.host).toMatchObject({ retired: false, framesInFlight: 1 })
    expect(events).not.toContain('drain:b')
    const again = await lease('a')
    expect(again.host).not.toBe(a.host)
    expect(opened).toHaveLength(3)
    expect(evictions).toBe(0)
  })

  it('retireAll retires every host; a rendering slot opens a new host when it asks', async () => {
    const { pool, opened, key } = newPool(2)
    const a = argsOf('a'), b = argsOf('b')
    const idle = pool.acquire(key('a'), a)
    const idleHost = await idle.host(a)
    idle.release()
    const rendering = pool.acquire(key('b'), b)
    const renderingHost = await rendering.host(b)
    pool.retireAll()
    expect([idleHost.retired, renderingHost.retired]).toEqual([true, true])
    expect(pool.state(key('a'))).toBe('absent')
    expect(pool.state(key('b'))).toBe('busy')
    const reopened = await rendering.host(b)
    expect(reopened).not.toBe(renderingHost)
    expect(opened).toHaveLength(3)
    rendering.release()
    expect(pool.state(key('b'))).toBe('ready')
  })

  it('a host opens only once the painted frames of a host that retired itself are done', async () => {
    const { lease } = newPool(1)
    const a = await lease('a')
    a.host.inFlight()
    a.host.retire() // a transport failure, a frame still with its consumer
    a.release()
    events.length = 0
    const opening = lease('b')
    await Promise.resolve()
    expect(events).toEqual(['drain:a'])
    a.host.paint()
    await opening
    expect(events).toEqual(['drain:a', 'open:b'])
  })

  it('retireAll during a replaced host\'s drain: the new host opens in the mode switched to', async () => {
    const { pool, opened, mode, lease, key } = newPool(1)
    const a = await lease('a')
    a.host.inFlight()
    a.release()
    const b = argsOf('b')
    const leased = pool.acquire(key('b'), b)
    const opening = leased.host(b)
    await Promise.resolve()
    expect(events).toContain('drain:a')
    mode.texture = true
    pool.retireAll()
    expect(a.host.retired).toBe(true)
    expect(opened).toHaveLength(1)
    a.host.paint()
    const host = await opening
    expect(host).toMatchObject({ retired: false, key: { motifId: 'b', texture: true } })
    expect(evictions).toBe(1)
    // Filed under the key it opened with, which is the key captures ask for now.
    leased.release()
    expect(pool.state(key('b'))).toBe('ready')
    expect(pool.diagnostics()).toEqual([expect.objectContaining({ motifId: 'b', texture: true })])
  })

  it('a host that opens across a retireAll comes back retired; asked again, the slot opens one in the new mode', async () => {
    const { pool, opened, mode, key } = newPool(1)
    const a = argsOf('a')
    const leased = pool.acquire(key('a'), a)
    const opening = leased.host(a)
    mode.texture = true
    pool.retireAll()
    expect(await opening).toMatchObject({ retired: true, key: { texture: false } })
    expect(await leased.host(a)).toMatchObject({ retired: false, key: { texture: true } })
    expect(opened).toHaveLength(2)
  })

  it('shutdown during a replaced host\'s drain opens nothing', async () => {
    const { pool, opened, lease } = newPool(1)
    const a = await lease('a')
    a.host.inFlight()
    a.release()
    const opening = lease('b')
    await Promise.resolve()
    expect(events).toContain('drain:a')
    pool.shutdown()
    expect(a.host.retired).toBe(true)
    a.host.paint()
    await expect(opening).rejects.toMatchObject({ code: 'closed' })
    expect(opened).toHaveLength(1)
  })

  it('shutdown retires every host and refuses to open another', async () => {
    const { pool, opened, lease } = newPool(1)
    const a = await lease('a')
    a.release()
    pool.shutdown()
    expect(a.host.retired).toBe(true)
    await expect(lease('b')).rejects.toMatchObject({ code: 'closed' })
    expect(opened).toHaveLength(1)
  })

  it('a host that finishes opening after shutdown is retired', async () => {
    const { pool, opened, key } = newPool(1)
    const a = argsOf('a')
    const leased = pool.acquire(key('a'), a)
    const opening = leased.host(a)
    pool.shutdown()
    await expect(opening).rejects.toMatchObject({ code: 'closed' })
    expect(opened[0]!.retired).toBe(true)
  })

  it('two hosts render at once when captureHosts is 2', async () => {
    const { pool } = newPool(2)
    const queue = new CaptureQueue(pool, { skippedFrameRetries: 0, backgroundAgingMs: 2000, hostAffinityMs: 0 }, {
      refuse: () => null, started: () => {}, settled: () => {}, affinityPick: () => {},
    })
    let rendering = 0, peak = 0
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const capture = (motifId: string) => queue.enqueue(argsOf(motifId), async lease => {
      await lease.host(argsOf(motifId))
      rendering++; peak = Math.max(peak, rendering)
      await gate
      rendering--
      return { delivered: Promise.resolve(motifId) }
    }, { priority: 'ahead' })
    const runs = [capture('a'), capture('b')]
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(peak).toBe(2)
    expect(queue.rendering).toBe(2)
    expect(pool.diagnostics().map(h => [h.motifId, h.rendering])).toEqual([['a', true], ['b', true]])
    open()
    await expect(Promise.all(runs.map(r => r.result))).resolves.toEqual(['a', 'b'])
    expect(pool.diagnostics().every(h => !h.rendering && h.captures === 1)).toBe(true)
  })
})
