import { afterEach, describe, expect, it, vi } from 'vitest'
import { MotifReadBarrier } from './motifReadBarrier'

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage?: (event: { data: { id: number; bitmap: ImageBitmap; error?: string } }) => void
  onerror?: () => void
  onmessageerror?: () => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
}
function fixture() {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  const fallback = vi.fn(() => true)
  return { barrier: new MotifReadBarrier(fallback), fallback }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Motif shared-texture read barrier', () => {
  it('waits for the worker read to finish and returns the transferred bitmap', async () => {
    const { barrier, fallback } = fixture()
    const input = bitmap(), returned = bitmap()
    const settled = vi.fn()
    const result = barrier.complete(input).then(value => { settled(); return value })
    const worker = FakeWorker.instances[0]!
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, bitmap: input }, [input])
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
    worker.onmessage!({ data: { id: 1, bitmap: returned } })
    expect(await result).toBe(returned)
    expect(returned.close).not.toHaveBeenCalled()
  })

  it('matches overlapping requests by id without completing another lease', async () => {
    const { barrier } = fixture()
    const a = bitmap(), b = bitmap()
    const first = barrier.complete(a), second = barrier.complete(b)
    const worker = FakeWorker.instances[0]!
    worker.onmessage!({ data: { id: 2, bitmap: b } })
    expect(await second).toBe(b)
    worker.onmessage!({ data: { id: 1, bitmap: a } })
    expect(await first).toBe(a)
  })

  it('rejects every in-flight lease on timeout and closes late responses', async () => {
    vi.useFakeTimers()
    const { barrier, fallback } = fixture()
    const a = expect(barrier.complete(bitmap())).rejects.toThrow('timed out')
    const b = expect(barrier.complete(bitmap())).rejects.toThrow('timed out')
    const worker = FakeWorker.instances[0]!
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all([a, b])
    expect(worker.terminate).toHaveBeenCalledOnce()
    const late = bitmap()
    worker.onmessage!({ data: { id: 1, bitmap: late } })
    expect(late.close).toHaveBeenCalledOnce()
    const fresh = bitmap()
    expect(await barrier.complete(fresh)).toBe(fresh)
    expect(fallback).toHaveBeenCalledWith(fresh)
  })

  it('falls back when worker creation is blocked, never acknowledges a failed fallback', async () => {
    const { barrier, fallback } = fixture()
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked') } })
    const frame = bitmap()
    expect(await barrier.complete(frame)).toBe(frame)
    fallback.mockReturnValueOnce(false)
    await expect(barrier.complete(bitmap())).rejects.toThrow('unavailable')
  })

  it('a worker read error closes the returned bitmap and retires other pending reads', async () => {
    const { barrier, fallback } = fixture()
    const a = expect(barrier.complete(bitmap())).rejects.toThrow('read failed')
    const b = expect(barrier.complete(bitmap())).rejects.toThrow('read failed')
    const returned = bitmap()
    FakeWorker.instances[0]!.onmessage!({ data: { id: 1, bitmap: returned, error: 'read failed' } })
    await Promise.all([a, b])
    expect(returned.close).toHaveBeenCalledOnce()
    await barrier.complete(bitmap())
    expect(fallback).toHaveBeenCalledOnce()
  })
})
