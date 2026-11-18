import { describe, expect, it, vi } from 'vitest'
import type { DecodeMsg } from '@weftcut/native-decode'
import { hostDecodeSession, parseRelease, type CarrierPort } from './decodeSessionHost'
import type { DocumentOwner } from './documentOwner'

function fakePort() {
  const listeners: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  const posted: DecodeMsg[] = []
  const state = { closed: false, started: false }
  const port: CarrierPort = {
    on: ((event: 'message' | 'close', listener: never) => { listeners[event] = listener }) as CarrierPort['on'],
    postMessage: msg => { posted.push(msg) },
    start: () => { state.started = true },
    close: () => { state.closed = true },
  }
  return {
    port, posted, state, listeners,
    send: (data: unknown) => listeners.message!({ data }),
    // The far end went away: its consumer closed the session, or the Worker
    // holding it was terminated, or its process is gone.
    farEndCloses: () => listeners.close!(),
  }
}

function fakeOwner() {
  const subscribers = new Set<() => void>()
  const owner: DocumentOwner = {
    onGone: gone => { subscribers.add(gone); return () => { subscribers.delete(gone) } },
  }
  return { owner, subscribers, goes: () => { for (const gone of [...subscribers]) gone() } }
}

const frame = (lease: number, ptsUs: number): DecodeMsg =>
  ({ kind: 'bytes', lease, ptsUs, durUs: 1, width: 2, height: 2, format: 'NV12', data: Buffer.alloc(6) })

/** A pipeline's own command, which the host routes without knowing it. */
type Go = { type: 'go'; n: number }
const parseGo = (data: Record<string, unknown>): Go | null =>
  data.type === 'go' && typeof data.n === 'number' ? { type: 'go', n: data.n } : null

/** Opens a hosted session whose native side records what it is asked. */
function hosted() {
  const port = fakePort()
  const owner = fakeOwner()
  const commands: Go[] = []
  const close = vi.fn()
  let deliver!: (msg: DecodeMsg) => void
  const session = hostDecodeSession({
    port: port.port,
    owner: owner.owner,
    open: onMsg => { deliver = onMsg; return { width: 2 } },
    parse: parseGo,
    command: cmd => { commands.push(cmd) },
    close,
  })
  return { session, port, owner, commands, close, deliver: (msg: DecodeMsg) => deliver(msg) }
}

describe('hostDecodeSession', () => {
  it('returns the open info and starts serving its port', () => {
    const { session, port } = hosted()
    expect(session.info).toEqual({ width: 2 })
    expect(port.state.started).toBe(true)
  })

  it('posts frames and control on the one port in the order the session delivered them', () => {
    const { port, deliver } = hosted()
    const delivered: DecodeMsg[] = [
      frame(0, 0),
      { kind: 'mark', aUs: 0, bUs: 10 },
      frame(1, 20),
      frame(2, 30),
      { kind: 'end' },
      { kind: 'mark', aUs: 20, bUs: 99 },
      { kind: 'error', message: 'seek failed', terminal: false },
    ]
    for (const msg of delivered) deliver(msg)
    expect(port.posted).toEqual(delivered)
  })

  it('routes the commands its pipeline parses from the port to the session, and nothing else', () => {
    const { port, commands } = hosted()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    port.send({ type: 'go', n: 1 })
    port.send({ type: 'pause' })
    port.send({ type: 'go', n: 'x' })
    port.send(null)
    port.send('close')
    port.send({ type: 'close' })
    port.send({ type: 'go', n: 2 })
    expect(commands).toEqual([{ type: 'go', n: 1 }, { type: 'go', n: 2 }])
  })

  it('parses a release by its lease, never a negative or fractional one', () => {
    expect(parseRelease({ type: 'release', lease: 3 })).toEqual({ type: 'release', lease: 3 })
    expect(parseRelease({ type: 'release', lease: -1 })).toBeNull()
    expect(parseRelease({ type: 'release', lease: 1.5 })).toBeNull()
    expect(parseRelease({ type: 'release' })).toBeNull()
    expect(parseRelease({ type: 'range', lease: 3 })).toBeNull()
  })

  it('a command the session refuses does not throw out of the port', () => {
    const port = fakePort()
    hostDecodeSession({
      port: port.port, owner: fakeOwner().owner, open: () => null, close: () => {}, parse: parseGo,
      command: () => { throw new Error('no export_decode session') },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => port.send({ type: 'go', n: 0 })).not.toThrow()
  })

  it('closes the session and its port once when the far end closes it', () => {
    // The preload closing the session by id, or a `MessagePortMain`'s far end
    // going away.
    const { port, owner, close, commands } = hosted()
    port.farEndCloses()
    port.farEndCloses()
    port.send({ type: 'go', n: 0 })
    owner.goes()
    expect(close).toHaveBeenCalledOnce()
    expect(port.state.closed).toBe(true)
    expect(commands).toEqual([])
    expect(owner.subscribers.size, 'the owner no longer holds the closed session').toBe(0)
  })

  it('closes the session and its port once when main closes it', () => {
    const { session, port, owner, close } = hosted()
    session.close()
    session.close()
    expect(close).toHaveBeenCalledOnce()
    expect(port.state.closed).toBe(true)
    port.farEndCloses()
    expect(close).toHaveBeenCalledOnce()
    expect(owner.subscribers.size, 'the owner no longer holds the closed session').toBe(0)
  })

  it('closes the session and its port once when the owner document goes', () => {
    const { port, owner, close } = hosted()
    owner.goes()
    expect(close).toHaveBeenCalledOnce()
    expect(port.state.closed).toBe(true)
    port.farEndCloses()
    expect(close).toHaveBeenCalledOnce()
  })

  it('drops what the session delivers after it closed, and routes no command', () => {
    const { port, commands, deliver } = hosted()
    deliver(frame(0, 0))
    port.farEndCloses()
    deliver(frame(1, 10))
    deliver({ kind: 'end' })
    port.send({ type: 'go', n: 0 })
    expect(port.posted).toEqual([frame(0, 0)])
    expect(commands).toEqual([])
  })

  it('a failed open registers nothing and closes the port', () => {
    const port = fakePort()
    const owner = fakeOwner()
    const close = vi.fn()
    expect(() => hostDecodeSession({
      port: port.port, owner: owner.owner, parse: parseGo, command: () => {}, close,
      open: () => { throw new Error('codec failed') },
    })).toThrow('codec failed')
    expect(owner.subscribers.size).toBe(0)
    expect(port.listeners).toEqual({})
    expect(port.state.closed).toBe(true)
    expect(close, 'a session that never opened is never closed').not.toHaveBeenCalled()
  })
})
