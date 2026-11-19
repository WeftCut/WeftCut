import { describe, expect, it, vi } from 'vitest'
import { createDecodeSessionPorts } from './decodeSessionPorts'
import type { SlotReader } from './slotReader'
import type { DecodeCommand, DecodeWireMsg, SlotSessionMsg } from '../shared/frameCarrier/wire'

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

/** A bitmap stand-in that a port can transfer. */
const fakeBitmap = () => Object.assign(new ArrayBuffer(4), { close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> }

/** A slot reader whose reads the test settles, in any order it likes. */
function controlledSlots() {
  const reads: { key: string; slot: number; bitmap: ReturnType<typeof fakeBitmap>; settle: (failure?: Error) => void }[] = []
  const dropped: string[] = []
  const slots: Pick<SlotReader, 'read' | 'drop'> = {
    read: (key, slot) => new Promise((resolve, reject) => {
      const bitmap = fakeBitmap()
      reads.push({ key, slot, bitmap, settle: failure => failure ? reject(failure) : resolve({ bitmap, gvfMs: 0, cibMs: 0 }) })
    }),
    drop: key => { dropped.push(key) },
  }
  return { slots, reads, dropped }
}

const slotMsg = (slot: number): DecodeWireMsg => ({ kind: 'slot', slot, gen: slot + 10, ptsUs: slot * 10, durUs: 10 })

/** Ports whose consumer ends are kept by session id as they are handed over. */
function sessionPorts(
  sendCommand: (sessionId: string, cmd: DecodeCommand) => void = () => {},
  slots: Pick<SlotReader, 'read' | 'drop'> = controlledSlots().slots,
  closeSession: (sessionId: string) => Promise<void> = async () => {},
) {
  const handed = new Map<string, MessagePort>()
  const ports = createDecodeSessionPorts(sendCommand, closeSession, (sessionId, port) => { handed.set(sessionId, port) }, slots)
  /** Opens `sessionId` with an open that succeeds, and returns its consumer port. */
  const open = async (sessionId: string): Promise<MessagePort> => {
    await ports.openSession(sessionId, () => Promise.resolve({ width: 2 }))
    return handed.get(sessionId)!
  }
  return { ports, handed, open }
}

describe('decode session ports', () => {
  it('hands the consumer every message of its session in the order main sent them', async () => {
    const { ports, open } = sessionPorts()
    const consumer = await open('a')
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

  it('keeps what main delivers while the open is in flight for the consumer', async () => {
    const { ports, handed } = sessionPorts()
    let answer!: (info: { width: number }) => void
    const opening = ports.openSession('a', () => new Promise<{ width: number }>(resolve => { answer = resolve }))
    // Main has opened the session and sent its first message before the open
    // reply reaches the preload.
    ports.deliver('a', { kind: 'error', message: 'seek failed', terminal: false })
    answer({ width: 2 })
    await expect(opening).resolves.toEqual({ width: 2 })
    expect(await received(handed.get('a')!, 1)).toEqual([{ kind: 'error', message: 'seek failed', terminal: false }])
    ports.end('a')
  })

  it('hands no port over when the open fails, and drops what main sends for it', async () => {
    const { ports, handed } = sessionPorts()
    await expect(ports.openSession('a', () => Promise.reject(new Error('codec failed')))).rejects.toThrow('codec failed')
    expect(handed.size).toBe(0)
    expect(() => ports.deliver('a', { kind: 'end' })).not.toThrow()
  })

  it('closes in main a session it opened but could not hand over, before rejecting', async () => {
    const closed: string[] = []
    const ports = createDecodeSessionPorts(() => {}, async sessionId => { closed.push(sessionId) }, () => {
      throw new Error('hand-over failed')
    }, controlledSlots().slots)
    await expect(ports.openSession('a', () => Promise.resolve({ width: 2 }))).rejects.toThrow('hand-over failed')
    expect(closed).toEqual(['a'])
    // A refused open was never main's to close.
    await expect(ports.openSession('b', () => Promise.reject(new Error('codec failed')))).rejects.toThrow('codec failed')
    expect(closed).toEqual(['a'])
  })

  it("moves a frame's buffer to the consumer instead of copying it", async () => {
    const { ports, open } = sessionPorts()
    const arrived = received(await open('a'), 1)
    const data = new Uint8Array([9, 8, 7, 6, 5, 4])
    ports.deliver('a', frame(1, data))
    expect(data.byteLength, 'the sender no longer holds the bytes').toBe(0)
    expect((await arrived)[0]).toMatchObject({ data: new Uint8Array([9, 8, 7, 6, 5, 4]) })
    ports.end('a')
  })

  it('sends only its own bytes when a frame is a view into a larger buffer', async () => {
    const { ports, open } = sessionPorts()
    const arrived = received(await open('a'), 1)
    const pool = new Uint8Array([0, 0, 1, 2, 3, 4, 5, 6, 0, 0])
    ports.deliver('a', frame(1, pool.subarray(2, 8)))
    const [msg] = await arrived
    expect(msg).toMatchObject({ data: new Uint8Array([1, 2, 3, 4, 5, 6]) })
    expect(pool.byteLength, 'the shared buffer stays with its owner').toBe(10)
    ports.end('a')
  })

  it("keeps each session's messages on its own port", async () => {
    const { ports, open } = sessionPorts()
    const a = received(await open('a'), 1)
    const b = received(await open('b'), 1)
    ports.deliver('b', { kind: 'mark', aUs: 5, bUs: 6 })
    ports.deliver('a', { kind: 'end' })
    expect(await a).toEqual([{ kind: 'end' }])
    expect(await b).toEqual([{ kind: 'mark', aUs: 5, bUs: 6 }])
    ports.end('a')
    ports.end('b')
  })

  it("forwards a consumer's commands tagged with its session", async () => {
    const sent: [string, DecodeCommand][] = []
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve })
    const { ports, open } = sessionPorts((sessionId, cmd) => {
      sent.push([sessionId, cmd])
      if (sent.length === 2) { ports.end('a'); finished() }
    })
    const consumer = await open('a')
    consumer.postMessage({ type: 'request', targetUs: 0, requestId: 1 })
    consumer.postMessage({ type: 'release', lease: 3 })
    consumer.close()
    await done
    expect(sent).toEqual([
      ['a', { type: 'request', targetUs: 0, requestId: 1 }],
      ['a', { type: 'release', lease: 3 }],
    ])
  })

  it('closes in main straight away, ahead of commands still queued on the port, and delivers nothing more', async () => {
    const order: string[] = []
    const { slots, dropped } = controlledSlots()
    const { ports, open } = sessionPorts(
      (_sessionId, cmd) => { order.push(cmd.type) },
      slots,
      async sessionId => { order.push(`close ${sessionId}`) },
    )
    const consumer = await open('a')
    const got = vi.fn()
    consumer.onmessage = got
    consumer.postMessage({ type: 'release', lease: 3 })
    await ports.close('a')
    expect(order, 'close went out before the port delivered anything').toEqual(['close a'])
    expect(dropped, "the session's textures go with it").toEqual(['a'])
    ports.deliver('a', { kind: 'end' })
    await new Promise(resolve => setImmediate(resolve))
    expect(got).not.toHaveBeenCalled()
    consumer.close()
  })

  it("drops a session's textures when main ends it, or its open fails", async () => {
    const { slots, dropped } = controlledSlots()
    const { ports, open } = sessionPorts(() => {}, slots)
    await open('a')
    ports.end('a')
    await expect(ports.openSession('b', () => Promise.reject(new Error('hw-budget-exceeded')))).rejects.toThrow()
    expect(dropped).toEqual(['a', 'b'])
  })

  it('posts each slot as the bitmap its read made, in the session order, whatever order the reads finish in', async () => {
    const { slots, reads } = controlledSlots()
    const { ports, open } = sessionPorts(() => {}, slots)
    const arrived = received(await open('a'), 4) as unknown as Promise<SlotSessionMsg[]>
    ports.deliver('a', slotMsg(0))
    ports.deliver('a', slotMsg(1))
    ports.deliver('a', slotMsg(2))
    // `end` and `error` must not overtake a slot still being read.
    ports.deliver('a', { kind: 'end' })
    expect(reads.map(r => [r.key, r.slot]), 'reads start at once, not one after another').toEqual([['a', 0], ['a', 1], ['a', 2]])
    reads[2]!.settle()
    reads[1]!.settle(new Error('getVideoFrame failed'))
    reads[0]!.settle()
    const got = await arrived
    expect(got.map(m => m.kind === 'slot' ? `slot ${m.slot}/${m.gen}` : m.kind)).toEqual(['slot 0/10', 'slot 1/11', 'slot 2/12', 'end'])
    expect(got[0]).toMatchObject({ timing: { gvfMs: 0, cibMs: 0 } })
    expect(got[0]!.kind === 'slot' && got[0]!.bitmap, 'the bitmap travels with its slot').toBeTruthy()
    expect(got[1], 'a failed read still reaches the consumer, which owns the slot').toMatchObject({ kind: 'slot', slot: 1, gen: 11, error: 'getVideoFrame failed' })
    ports.end('a')
  })

  it('closes a bitmap whose read finishes after its session closed, instead of posting it', async () => {
    const { slots, reads } = controlledSlots()
    const { ports, open } = sessionPorts(() => {}, slots)
    await open('a')
    ports.deliver('a', slotMsg(0))
    await ports.close('a')
    reads[0]!.settle()
    await vi.waitFor(() => expect(reads[0]!.bitmap.close).toHaveBeenCalledOnce())
  })

  // The second open must not cost the first its port or, for a GPU session,
  // the textures its slots are read from.
  it('refuses a second open of a live session before asking main, and the first keeps working', async () => {
    const { slots, reads, dropped } = controlledSlots()
    const commands: [string, DecodeCommand][] = []
    let commanded!: () => void
    const released = new Promise<void>(resolve => { commanded = resolve })
    const closes: string[] = []
    const { ports, open } = sessionPorts(
      (sessionId, cmd) => { commands.push([sessionId, cmd]); commanded() },
      slots,
      async sessionId => { closes.push(sessionId) },
    )
    const consumer = await open('a')
    const got: SlotSessionMsg[] = []
    consumer.onmessage = event => { got.push(event.data as SlotSessionMsg) }
    // Main refuses a live id too; the preload must not get that far.
    const invoke = vi.fn(() => Promise.reject(new Error("Decode session 'a' already has a port")))
    await expect(ports.openSession('a', invoke)).rejects.toThrow()
    expect(dropped, "the first session's textures stay").toEqual([])

    consumer.postMessage({ type: 'release', slot: 0, gen: 10 })
    await released
    expect(commands).toEqual([['a', { type: 'release', slot: 0, gen: 10 }]])

    ports.deliver('a', slotMsg(1))
    expect(reads.map(r => r.key), 'its slots are still read').toEqual(['a'])
    reads[0]!.settle()
    await vi.waitFor(() => expect(got).toMatchObject([{ kind: 'slot', slot: 1, gen: 11 }]))

    await ports.close('a')
    expect(closes).toEqual(['a'])
    expect(dropped).toEqual(['a'])
    expect(invoke, 'main is not asked').not.toHaveBeenCalled()
    consumer.close()
  })

  it('a failed open undoes only what it created: a later session under the same id is left alone', async () => {
    const { slots, dropped } = controlledSlots()
    const { ports, handed } = sessionPorts(() => {}, slots)
    let fail!: (error: Error) => void
    const failing = ports.openSession('a', () => new Promise((_resolve, reject) => { fail = reject }))
    // Main ended the refused session's port before its open replied, and the
    // id was opened again in between.
    ports.end('a')
    const reopened = ports.openSession('a', () => Promise.resolve({ width: 2 }))
    fail(new Error('codec failed'))
    await expect(failing).rejects.toThrow('codec failed')
    await reopened
    const consumer = handed.get('a')!
    const got: unknown[] = []
    consumer.onmessage = event => { got.push(event.data) }
    ports.deliver('a', { kind: 'end' })
    await vi.waitFor(() => expect(got).toEqual([{ kind: 'end' }]))
    expect(dropped, 'only the ended session dropped its textures').toEqual(['a'])
    ports.end('a')
    consumer.close()
  })

  it('drops a message for a session that has ended or never opened', async () => {
    const { ports, open } = sessionPorts(vi.fn())
    await open('a')
    ports.end('a')
    expect(() => {
      ports.deliver('a', { kind: 'end' })
      ports.deliver('never', frame(1, new Uint8Array(6)))
      ports.end('never')
    }).not.toThrow()
  })
})
