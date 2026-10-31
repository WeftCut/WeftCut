import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedTexture, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MotifGpuTransport } from './gpuTransport'
import { MotifFrameStore } from './frameStore'
import { MIB, hydratePerformanceSettings, performanceSettings } from '../../shared/performance-settings'
import { createGpuBufferBudget } from '../gpuBufferBudget'
import type { MotifReadUnavailable, MotifTextureFrame, MotifUploadTiming } from '../../shared/motifs/frameTransport'

vi.mock('electron', () => ({ sharedTexture: {
  importSharedTexture: vi.fn(({ allReferencesReleased }: { allReferencesReleased: () => void }) => ({ release: allReferencesReleased })),
  sendSharedTexture: vi.fn(async () => {}),
} }))
afterEach(() => { vi.useRealTimers(); hydratePerformanceSettings(undefined) })
const timing: MotifUploadTiming = { read: { readMs: 1, decodeMs: 2, hashMs: 3, scaleMs: 4 }, premultiplyMs: 5, acquireMs: 6, gpuMs: 7 }
/** Most cases need a texture; an unavailable lane fails them like an error. */
async function texture(read: Promise<MotifTextureFrame | MotifReadUnavailable>): Promise<MotifTextureFrame> {
  const frame = await read
  if (frame.kind !== 'texture') throw new Error('Motif texture lane unavailable')
  return frame
}
function fixture(concurrency = 1) {
  const owner = { id: 1, isDestroyed: () => false, send: vi.fn(), mainFrame: { isDestroyed: vi.fn(() => false), detached: false } } as unknown as WebContents
  const pools: { handles: ReturnType<typeof vi.fn>; uploadFile: ReturnType<typeof vi.fn>; copyTexture: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  const create = vi.fn(() => {
    const pool = { handles: vi.fn(() => [Buffer.alloc(8)]), uploadFile: vi.fn(async (_path: string, _slot: number, _div?: number) => timing), copyTexture: vi.fn(async () => {}), close: vi.fn() }
    pools.push(pool)
    return pool
  })
  const buffers = createGpuBufferBudget(() => performanceSettings().gpu_buffer_mib * MIB)
  return { owner, pools, create, buffers, transport: new MotifGpuTransport(create, concurrency, buffers) }
}

describe('Motif GPU leases', () => {
  it('bounds resource admission waits: a read becomes unavailable, a capture keeps the capacity failure', async () => {
    vi.useFakeTimers();
    const { owner, transport, buffers, create } = fixture();
    const denied = new Error('resource-capacity-exceeded');
    vi.spyOn(buffers, 'reserve').mockImplementation(() => { throw denied; });
    const read = transport.read(owner, 'blocked', 1920, 1080, 1, 42);
    await vi.advanceTimersByTimeAsync(300);
    expect(await read).toEqual({ kind: 'unavailable' });
    const rejected = expect(transport.copy(owner, { textureInfo: {
      codedSize: { width: 1920, height: 1080 }, pixelFormat: 'bgra', handle: { ntHandle: Buffer.alloc(8) },
    } } as Parameters<typeof transport.copy>[1], 43)).rejects.toBe(denied);
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(create).not.toHaveBeenCalled();
    expect(buffers.snapshot().used_bytes).toBe(0);
  });
  it('waits for retired export pool credits when switching from cached RGBA to captured BGRA', async () => {
    const { owner, transport, buffers, create } = fixture();
    let finalReference!: () => void;
    const retired = vi.fn();
    vi.mocked(sharedTexture.importSharedTexture).mockImplementationOnce(({ allReferencesReleased }) => {
      finalReference = allReferencesReleased!;
      return { release: retired } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>;
    });
    const reserve = buffers.reserve.bind(buffers);
    vi.spyOn(buffers, 'reserve').mockImplementation((kind, bytes, parent) => {
      if (parent === 42 && buffers.snapshot().used_bytes > 0) throw new Error('resource-capacity-exceeded');
      return reserve(kind, bytes, parent);
    });
    const cached = await texture(transport.read(owner, 'cached', 1920, 1080, 1, 42));
    transport.release(owner, cached.token);
    const copying = transport.copy(owner, { textureInfo: {
      codedSize: { width: 1920, height: 1080 }, pixelFormat: 'bgra', handle: { ntHandle: Buffer.alloc(8) },
    } } as Parameters<typeof transport.copy>[1], 42);
    // Observe rejection immediately too, so the regression doesn't leave an unhandled promise.
    const result = copying.then(frame => ({ frame }), error => ({ error }));
    await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce());
    finalReference();
    const outcome = await result;
    expect(outcome).not.toHaveProperty('error');
    if ('frame' in outcome) transport.release(owner, outcome.frame.token);
    expect(create).toHaveBeenCalledTimes(2);
    transport.closeExport(owner, 42);
    expect(buffers.snapshot().used_bytes).toBe(0);
  });
  it('reuses an idle export lane without requiring another pool while Chromium retains references', async () => {
    const {owner,transport,buffers,create}=fixture(3);
    let finalReference!:()=>void;
    vi.mocked(sharedTexture.importSharedTexture).mockImplementationOnce(({allReferencesReleased})=>{
      finalReference=allReferencesReleased!;
      return {release:vi.fn()} as unknown as ReturnType<typeof sharedTexture.importSharedTexture>;
    });
    const reserve=buffers.reserve.bind(buffers);
    vi.spyOn(buffers,'reserve').mockImplementation((kind,bytes,parent)=>{
      // The minimum export plan admits one GPU pool. Retiring it does not
      // release its credit until Chromium delivers the final-reference event.
      if(parent===42 && buffers.snapshot().used_bytes>0) throw new Error('resource-capacity-exceeded');
      return reserve(kind,bytes,parent);
    });
    const first=await texture(transport.read(owner, 'first', 1920, 1080, 1, 42));
    transport.release(owner,first.token);
    const second=await texture(transport.read(owner, 'second', 1920, 1080, 1, 42));
    expect(second.key).toBe(first.key);
    expect(create).toHaveBeenCalledOnce();
    transport.release(owner,second.token); transport.closeExport(owner,42); finalReference();
    expect(buffers.snapshot().used_bytes).toBe(0);
  });
  it('cancelling an export during GPU import cannot leave a late resident pool', async () => {
    const {owner, transport, buffers, pools}=fixture();
    let finish!: () => void;
    vi.mocked(sharedTexture.sendSharedTexture).mockImplementationOnce(() => new Promise<void>(resolve => {finish=resolve}));
    const reading=texture(transport.read(owner, 'late', 128, 128, 1, 42));
    const rejected=expect(reading).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    transport.closeExport(owner,42);
    finish();
    await rejected;
    expect(buffers.snapshot().used_bytes).toBe(0);
    expect(pools[0]!.close).toHaveBeenCalledOnce();
  });
  it('keeps export textures in their parent ledger until final references are released', async () => {
    const { owner, transport, buffers }=fixture();
    const reserve=vi.spyOn(buffers,'reserve');
    let finalReference!: () => void;
    vi.mocked(sharedTexture.importSharedTexture).mockImplementationOnce(({allReferencesReleased}) => {
      finalReference=allReferencesReleased!;
      return {release:vi.fn()} as unknown as ReturnType<typeof sharedTexture.importSharedTexture>;
    });
    const frame=await texture(transport.read(owner, 'export', 128, 128, 1, 42));
    expect(reserve).toHaveBeenCalledWith('motif',128*128*4,42);
    transport.release(owner,frame.token);
    transport.closeExport(owner,41);
    expect(buffers.snapshot().used_bytes).toBe(128*128*4);
    transport.closeExport(owner,42);
    expect(buffers.snapshot().used_bytes).toBe(128*128*4);
    finalReference();
    expect(buffers.snapshot().used_bytes).toBe(0);
  });
  it('borrows unused video memory in budget mode while legacy mode retains its own cap', async () => {
    hydratePerformanceSettings({ gpu_buffer_mib: 256, motif_gpu_mib: 16 }, null, true)
    const { owner, buffers, transport } = fixture()
    const frame = await texture(transport.read(owner, 'borrowed', 4096, 2048, 1))
    expect(buffers.snapshot().motif_bytes).toBe(32 * MIB)
    transport.release(owner, frame.token)
    transport.close(owner)
    hydratePerformanceSettings({ gpu_buffer_mib: 256, motif_gpu_mib: 16 })
    expect(await transport.read(owner, 'legacy', 4096, 2048, 1)).toEqual({ kind: 'unavailable' })
  })
  it('shares the byte limit with video and retries after video releases capacity', async () => {
    hydratePerformanceSettings({ gpu_buffer_mib: 64 })
    const { owner, buffers, transport, create } = fixture()
    const video = buffers.reserve('preview', 60 * MIB)!
    expect(await transport.read(owner, 'blocked', 2048, 1024, 1)).toEqual({ kind: 'unavailable' })
    expect(create).not.toHaveBeenCalled()
    buffers.release(video)
    const frame = await texture(transport.read(owner, 'allowed', 2048, 1024, 1))
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
    const frame = await texture(transport.read(owner, 'held', 2048, 1024, 1))
    transport.release(owner, frame.token)
    transport.close(owner)
    expect(buffers.snapshot().motif_bytes).toBe(8 * MIB)
    finalReference()
    expect(buffers.snapshot().motif_bytes).toBe(0)
  })
  it('reads changed allocation budgets without closing a leased texture', async () => {
    const { owner, pools, transport } = fixture(2)
    const first = await texture(transport.read(owner, 'first', 4096, 2048, 1))
    hydratePerformanceSettings({ motif_gpu_mib: 16 })
    expect(await transport.read(owner, 'too-large', 2048, 4096, 1)).toEqual({ kind: 'unavailable' })
    expect(pools[0]!.close).not.toHaveBeenCalled()
    transport.release(owner, first.token)
    hydratePerformanceSettings({ motif_gpu_mib: 64, motif_gpu_sessions: 1 })
    const second = await texture(transport.read(owner, 'replacement', 2048, 4096, 1))
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, second.token)
    transport.close(owner)
  })

  it('rejects work for a disposed frame before allocating or announcing a texture', async () => {
    const { owner, create, transport } = fixture()
    vi.mocked(owner.mainFrame.isDestroyed).mockReturnValue(true)
    await expect(texture(transport.read(owner, 'a', 128, 128, 1))).rejects.toThrow('Motif consumer closed')
    expect(create).not.toHaveBeenCalled()
    expect(owner.send).not.toHaveBeenCalled()
  })

  it('retires an import finishing after close and allows the replacement document to read', async () => {
    const { owner, pools, transport } = fixture()
    let finish!: () => void
    vi.mocked(sharedTexture.sendSharedTexture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const read = texture(transport.read(owner, 'old', 128, 128, 1))
    const rejected = expect(read).rejects.toThrow('Motif consumer closed')
    await vi.waitFor(() => expect(finish).toBeDefined())
    transport.close(owner)
    expect(pools[0]!.close).not.toHaveBeenCalled()
    finish()
    await rejected
    expect(pools[0]!.uploadFile).not.toHaveBeenCalled()
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    const fresh = await texture(transport.read(owner, 'new', 128, 128, 1))
    transport.release(owner, fresh.token)
    transport.close(owner)
    expect(pools[1]!.close).toHaveBeenCalledOnce()
  })

  it('does not deliver a texture when close races an in-flight upload', async () => {
    const { owner, pools, transport } = fixture()
    const frame = await texture(transport.read(owner, 'first', 128, 128, 1))
    transport.release(owner, frame.token)
    let finish!: () => void
    pools[0]!.uploadFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const rejected = expect(texture(transport.read(owner, 'old', 128, 128, 1))).rejects.toThrow('Motif consumer closed')
    await vi.waitFor(() => expect(finish).toBeDefined())
    transport.close(owner)
    finish()
    await rejected
    const fresh = await texture(transport.read(owner, 'new', 128, 128, 1))
    expect(fresh.key).not.toBe(frame.key)
    transport.release(owner, fresh.token)
    transport.close(owner)
    for (const pool of pools) expect(pool.close).toHaveBeenCalledOnce()
  })

  it.each(['destroyed', 'detached', 'inaccessible'] as const)('does not send to a %s frame while WebContents is still alive', async state => {
    const { owner, pools, transport } = fixture(3)
    await Promise.all(['a', 'b', 'c'].map(file => texture(transport.read(owner, file, 128, 128, 1))))
    const queued = texture(transport.read(owner, 'queued', 128, 128, 1))
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
    await texture(transport.read(owner, 'a', 128, 128, 1))
    const rejected = expect(texture(transport.read(owner, 'queued', 128, 128, 1))).rejects.toThrow('Motif consumer closed')
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
    expect(await transport.read(owner, 'a', 128, 128, 1)).toEqual({ kind: 'unavailable' })
    expect(owner.send).not.toHaveBeenCalled()
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.close(owner)
  })

  it('uses an acknowledged lane while a sibling still holds its lease', async () => {
    const { owner, pools, transport } = fixture(3)
    try {
      const frames = await Promise.all(['a', 'b', 'c'].map(file => texture(transport.read(owner, file, 128, 128, 1))))
      transport.release(owner, frames[1]!.token)
      let next: MotifTextureFrame | undefined
      void texture(transport.read(owner, 'next', 128, 128, 1)).then(frame => { next = frame }, () => {})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(next).toBeDefined()
      expect(pools[0]!.uploadFile).toHaveBeenCalledTimes(1)
      expect(pools[1]!.uploadFile).toHaveBeenLastCalledWith('next', 0, 1)
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
        const frame = await texture(transport.read(owner, 'frame', 128 + i, 128, 1))
        transport.release(owner, frame.token)
      }
      const settled = vi.fn()
      void transport.read(owner, 'blocked', 256, 128, 1).then(settled, error => settled(error.message))
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).toHaveBeenCalledWith({ kind: 'unavailable' })
      // Later frames must take the utility lane immediately, rather than each
      // waiting through the same unavailable allocation.
      expect(await transport.read(owner, 'next', 256, 128, 1)).toEqual({ kind: 'unavailable' })
      expect(pools).toHaveLength(8)
      for (const pool of pools) expect(pool.close).not.toHaveBeenCalled()
      released.shift()!()
      const recovered = await texture(transport.read(owner, 'recovered', 256, 128, 1))
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
    const a = await texture(transport.read(owner, 'a', 4096, 4096, 1))
    const b = await texture(transport.read(owner, 'b', 4096, 4096, 1))
    const c = texture(transport.read(owner, 'c', 4096, 4096, 1))
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
    const a = await texture(transport.read(owner, 'a', 128, 128, 1))
    const next = texture(transport.read(owner, 'b', 128, 128, 1))
    await vi.advanceTimersByTimeAsync(5000)
    const b = await next
    expect(b.key).not.toBe(a.key)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, b.token)
    transport.close(owner)
  })

  it('reserves budget across concurrent imports and never evicts a busy slot', async () => {
    const { owner, pools, transport } = fixture(3)
    const a = texture(transport.read(owner, 'a', 4096, 4096, 1))
    const b = texture(transport.read(owner, 'b', 4096, 4096, 1))
    const c = texture(transport.read(owner, 'c', 4096, 4096, 1))
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
    const frames = await Promise.all(['a', 'b', 'c'].map(file => texture(transport.read(owner, file, 128, 128, 1))))
    transport.release(owner, frames[0]!.token, true)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    expect(pools[1]!.close).not.toHaveBeenCalled()
    expect(pools[2]!.close).not.toHaveBeenCalled()
    frames.slice(1).forEach(frame => transport.release(owner, frame.token))
    transport.close(owner)
  })

  it('close cancels queued requests instead of reopening textures for the old consumer', async () => {
    const { owner, transport } = fixture()
    await texture(transport.read(owner, 'a', 128, 128, 1))
    const next = texture(transport.read(owner, 'b', 128, 128, 1))
    const rejected = expect(next).rejects.toThrow('Motif consumer closed')
    transport.close(owner)
    await rejected
    // A new generation for the same WebContents (e.g. reload) can open again.
    const fresh = await texture(transport.read(owner, 'c', 128, 128, 1))
    transport.release(owner, fresh.token)
    transport.close(owner)
  })

  it('pipelines three frames while retaining each unacknowledged slot', async () => {
    const { owner, pools, transport } = fixture(3)
    const requests = ['a', 'b', 'c'].map(file => texture(transport.read(owner, file, 128, 128, 1)))
    await vi.waitFor(() => expect(pools.reduce((n, p) => n + p.uploadFile.mock.calls.length, 0)).toBe(3), { timeout: 500 })
    const frames = await Promise.all(requests)
    expect(new Set(frames.map(frame => frame.key)).size).toBe(3)
    const fourth = texture(transport.read(owner, 'd', 128, 128, 1))
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
    const a = await texture(transport.read(owner, 'a', 128, 128, 1))
    const next = texture(transport.read(owner, 'b', 128, 128, 1))
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
      const frame = await texture(transport.read(owner, 'frame', size, size, 1))
      transport.release(owner, frame.token)
    }
    expect(create).toHaveBeenCalledTimes(2)
    transport.close(owner)
    for (const pool of pools) expect(pool.close).toHaveBeenCalledOnce()
  })

  it('retires a failed consumer slot instead of overwriting a possibly unfinished GPU read', async () => {
    const { owner, pools, transport, create } = fixture()
    const a = await texture(transport.read(owner, 'a', 128, 128, 1))
    transport.release(owner, a.token, true)
    const b = await texture(transport.read(owner, 'b', 128, 128, 1))
    expect(create).toHaveBeenCalledTimes(2)
    expect(a.key).not.toBe(b.key)
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    transport.release(owner, b.token)
    transport.close(owner)
  })

  it.each([
    ['rejects a file failure for the caller\'s miss', 'motif-frame: BLAKE3 mismatch', 'reject'],
    ['answers a device failure as unavailable', 'Motif GPU upload timed out', 'unavailable'],
  ] as const)('rolls back a failed upload, %s, and allows the next request to proceed', async (_, message, outcome) => {
    const { owner, pools, transport } = fixture()
    const a = await texture(transport.read(owner, 'a', 128, 128, 1))
    transport.release(owner, a.token)
    pools[0]!.uploadFile.mockRejectedValueOnce(new Error(message))
    const read = transport.read(owner, 'b', 128, 128, 1)
    if (outcome === 'reject') await expect(read).rejects.toThrow(message)
    else expect(await read).toEqual({ kind: 'unavailable' })
    expect(pools[0]!.close).toHaveBeenCalledOnce()
    const c = await texture(transport.read(owner, 'c', 128, 128, 1))
    transport.release(owner, c.token)
    transport.close(owner)
  })

  it('keys sessions by the scaled size and uploads at the requested divisor', async () => {
    const { owner, pools, transport, create } = fixture()
    const half = await texture(transport.read(owner, 'half', 1921, 1081, 2))
    expect(half.timing).toEqual(timing)
    transport.release(owner, half.token)
    // A full-size frame of the same scaled size shares the session.
    const same = await texture(transport.read(owner, 'native', 1921, 1081, 1))
    expect(same.key).toBe(half.key)
    transport.release(owner, same.token)
    const quarter = await texture(transport.read(owner, 'quarter', 961, 541, 4))
    expect(quarter.key).not.toBe(half.key)
    transport.release(owner, quarter.token)
    expect(create.mock.calls).toEqual([[1921, 1081, false], [961, 541, false]])
    expect(pools[0]!.uploadFile.mock.calls).toEqual([['half', 0, 2], ['native', 0, 1]])
    expect(pools[1]!.uploadFile.mock.calls).toEqual([['quarter', 0, 4]])
    transport.close(owner)
  })

  it('answers an owner whose shared textures failed as unavailable until it closes', async () => {
    const { owner, create, transport } = fixture()
    create.mockImplementationOnce(() => { throw new Error('D3D11 device lost') })
    expect(await transport.read(owner, 'a', 128, 128, 1)).toEqual({ kind: 'unavailable' })
    expect(await transport.read(owner, 'b', 128, 128, 1)).toEqual({ kind: 'unavailable' })
    expect(create).toHaveBeenCalledOnce()
    transport.close(owner)
    const fresh = await texture(transport.read(owner, 'c', 128, 128, 1))
    transport.release(owner, fresh.token)
    transport.close(owner)
  })

  it('reads through the store: a native file failure is a miss, a device failure is not', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motif-gpu-store-test-'))
    try {
      const { owner, pools, transport, create } = fixture()
      const changed = vi.fn()
      const store = new MotifFrameStore(async () => root, { motifEncodePng: vi.fn() }, changed)
      const hash = 'c'.repeat(32)
      const bytes = Buffer.alloc(68)
      bytes.write('WCMFRM01'); bytes.writeUInt32LE(3841, 8); bytes.writeUInt32LE(2161, 12)
      await (await store.prepareWrite(hash, 0))!.encoded(bytes)
      changed.mockClear()
      const gpu = (file: string, width: number, height: number, div: 1 | 2 | 4) => transport.read(owner, file, width, height, div)
      const frame = await store.readTexture(hash, 0, 4, gpu)
      expect(frame).toMatchObject({ kind: 'texture' })
      transport.release(owner, (frame as MotifTextureFrame).token)
      expect(create).toHaveBeenLastCalledWith(961, 541, false)
      expect(pools[0]!.uploadFile).toHaveBeenLastCalledWith(path.join(root, 'Cache', 'raster', hash, '0.wfrm'), 0, 4)
      pools[0]!.uploadFile.mockRejectedValueOnce(new Error('D3D11 map failed'))
      expect(await store.readTexture(hash, 0, 4, gpu)).toEqual({ kind: 'unavailable' })
      expect(changed).not.toHaveBeenCalled()
      // The failed lane was retired; the next read opens another pool.
      transport.release(owner, ((await store.readTexture(hash, 0, 4, gpu)) as MotifTextureFrame).token)
      pools[1]!.uploadFile.mockRejectedValueOnce(new Error('motif-frame: BLAKE3 mismatch'))
      expect(await store.readTexture(hash, 0, 4, gpu)).toBeNull()
      expect(changed.mock.calls).toEqual([[hash, 0, false]])
      transport.close(owner)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
