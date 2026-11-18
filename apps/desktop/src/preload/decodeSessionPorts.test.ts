import { describe, expect, it, vi } from 'vitest'
import { createDecodeSessionPorts } from './decodeSessionPorts'
import type { DecodeCommand, DecodeWireMsg } from '../shared/frameCarrier/wire'

const frame = (lease: number, data: Uint8Array): DecodeWireMsg =>
  ({ kind: 'bytes', lease, ptsUs: lease * 10, durUs: 1, width: 2, height: 2, format: 'NV12', data })

/** Collects what arrives on a consumer's port until `count` messages are in. */
function received(port: MessagePort, count: number): Promise<DecodeWireMsg[]> {
  return new Promise(resolve => {
    const got: DecodeWireMsg[] = []
    port.onmessage = event => {
      got.push(event.data as DecodeWireMsg)
      if (got.length === count) { port.close(); resolve(got) }
    }
  })
}

describe('decode session ports', () => {
  it('hands the consumer every message of its session in the order main sent them', async () => {
    const ports = createDecodeSessionPorts(() => {})
    const consumer = ports.open('a')
    const arrived = received(consumer, 4)
    ports.deliver('a', frame(1, new Uint8Array([1, 2, 3, 4, 5, 6])))
    ports.deliver('a', { kind: 'mark', aUs: 0, bUs: 10 })
    ports.deliver('a', frame(2, new Uint8Array(6)))
    ports.deliver('a', { kind: 'end' })
    const got = await arrived
    expect(got.map(m => m.kind)).toEqual(['bytes', 'mark', 'bytes', 'end'])
    expect(got[0]).toMatchObject({ lease: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6]) })
    ports.end('a')
  })

  it("moves a frame's buffer to the consumer instead of copying it", async () => {
    const ports = createDecodeSessionPorts(() => {})
    const consumer = ports.open('a')
    const arrived = received(consumer, 1)
    const data = new Uint8Array([9, 8, 7, 6, 5, 4])
    ports.deliver('a', frame(1, data))
    expect(data.byteLength, 'the sender no longer holds the bytes').toBe(0)
    expect((await arrived)[0]).toMatchObject({ data: new Uint8Array([9, 8, 7, 6, 5, 4]) })
    ports.end('a')
  })

  it('sends only its own bytes when a frame is a view into a larger buffer', async () => {
    const ports = createDecodeSessionPorts(() => {})
    const consumer = ports.open('a')
    const arrived = received(consumer, 1)
    const pool = new Uint8Array([0, 0, 1, 2, 3, 4, 5, 6, 0, 0])
    ports.deliver('a', frame(1, pool.subarray(2, 8)))
    const [msg] = await arrived
    expect(msg).toMatchObject({ data: new Uint8Array([1, 2, 3, 4, 5, 6]) })
    expect(pool.byteLength, 'the shared buffer stays with its owner').toBe(10)
    ports.end('a')
  })

  it("keeps each session's messages on its own port", async () => {
    const ports = createDecodeSessionPorts(() => {})
    const a = received(ports.open('a'), 1)
    const b = received(ports.open('b'), 1)
    ports.deliver('b', { kind: 'mark', aUs: 5, bUs: 6 })
    ports.deliver('a', { kind: 'end' })
    expect(await a).toEqual([{ kind: 'end' }])
    expect(await b).toEqual([{ kind: 'mark', aUs: 5, bUs: 6 }])
    ports.end('a')
    ports.end('b')
  })

  it("forwards a consumer's commands tagged with its session", async () => {
    const sent: [string, DecodeCommand][] = []
    const done = new Promise<void>(resolve => {
      const ports = createDecodeSessionPorts((sessionId, cmd) => {
        sent.push([sessionId, cmd])
        if (sent.length === 2) { ports.end('a'); resolve() }
      })
      const consumer = ports.open('a')
      consumer.postMessage({ type: 'range', aUs: 0, bUs: 100 })
      consumer.postMessage({ type: 'release', lease: 3 })
      consumer.close()
    })
    await done
    expect(sent).toEqual([
      ['a', { type: 'range', aUs: 0, bUs: 100 }],
      ['a', { type: 'release', lease: 3 }],
    ])
  })

  it('drops a message for a session that has ended or never opened', () => {
    const ports = createDecodeSessionPorts(vi.fn())
    ports.open('a')
    ports.end('a')
    expect(() => {
      ports.deliver('a', { kind: 'end' })
      ports.deliver('never', frame(1, new Uint8Array(6)))
      ports.end('never')
    }).not.toThrow()
  })
})
