import { describe, expect, it, vi } from 'vitest'
import { serveSinkPort, type SinkPort } from './exportSinkPort'
import type { SinkPortReply } from '../shared/exportSinkPort'

function fakePort() {
  const listeners: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  const replies: SinkPortReply[] = []
  const port: SinkPort = {
    on: ((event: 'message' | 'close', listener: never) => { listeners[event] = listener }) as SinkPort['on'],
    postMessage: reply => { replies.push(reply) },
    start: () => {},
  }
  return { port, replies, send: (data: unknown) => listeners.message!({ data }), close: () => listeners.close!() }
}

/** After every write already queued has run. The writes here resolve without
 * timers, so one turn of the event loop runs the whole chain; not a time wait. */
const queuedWorkDone = () => new Promise(resolve => setImmediate(resolve))

describe('serveSinkPort', () => {
  it('writes frames in arrival order even when an earlier write is slower', async () => {
    const { port, replies, send } = fakePort()
    const order: number[] = []
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
    serveSinkPort(port, async frame => {
      // The first frame's write is held; the later ones must wait behind it.
      if (frame[0] === 0) await firstHeld
      order.push(frame[0]!)
    })
    for (let i = 0; i < 4; i++) send(new Uint8Array([i, 9, 9]))
    await queuedWorkDone()
    expect(order).toEqual([])
    releaseFirst()
    await vi.waitFor(() => expect(replies).toHaveLength(4))
    expect(order).toEqual([0, 1, 2, 3])
    expect(replies).toEqual([{ written: 1 }, { written: 2 }, { written: 3 }, { written: 4 }])
  })

  it('writes exactly the bytes of a view into a larger buffer', async () => {
    const { port, send } = fakePort()
    const seen: number[][] = []
    serveSinkPort(port, async frame => { seen.push([...frame]) })
    send(new Uint8Array([7, 1, 2, 3, 7]).subarray(1, 4))
    await vi.waitFor(() => expect(seen).toEqual([[1, 2, 3]]))
  })

  it('answers the first failure once and writes nothing after it', async () => {
    const { port, replies, send } = fakePort()
    const written: number[] = []
    serveSinkPort(port, async frame => {
      if (frame[0] === 1) throw new Error('ffmpeg stdin: broken pipe')
      written.push(frame[0]!)
    })
    for (let i = 0; i < 4; i++) send(new Uint8Array([i]))
    await queuedWorkDone()
    expect(written).toEqual([0])
    expect(replies).toEqual([{ written: 1 }, { error: 'ffmpeg stdin: broken pipe' }])
  })

  it('refuses a message that is not bytes', async () => {
    const { port, replies, send } = fakePort()
    const written: unknown[] = []
    serveSinkPort(port, async frame => { written.push(frame) })
    send({ not: 'bytes' })
    send(new Uint8Array([1]))
    await queuedWorkDone()
    expect(written).toEqual([])
    expect(replies).toEqual([{ error: 'A sink frame must be bytes' }])
  })

  it('stops writing once the renderer closes its end', async () => {
    const { port, send, close } = fakePort()
    const written: number[] = []
    serveSinkPort(port, async frame => { written.push(frame[0]!) })
    close()
    send(new Uint8Array([5]))
    await queuedWorkDone()
    expect(written).toEqual([])
  })
})
