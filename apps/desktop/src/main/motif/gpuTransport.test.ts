import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedTexture, type WebContents } from 'electron'
import { MotifGpuTransport } from './gpuTransport'
import { MIB, hydratePerformanceSettings, performanceSettings } from '../../shared/performance-settings'
import { createGpuBufferBudget } from '../gpuBufferBudget'

vi.mock('electron', () => ({ sharedTexture: {
  importSharedTexture: vi.fn(({ allReferencesReleased }: { allReferencesReleased: () => void }) => ({ release: allReferencesReleased })),
  sendSharedTexture: vi.fn(async () => {}),
} }))
afterEach(() => { vi.useRealTimers(); hydratePerformanceSettings(undefined) })
function fixture(concurrency = 1) {
  const owner = { id: 1, isDestroyed: () => false, send: vi.fn(), mainFrame: { isDestroyed: vi.fn(() => false), detached: false } } as unknown as WebContents
  const pools: { handles: ReturnType<typeof vi.fn>; uploadFile: ReturnType<typeof vi.fn>; copyTexture: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  const create = vi.fn(() => {
    const pool = { handles: vi.fn(() => [Buffer.alloc(8)]), uploadFile: vi.fn(async () => {}), copyTexture: vi.fn(async () => {}), close: vi.fn() }
    pools.push(pool)
    return pool
  })
  const buffers = createGpuBufferBudget(() => performanceSettings().gpu_buffer_mib * MIB)
  return { owner, pools, create, buffers, transport: new MotifGpuTransport(create, concurrency, buffers) }
}

describe('Motif GPU leases', () => {
  it('borrows unused video memory in budget mode while legacy mode retains its own cap', async () => {
    hydratePerformanceSettings({ gpu_buffer_mib: 256, motif_gpu_mib: 16 }, null, true)
    const { owner, buffers, transport } = fixture()
    const frame = await transport.read(owner, 'borrowed', 4096, 2048)
    expect(buffers.snapshot().motif_bytes).toBe(32 * MIB)
    transport.release(owner, frame.token)
    transport.close(owner)
    hydratePerformanceSettings({ gpu_buffer_mib: 256, motif_gpu_mib: 16 })
    await expect(transport.read(owner, 'legacy', 4096, 2048)).rejects.toThrow('budget exhausted')
  })
  it('shares the byte limit with video and retries after video releases capacity', async () => {
    hydratePerformanceSettings({ gpu_buffer_mib: 64 })
    const { owner, buffers, transport, create } = fixture()
    const video = buffers.reserve('preview', 60 * MIB)!
    await expect(transport.read(owner, 'blocked', 2048, 1024)).rejects.toThrow('budget exhausted')
    expect(create).not.toHaveBeenCalled()
    buffers.release(video)
    const frame = await transport.read(owner, 'allowed', 2048, 1024)
    expect(buffers.snapshot().motif_bytes).toBe(8 * MIB)
    transport.release(owner, frame.token)
    transport.close(owner)
    expect(buffers.snapshot().used_bytes).toBe(0)
  })

  it('keeps retired Motif textures in the shared budget until Electron releases their references', async () => {
    const { owner, buffers, transport } = fixture()
    let finalReference!: () => void
    vi.mocked(sharedTexture.importSharedTexture).mockImplementationOnce(({ allReferencesReleased }) => {
      finalReference = allReferencesReleased!
      return { release: vi.fn() } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>
    })
    const frame = await transport.read(owner, 'held', 2048, 1024)
    transport.release(owner, frame.token)
    transport.close(owner)
    expect(buffers.snapshot().motif_bytes).toBe(8 * MIB)
    finalReference()
    expect(buffers.snapshot().motif_bytes).toBe(0)
  })
  it('reads changed allocation budgets without closing a leased texture', async () => {
    const { owner, pools, transport } = fixture(2)
    const first = await transport.read(owner, 'first', 4096, 2048)
    hydratePerformanceSettings({ motif_gpu_mib: 16 })
    await expect(transport.read(owner, 'too-large', 2048, 4096)).rejects.toThrow('budget exhausted')
    expect(pools[0]!.close).not.toHaveBeenCalled()
    transport.release(owner, first.token)
    hydratePerformanceSettings({ motif_gpu_mib: 64, motif_gpu_sessions: 1 })
    const second = await transport.read(owner, 'replacement', 2048, 4096)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, second.token)
    transport.close(owner)
  })

  it('rejects work for a disposed frame before allocating or announcing a texture', async () => {
    const { owner, create, transport } = fixture()
    vi.mocked(owner.mainFrame.isDestroyed).mockReturnValue(true)
    await expect(transport.read(owner, 'a', 128, 128)).rejects.toThrow('Motif consumer closed')
    expect(create).not.toHaveBeenCalled()
    expect(owner.send).not.toHaveBeenCalled()
  })

  it('retires an import finishing after close and allows the replacement document to read', async () => {
    const { owner, pools, transport } = fixture()
    let finish!: () => void
    vi.mocked(sharedTexture.sendSharedTexture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const read = transport.read(owner, 'old', 128, 128)
    const rejected = expect(read).rejects.toThrow('Motif consumer closed')
    await vi.waitFor(() => expect(finish).toBeDefined())
    transport.close(owner)
    expect(pools[0]!.close).not.toHaveBeenCalled()
    finish()
    await rejected
    expect(pools[0]!.uploadFile).not.toHaveBeenCalled()
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    const fresh = await transport.read(owner, 'new', 128, 128)
    transport.release(owner, fresh.token)
    transport.close(owner)
    expect(pools[1]!.close).toHaveBeenCalledOnce()
  })

  it('does not deliver a texture when close races an in-flight upload', async () => {
    const { owner, pools, transport } = fixture()
    const frame = await transport.read(owner, 'first', 128, 128)
    transport.release(owner, frame.token)
    let finish!: () => void
    pools[0]!.uploadFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const rejected = expect(transport.read(owner, 'old', 128, 128)).rejects.toThrow('Motif consumer closed')
    await vi.waitFor(() => expect(finish).toBeDefined())
    transport.close(owner)
    finish()
    await rejected
    const fresh = await transport.read(owner, 'new', 128, 128)
    expect(fresh.key).not.toBe(frame.key)
    transport.release(owner, fresh.token)
    transport.close(owner)
    for (const pool of pools) expect(pool.close).toHaveBeenCalledOnce()
  })

  it.each(['destroyed', 'detached', 'inaccessible'] as const)('does not send to a %s frame while WebContents is still alive', async state => {
    const { owner, pools, transport } = fixture(3)
    await Promise.all(['a', 'b', 'c'].map(file => transport.read(owner, file, 128, 128)))
    const queued = transport.read(owner, 'queued', 128, 128)
    const rejected = expect(queued).rejects.toThrow('Motif consumer closed')
    if (state === 'destroyed') vi.mocked(owner.mainFrame.isDestroyed).mockReturnValue(true)
    if (state === 'detached') Object.defineProperty(owner.mainFrame, 'detached', { value: true })
    if (state === 'inaccessible') Object.defineProperty(owner, 'mainFrame', { get() { throw new Error('Object has been destroyed') } })
    const errors = vi.fn()
    vi.mocked(owner.send).mockImplementation(() => {
      errors('Render frame was disposed before WebFrameMain could be accessed')
    })
    transport.close(owner)
    await rejected
    expect(errors).not.toHaveBeenCalled()
    for (const pool of pools) expect(pool.close).toHaveBeenCalledOnce()
  })

  it('releases imports and queued leases even when the close notification throws', async () => {
    const { owner, pools, transport } = fixture()
    await transport.read(owner, 'a', 128, 128)
    const rejected = expect(transport.read(owner, 'queued', 128, 128)).rejects.toThrow('Motif consumer closed')
    vi.mocked(owner.send).mockImplementation(() => { throw new Error('Object has been destroyed') })
    expect(() => transport.close(owner)).not.toThrow()
    await rejected
    expect(pools[0]!.close).toHaveBeenCalledOnce()
  })

  it('releases a partially sent import when the renderer dies during transfer', async () => {
    const { owner, pools, transport } = fixture()
    vi.mocked(sharedTexture.sendSharedTexture).mockImplementationOnce(async () => {
      vi.mocked(owner.mainFrame.isDestroyed).mockReturnValue(true)
      vi.mocked(owner.send).mockClear()
      throw new Error('Texture transfer failed')
    })
    await expect(transport.read(owner, 'a', 128, 128)).rejects.toThrow('Texture transfer failed')
    expect(owner.send).not.toHaveBeenCalled()
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.close(owner)
  })

  it('uses an acknowledged lane while a sibling still holds its lease', async () => {
    const { owner, pools, transport } = fixture(3)
    try {
      const frames = await Promise.all(['a', 'b', 'c'].map(file => transport.read(owner, file, 128, 128)))
      transport.release(owner, frames[1]!.token)
      let next: Awaited<ReturnType<typeof transport.read>> | undefined
      void transport.read(owner, 'next', 128, 128).then(frame => { next = frame }, () => {})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(next).toBeDefined()
      expect(pools[0]!.uploadFile).toHaveBeenCalledTimes(1)
      expect(pools[1]!.uploadFile).toHaveBeenLastCalledWith('next', 0)
      expect(pools).toHaveLength(3)
      transport.release(owner, next!.token)
    } finally { transport.close(owner) }
  })

  it('bounds allocation waits while retired imports remain held, then recovers on release', async () => {
    vi.useFakeTimers()
    const released: (() => void)[] = []
    for (let i = 0; i < 8; i++) {
      vi.mocked(sharedTexture.importSharedTexture).mockImplementationOnce(options => {
        released.push(options.allReferencesReleased!)
        return { release: vi.fn() } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>
      })
    }
    const { owner, pools, transport } = fixture()
    try {
      for (let i = 0; i < 8; i++) {
        const frame = await transport.read(owner, 'frame', 128 + i, 128)
        transport.release(owner, frame.token)
      }
      const settled = vi.fn()
      void transport.read(owner, 'blocked', 256, 128).then(settled, error => settled(error.message))
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).toHaveBeenCalledWith(expect.stringContaining('budget'))
      // Later frames must take the caller's CPU fallback immediately, rather
      // than each waiting through the same unavailable allocation.
      await expect(transport.read(owner, 'next', 256, 128)).rejects.toThrow('budget')
      expect(pools).toHaveLength(8)
      for (const pool of pools) expect(pool.close).not.toHaveBeenCalled()
      released.shift()!()
      const recovered = await transport.read(owner, 'recovered', 256, 128)
      expect(pools).toHaveLength(9)
      transport.release(owner, recovered.token)
    } finally {
      transport.close(owner)
      released.forEach(release => release())
    }
  })

  it('keeps retired allocations in the budget until Electron releases all references', async () => {
    let releaseReferences!: () => void
    vi.mocked(sharedTexture.importSharedTexture).mockImplementationOnce((options) => {
      releaseReferences = options.allReferencesReleased!
      return { release: vi.fn() } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>
    })
    const { owner, pools, transport } = fixture(3)
    const a = await transport.read(owner, 'a', 4096, 4096)
    const b = await transport.read(owner, 'b', 4096, 4096)
    const c = transport.read(owner, 'c', 4096, 4096)
    transport.release(owner, a.token)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pools).toHaveLength(2)
    expect(pools[0]!.close).not.toHaveBeenCalled()
    releaseReferences()
    const third = await c
    expect(pools).toHaveLength(3)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, b.token)
    transport.release(owner, third.token)
    transport.close(owner)
  })

  it('retires a timed-out lane and never reuses its unfinished resource', async () => {
    vi.useFakeTimers()
    const { owner, pools, transport } = fixture()
    const a = await transport.read(owner, 'a', 128, 128)
    const next = transport.read(owner, 'b', 128, 128)
    await vi.advanceTimersByTimeAsync(5000)
    const b = await next
    expect(b.key).not.toBe(a.key)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, b.token)
    transport.close(owner)
  })

  it('reserves budget across concurrent imports and never evicts a busy slot', async () => {
    const { owner, pools, transport } = fixture(3)
    const a = transport.read(owner, 'a', 4096, 4096)
    const b = transport.read(owner, 'b', 4096, 4096)
    const c = transport.read(owner, 'c', 4096, 4096)
    const frames = await Promise.all([a, b])
    expect(pools).toHaveLength(2) // two 64 MiB allocations exhaust the budget
    expect(pools.every(pool => pool.close.mock.calls.length === 0)).toBe(true)
    transport.release(owner, frames[0]!.token)
    const third = await c
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    expect(pools[1]!.close).not.toHaveBeenCalled()
    transport.release(owner, frames[1]!.token)
    transport.release(owner, third.token)
    transport.close(owner)
  })

  it('a failed consumer retires only its own lane', async () => {
    const { owner, pools, transport } = fixture(3)
    const frames = await Promise.all(['a', 'b', 'c'].map(file => transport.read(owner, file, 128, 128)))
    transport.release(owner, frames[0]!.token, true)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    expect(pools[1]!.close).not.toHaveBeenCalled()
    expect(pools[2]!.close).not.toHaveBeenCalled()
    frames.slice(1).forEach(frame => transport.release(owner, frame.token))
    transport.close(owner)
  })

  it('close cancels queued requests instead of reopening textures for the old consumer', async () => {
    const { owner, transport } = fixture()
    await transport.read(owner, 'a', 128, 128)
    const next = transport.read(owner, 'b', 128, 128)
    const rejected = expect(next).rejects.toThrow('Motif consumer closed')
    transport.close(owner)
    await rejected
    // A new generation for the same WebContents (e.g. reload) can open again.
    const fresh = await transport.read(owner, 'c', 128, 128)
    transport.release(owner, fresh.token)
    transport.close(owner)
  })

  it('pipelines three frames while retaining each unacknowledged slot', async () => {
    const { owner, pools, transport } = fixture(3)
    const requests = ['a', 'b', 'c'].map(file => transport.read(owner, file, 128, 128))
    await vi.waitFor(() => expect(pools.reduce((n, p) => n + p.uploadFile.mock.calls.length, 0)).toBe(3), { timeout: 500 })
    const frames = await Promise.all(requests)
    expect(new Set(frames.map(frame => frame.key)).size).toBe(3)
    const fourth = transport.read(owner, 'd', 128, 128)
    await Promise.resolve()
    expect(pools.reduce((n, p) => n + p.uploadFile.mock.calls.length, 0)).toBe(3)
    transport.release(owner, frames[0]!.token)
    const next = await fourth
    expect(next.key).toBe(frames[0]!.key)
    for (const frame of [...frames.slice(1), next]) transport.release(owner, frame.token)
    transport.close(owner)
    for (const pool of pools) expect(pool.close).toHaveBeenCalledOnce()
  })

  it('never overwrites a slot before its owner acknowledges the completed read', async () => {
    const { owner, pools, transport, create } = fixture()
    const a = await transport.read(owner, 'a', 128, 128)
    const next = transport.read(owner, 'b', 128, 128)
    await Promise.resolve()
    expect(pools[0]!.uploadFile).toHaveBeenCalledTimes(1)
    transport.release({ id: 2 } as WebContents, a.token) // another renderer cannot release it
    await Promise.resolve()
    expect(pools[0]!.uploadFile).toHaveBeenCalledTimes(1)
    transport.release(owner, a.token)
    const b = await next
    expect(create).toHaveBeenCalledTimes(1)
    expect(a.key).toBe(b.key)
    expect(pools[0]!.uploadFile).toHaveBeenCalledTimes(2)
    transport.release(owner, b.token)
    transport.close(owner)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
  })

  it('reuses pools when alternating dimensions and retires all on renderer close', async () => {
    const { owner, pools, transport, create } = fixture()
    for (const size of [128, 256, 128, 256]) {
      const frame = await transport.read(owner, 'frame', size, size)
      transport.release(owner, frame.token)
    }
    expect(create).toHaveBeenCalledTimes(2)
    transport.close(owner)
    for (const pool of pools) expect(pool.close).toHaveBeenCalledOnce()
  })

  it('retires a failed consumer slot instead of overwriting a possibly unfinished GPU read', async () => {
    const { owner, pools, transport, create } = fixture()
    const a = await transport.read(owner, 'a', 128, 128)
    transport.release(owner, a.token, true)
    const b = await transport.read(owner, 'b', 128, 128)
    expect(create).toHaveBeenCalledTimes(2)
    expect(a.key).not.toBe(b.key)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, b.token)
    transport.close(owner)
  })

  it('rolls back a failed upload and allows the next request to proceed', async () => {
    const { owner, pools, transport } = fixture()
    const a = await transport.read(owner, 'a', 128, 128)
    transport.release(owner, a.token)
    pools[0]!.uploadFile.mockRejectedValueOnce(new Error('corrupt frame'))
    await expect(transport.read(owner, 'b', 128, 128)).rejects.toThrow('corrupt frame')
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    const c = await transport.read(owner, 'c', 128, 128)
    transport.release(owner, c.token)
    transport.close(owner)
  })
})
