import { describe, expect, it, vi } from 'vitest'
import { MotifFrameWriteQueue, type FrameRead } from './frameWriteQueue'

const store = {}
const at = (frame: number) => ({ hash: 'a'.repeat(32), frame })

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
    const queue = new MotifFrameWriteQueue(), write = heldWrite()
    const queued = await queue.offer(store, at(0), 'wait', write.read)
    let written = false
    void queued.written.then(() => { written = true })
    await vi.waitFor(() => expect(write.store).toHaveBeenCalledOnce())
    expect(written).toBe(false)
    write.finish()
    await queued.written
  })

  it('skips without reading once two frames are in flight, and takes a frame again after one ends', async () => {
    const queue = new MotifFrameWriteQueue(), one = heldWrite(), two = heldWrite(), three = heldWrite()
    const first = await queue.offer(store, at(0), 'skip', one.read)
    await queue.offer(store, at(1), 'skip', two.read)
    expect(await queue.offer(store, at(2), 'skip', three.read)).toBeNull()
    expect(three.read).not.toHaveBeenCalled()
    one.finish()
    await first!.written
    await expect(queue.offer(store, at(2), 'skip', three.read)).resolves.not.toBeNull()
    expect(three.read).toHaveBeenCalledOnce()
  })

  it('makes a kept frame wait for a slot, in the order they asked', async () => {
    const queue = new MotifFrameWriteQueue(), one = heldWrite(), two = heldWrite(), three = heldWrite(), four = heldWrite()
    const first = await queue.offer(store, at(0), 'wait', one.read)
    await queue.offer(store, at(1), 'wait', two.read)
    const third = queue.offer(store, at(2), 'wait', three.read)
    const fourth = queue.offer(store, at(3), 'wait', four.read)
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

  it('never reads an address twice while it is being written', async () => {
    const queue = new MotifFrameWriteQueue(), one = heldWrite(), again = heldWrite()
    const first = await queue.offer(store, at(0), 'skip', one.read)
    const second = await queue.offer(store, at(0), 'wait', again.read)
    expect(second.written).toBe(first!.written)
    expect(queue.inFlight(store, at(0))).toBe(first!.written)
    expect(again.read).not.toHaveBeenCalled()
    one.finish()
    await second.written
    expect(queue.inFlight(store, at(0))).toBeUndefined()
  })

  it('joins a write still waiting for its slot, without a read of its own', async () => {
    const queue = new MotifFrameWriteQueue(), one = heldWrite(), two = heldWrite(), waiter = heldWrite(), same = heldWrite()
    const first = await queue.offer(store, at(0), 'wait', one.read)
    await queue.offer(store, at(1), 'wait', two.read)
    const waiting = queue.offer(store, at(2), 'wait', waiter.read)
    const joined = await queue.offer(store, at(2), 'wait', same.read)
    one.finish()
    await first.written
    expect((await waiting).written).toBe(joined.written)
    expect(same.read).not.toHaveBeenCalled()
  })

  it('keeps stores apart: another workspace writes the same address itself', async () => {
    const queue = new MotifFrameWriteQueue(), one = heldWrite(), other = heldWrite()
    await queue.offer(store, at(0), 'wait', one.read)
    await queue.offer({}, at(0), 'wait', other.read)
    expect(other.read).toHaveBeenCalledOnce()
  })

  it('a failed read rejects the offer and frees its slot', async () => {
    const queue = new MotifFrameWriteQueue(), hold = heldWrite(), next = heldWrite()
    await queue.offer(store, at(0), 'wait', hold.read)
    await expect(queue.offer(store, at(1), 'wait', async () => { throw new Error('device lost') })).rejects.toThrow('device lost')
    expect(queue.inFlight(store, at(1))).toBeUndefined()
    await expect(queue.offer(store, at(1), 'skip', next.read)).resolves.not.toBeNull()
  })

  it('a failed store step rejects written, frees its slot, and lets the address be retried', async () => {
    const queue = new MotifFrameWriteQueue(), failing = heldWrite(), retry = heldWrite()
    const first = await queue.offer(store, at(0), 'wait', failing.read)
    failing.fail(new Error('disk full'))
    await expect(first.written).rejects.toThrow('disk full')
    const second = await queue.offer(store, at(0), 'skip', retry.read)
    expect(retry.read).toHaveBeenCalledOnce()
    retry.finish()
    await second!.written
  })

  it('an unobserved failure is not an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const queue = new MotifFrameWriteQueue(), failing = heldWrite()
      await queue.offer(store, at(0), 'skip', failing.read)
      failing.fail(new Error('disk full'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
})
