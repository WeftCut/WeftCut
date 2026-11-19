import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { CarrierPort } from './decodeSessionHost'
import { admitDecodeSession } from './decodeSessionAdmission'

function fakePort() {
  const listeners: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  const state = { closes: 0 }
  const port: CarrierPort = {
    on: ((event: 'message' | 'close', listener: never) => { listeners[event] = listener }) as CarrierPort['on'],
    postMessage: () => {},
    start: () => {},
    close: () => { state.closes += 1 },
  }
  // The consumer closed the session (the preload's `decodeSession:close`).
  return { port, state, consumerCloses: () => listeners.close!() }
}

const contents = () => new EventEmitter()

/** Asks for a session whose pipeline records what admission does with it. */
function ask(sessionId: string, owner: EventEmitter = contents()) {
  const port = fakePort()
  const release = vi.fn()
  const reserve = vi.fn(() => release)
  const open = vi.fn(() => ({ width: 2 }))
  const close = vi.fn()
  const admit = () => admitDecodeSession({
    sessionId, port: port.port, owner: owner as unknown as WebContents, reserve, open, parse: () => null, command: () => {}, close,
  })
  return { admit, port, owner, reserve, release, open, close }
}

describe('admitDecodeSession', () => {
  it('returns what the session opened with', () => {
    expect(ask('opened').admit().info).toEqual({ width: 2 })
  })

  it('refuses an id that is already open before reserving anything, and frees the id when the session closes', () => {
    const live = ask('held')
    live.admit()
    const duplicate = ask('held')
    expect(duplicate.admit).toThrow('already open')
    expect(duplicate.reserve).not.toHaveBeenCalled()
    expect(duplicate.open).not.toHaveBeenCalled()
    // The refusal did not take the live session's id or reservation with it.
    expect(live.release).not.toHaveBeenCalled()
    expect(ask('held').admit).toThrow('already open')
    live.port.consumerCloses()
    expect(ask('held').admit).not.toThrow()
  })

  it('releases the reservation once, when the session closes', () => {
    const session = ask('released')
    session.admit()
    expect(session.release).not.toHaveBeenCalled()
    session.port.consumerCloses()
    session.port.consumerCloses()
    expect(session.close).toHaveBeenCalledOnce()
    expect(session.release).toHaveBeenCalledOnce()
  })

  it('releases the reservation once when main closes the session, whoever closes it after', () => {
    const session = ask('main-closed')
    const admitted = session.admit()
    admitted.close()
    session.port.consumerCloses()
    admitted.close()
    expect(session.close).toHaveBeenCalledOnce()
    expect(session.release).toHaveBeenCalledOnce()
    expect(ask('main-closed').admit).not.toThrow()
  })

  it('releases the reservation when the pipeline close throws', () => {
    const session = ask('close-throws')
    session.close.mockImplementation(() => { throw new Error('already gone natively') })
    session.admit()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    session.port.consumerCloses()
    expect(session.release).toHaveBeenCalledOnce()
    expect(ask('close-throws').admit).not.toThrow()
  })

  it('leaves nothing behind when the open fails: reservation released, id free, owner untracked, port closed', () => {
    const session = ask('bad')
    session.open.mockImplementation(() => { throw new Error('codec failed') })
    expect(session.admit).toThrow('codec failed')
    expect(session.release).toHaveBeenCalledOnce()
    expect(session.owner.eventNames()).toEqual([])
    expect(session.port.state.closes).toBeGreaterThan(0)
    expect(session.close).not.toHaveBeenCalled()
    expect(ask('bad').admit).not.toThrow()
  })

  it('closes the port of a session it refuses, and leaves the open one alone', () => {
    const live = ask('kept')
    live.admit()
    const duplicate = ask('kept')
    expect(duplicate.admit).toThrow('already open')
    const unadmitted = ask('full')
    unadmitted.reserve.mockImplementation(() => { throw new Error('capacity exceeded') })
    expect(unadmitted.admit).toThrow('capacity exceeded')
    expect([duplicate.port.state.closes, unadmitted.port.state.closes, live.port.state.closes]).toEqual([1, 1, 0])
    expect(unadmitted.open).not.toHaveBeenCalled()
    expect(ask('full').admit).not.toThrow()
  })

  it('closes only the sessions of the document that went away', () => {
    const a = contents(), b = contents()
    const a1 = ask('a1', a), a2 = ask('a2', a), other = ask('b1', b)
    a1.admit(); a2.admit(); other.admit()
    // A same-document navigation keeps the document, and its sessions.
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(a1.close).not.toHaveBeenCalled()
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect([a1, a2, other].map(session => session.close.mock.calls.length)).toEqual([1, 1, 0])
    expect([a1, a2, other].map(session => session.release.mock.calls.length)).toEqual([1, 1, 0])
    expect(a.listenerCount('did-start-navigation'), 'no listener outlives the sessions').toBe(0)
  })
})
