import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMotifReaderHost } from './readerHost'

const hash = 'a'.repeat(32)
const root = path.join('workspace', 'project')
const timing = { readMs: 1, decodeMs: 2, hashMs: 3, scaleMs: 4 }

function fixture() {
  const read = vi.fn(async (_file: string, div: number) => ({ width: 8 / div, height: 4 / div, rgba: new Uint8Array(4), timing }))
  const report = vi.fn()
  const host = createMotifReaderHost({ read, report })
  return { host, read, report }
}

class Port extends EventEmitter {
  postMessage = vi.fn()
  start = vi.fn()
  close = vi.fn(() => { this.emit('close') })
}

describe('Motif reader utility', () => {
  it('validates the address and divisor before building any path', async () => {
    const { host, read } = fixture()
    host.control({ type: 'workspace', generation: 3, root })
    const invalid = [
      { hash: 'A'.repeat(32), frame: 0, div: 1 },
      { hash: `${'a'.repeat(31)}/`, frame: 0, div: 1 },
      { hash: '../'.repeat(11), frame: 0, div: 1 },
      { hash: 'a'.repeat(8), frame: 0, div: 1 },
      { hash, frame: -1, div: 1 },
      { hash, frame: 1.5, div: 1 },
      { hash, frame: Number.MAX_SAFE_INTEGER + 1, div: 1 },
      { hash, frame: '1', div: 1 },
      { hash, frame: 0, div: 3 },
      { hash, frame: 0, div: 0 },
      { hash, frame: 0, div: '2' },
    ]
    for (const [i, request] of invalid.entries()) {
      expect(await host.read({ id: i, ...request })).toEqual({ id: i, miss: true })
    }
    // Without a usable id there is nothing to answer.
    expect(await host.read({ id: 'x', hash, frame: 0, div: 1 })).toBeNull()
    expect(await host.read(null)).toBeNull()
    expect(read).not.toHaveBeenCalled()

    for (const div of [1, 2, 4]) {
      expect(await host.read({ id: 9, hash, frame: 12, div })).toEqual({
        id: 9, frame: { width: 8 / div, height: 4 / div, rgba: new Uint8Array(4), timing },
      })
      expect(read).toHaveBeenLastCalledWith(path.join(root, 'Cache', 'raster', hash, '12.wfrm'), div)
    }
  })

  it('follows the root and generation from main, with no root in a transition', async () => {
    const { host, read, report } = fixture()
    expect(await host.read({ id: 1, hash, frame: 0, div: 1 })).toEqual({ id: 1, miss: true })
    host.control({ type: 'workspace', generation: 4, root })
    await host.read({ id: 2, hash, frame: 0, div: 2 })
    expect(read).toHaveBeenLastCalledWith(path.join(root, 'Cache', 'raster', hash, '0.wfrm'), 2)

    host.control({ type: 'workspace', generation: null, root: null })
    expect(await host.read({ id: 3, hash, frame: 0, div: 1 })).toEqual({ id: 3, miss: true })
    host.control({ type: 'workspace', generation: 5, root: null })
    expect(await host.read({ id: 4, hash, frame: 0, div: 1 })).toEqual({ id: 4, miss: true })
    expect(read).toHaveBeenCalledTimes(1)
    expect(report).not.toHaveBeenCalled()

    const next = path.join('workspace', 'next')
    host.control({ type: 'workspace', generation: 6, root: next })
    await host.read({ id: 5, hash, frame: 1, div: 1 })
    expect(read).toHaveBeenLastCalledWith(path.join(next, 'Cache', 'raster', hash, '1.wfrm'), 1)
  })

  it('reports a file miss with the generation that named it, and keeps other failures distinct', async () => {
    const { host, read, report } = fixture()
    host.control({ type: 'workspace', generation: 7, root })
    let fail!: (error: Error) => void
    read.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = host.read({ id: 1, hash, frame: 2, div: 1 })
    host.control({ type: 'workspace', generation: 8, root })
    fail(new Error('motif-frame: BLAKE3 mismatch'))
    expect(await pending).toEqual({ id: 1, miss: true })
    expect(report).toHaveBeenCalledWith({ type: 'miss', generation: 7, hash, frame: 2 })

    read.mockRejectedValueOnce(new Error('invalid divisor'))
    expect(await host.read({ id: 2, hash, frame: 3, div: 1 })).toEqual({ id: 2, error: 'invalid divisor' })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('acknowledges each document port once attached and answers on it until it is retired or closed', async () => {
    const { host, report } = fixture()
    host.control({ type: 'workspace', generation: 1, root })
    const a = new Port()
    const b = new Port()
    report.mockImplementationOnce(() => expect(a.start).toHaveBeenCalled())
    host.control({ type: 'port', id: 1 }, [a])
    host.control({ type: 'port', id: 2 }, [b])
    expect(report.mock.calls).toEqual([[{ type: 'port-ready', id: 1 }], [{ type: 'port-ready', id: 2 }]])
    expect(host.ports).toBe(2)

    a.emit('message', { data: { id: 10, hash, frame: 0, div: 2 } })
    await vi.waitFor(() => expect(a.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 10, frame: expect.any(Object) })))

    host.control({ type: 'retire', id: 1 })
    expect(a.close).toHaveBeenCalled()
    b.emit('close')
    expect(host.ports).toBe(0)
    // A port without its transferred end is ignored.
    host.control({ type: 'port', id: 3 }, [])
    expect(host.ports).toBe(0)
    expect(report).toHaveBeenCalledTimes(2)
  })
})
