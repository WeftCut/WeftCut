import { describe, expect, it, vi } from 'vitest'
import { MotifFrameWriteQueue, type FrameRead } from './frameWriteQueue'

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A read that finishes at once and a store step the test releases. */
function heldWrite() {
  const stored = deferred()
  const store_ = vi.fn(() => stored.promise)
  const read: FrameRead = vi.fn(async () => store_)
  return { read, store: store_, finish: stored.resolve, fail: stored.reject }
}

describe('MotifFrameWriteQueue', () => {
  it('hands the caller back after the read, before the store step finishes', async () => {
    const queue = new MotifFrameWriteQueue(2), write = heldWrite()
    const queued = await queue.offer('wait', write.read)
    let written = false
    void queued.written.then(() => { written = true })
    await vi.waitFor(() => expect(write.store).toHaveBeenCalledOnce())
    expect(written).toBe(false)
    write.finish()
    await queued.written
  })

  it('skips without reading once two frames are in flight, and takes a frame again after one ends', async () => {
    const queue = new MotifFrameWriteQueue(2), one = heldWrite(), two = heldWrite(), three = heldWrite()
    const first = await queue.offer('skip', one.read)
    await queue.offer('skip', two.read)
    expect(await queue.offer('skip', three.read)).toBeNull()
    expect(three.read).not.toHaveBeenCalled()
    one.finish()
    await first!.written
    await expect(queue.offer('skip', three.read)).resolves.not.toBeNull()
    expect(three.read).toHaveBeenCalledOnce()
  })

  it('holds as many frames as it has slots', async () => {
    expect(() => new MotifFrameWriteQueue(0)).toThrow()
    const queue = new MotifFrameWriteQueue(3), writes = [heldWrite(), heldWrite(), heldWrite(), heldWrite()]
    for (let i = 0; i < 3; i++) expect(await queue.offer('skip', writes[i]!.read)).not.toBeNull()
    expect(await queue.offer('skip', writes[3]!.read)).toBeNull()
    for (const write of writes) write.finish()
  })

  it('makes a kept frame wait for a slot, in the order they asked', async () => {
    const queue = new MotifFrameWriteQueue(2), one = heldWrite(), two = heldWrite(), three = heldWrite(), four = heldWrite()
    const first = await queue.offer('wait', one.read)
    await queue.offer('wait', two.read)
    const third = queue.offer('wait', three.read)
    const fourth = queue.offer('wait', four.read)
    await Promise.resolve()
    expect(three.read).not.toHaveBeenCalled()
    one.finish()
    await first.written
    await third
    expect(three.read).toHaveBeenCalledOnce()
    expect(four.read).not.toHaveBeenCalled()
    two.finish(); three.finish(); four.finish()
    await fourth
  })

  it('a failed read rejects the offer and frees its slot', async () => {
    const queue = new MotifFrameWriteQueue(2), hold = heldWrite(), next = heldWrite()
    await queue.offer('wait', hold.read)
    await expect(queue.offer('wait', async () => { throw new Error('device lost') })).rejects.toThrow('device lost')
    await expect(queue.offer('skip', next.read)).resolves.not.toBeNull()
  })

  it('a failed store step rejects written and frees its slot', async () => {
    const queue = new MotifFrameWriteQueue(2), failing = heldWrite(), retry = heldWrite()
    const first = await queue.offer('wait', failing.read)
    failing.fail(new Error('disk full'))
    await expect(first.written).rejects.toThrow('disk full')
    const second = await queue.offer('skip', retry.read)
    expect(retry.read).toHaveBeenCalledOnce()
    retry.finish()
    await second!.written
  })

  it('an unobserved failure is not an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const queue = new MotifFrameWriteQueue(2), failing = heldWrite()
      await queue.offer('skip', failing.read)
      failing.fail(new Error('disk full'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
})
