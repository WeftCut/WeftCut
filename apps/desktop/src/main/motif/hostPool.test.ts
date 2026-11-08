import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HostPool, type HostKey, type PooledHost } from './hostPool'
import { CaptureQueue, type CaptureArgs } from './captureQueue'

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
  constructor(readonly key: HostKey, readonly size: { width: number; height: number }) {}
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

const argsOf = (motifId: string): CaptureArgs => ({ motifId, tSec: 0, propsJson: '{}', width: 32, height: 16, contentHash: 'v1' })

function newPool(capacity: number) {
  const opened: FakeHost[] = []
  /// The capturer's texture switch.
  const mode = { texture: false }
  const pool = new HostPool<FakeHost>({
    capacity,
    hostKeyOf: a => ({ motifId: a.motifId, contentHash: a.contentHash, texture: mode.texture }),
    open: async (key, a) => {
      events.push(`open:${key.motifId}`)
      const host = new FakeHost(key, { width: a.width, height: a.height })
      opened.push(host)
      return host
    },
    evicted: () => { evictions++ },
  })
  /// Leases `motifId`'s host and opens it.
  const lease = async (motifId: string) => {
    const a = argsOf(motifId)
    const leased = pool.acquire(pool.keyOf(a), a)
    return { host: await leased.host(a), release: leased.release }
  }
  return { pool, opened, mode, lease, key: (motifId: string) => pool.keyOf(argsOf(motifId)) }
}

beforeEach(() => { events = []; evictions = 0 })

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
