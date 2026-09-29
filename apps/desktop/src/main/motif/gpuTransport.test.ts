import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedTexture, type WebContents } from 'electron'
import { MotifGpuTransport } from './gpuTransport'

vi.mock('electron', () => ({ sharedTexture: {
  importSharedTexture: vi.fn(({ allReferencesReleased }: { allReferencesReleased: () => void }) => ({ release: allReferencesReleased })),
  sendSharedTexture: vi.fn(async () => {}),
} }))
afterEach(() => vi.useRealTimers())
function fixture(concurrency = 1) {
  const owner = { id: 1, isDestroyed: () => false, send: vi.fn(), mainFrame: {} } as unknown as WebContents
  const pools: { handles: ReturnType<typeof vi.fn>; uploadFile: ReturnType<typeof vi.fn>; copyTexture: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  const create = vi.fn(() => {
    const pool = { handles: vi.fn(() => [Buffer.alloc(8)]), uploadFile: vi.fn(async () => {}), copyTexture: vi.fn(async () => {}), close: vi.fn() }
    pools.push(pool)
    return pool
  })
  return { owner, pools, create, transport: new MotifGpuTransport(create, concurrency) }
}

describe('Motif GPU leases', () => {
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
