import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MotifGpuTransport } from './gpuTransport'

vi.mock('electron', () => ({ sharedTexture: {
  importSharedTexture: ({ allReferencesReleased }: { allReferencesReleased: () => void }) => ({ release: allReferencesReleased }),
  sendSharedTexture: vi.fn(async () => {}),
} }))
function fixture() {
  const owner = { id: 1, isDestroyed: () => false, send: vi.fn(), mainFrame: {} } as unknown as WebContents
  const pools: { handles: ReturnType<typeof vi.fn>; uploadFile: ReturnType<typeof vi.fn>; copyTexture: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  const create = vi.fn(() => {
    const pool = { handles: vi.fn(() => [Buffer.alloc(8)]), uploadFile: vi.fn(async () => {}), copyTexture: vi.fn(async () => {}), close: vi.fn() }
    pools.push(pool)
    return pool
  })
  return { owner, pools, create, transport: new MotifGpuTransport(create) }
}

describe('Motif GPU leases', () => {
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
