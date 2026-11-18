import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { DecodeMsg, NativeDecode } from '@weftcut/native-decode'
import type { CarrierPort } from './frameCarrier/decodeSessionHost'
const resources = vi.hoisted(() => ({ reserve: vi.fn() }))
vi.mock('./resources', () => ({ reserveDecoderResources: resources.reserve }))
import { openExportDecode, type ExportDecodeRequest } from './exportDecode'

function fakePort() {
  const listeners: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  const posted: DecodeMsg[] = []
  const port: CarrierPort = {
    on: ((event: 'message' | 'close', listener: never) => { listeners[event] = listener }) as CarrierPort['on'],
    postMessage: msg => { posted.push(msg) },
    start: () => {},
    close: () => {},
  }
  return { port, posted, send: (data: unknown) => listeners.message!({ data }), farEndCloses: () => listeners.close!() }
}

type OnMsg = (err: Error | null, msg: DecodeMsg) => void

function fakeBackend() {
  const callbacks = new Map<string, OnMsg>()
  const backend = {
    exportDecodeOpen: vi.fn((id: string, _path: string, _format: string, _window: number, onMsg: OnMsg) => {
      callbacks.set(id, onMsg)
      return { width: 2, height: 2, startPtsUs: 0 }
    }),
    exportDecodeRange: vi.fn(),
    exportDecodeRelease: vi.fn(),
    exportDecodeClose: vi.fn(),
  }
  return { backend, native: backend as unknown as NativeDecode, callbacks }
}

const contents = () => new EventEmitter() as unknown as WebContents
const request = (sessionId: string): ExportDecodeRequest => ({ sessionId, path: '/home/u/clip.mov', outFormat: 'NV12', window: 6 })

let releases: ReturnType<typeof vi.fn>[]
beforeEach(() => {
  releases = []
  resources.reserve.mockReset()
  resources.reserve.mockImplementation(() => { const release = vi.fn(); releases.push(release); return release })
})

describe('openExportDecode', () => {
  it('refuses an id that is already open, before reserving anything', () => {
    const { native } = fakeBackend()
    const first = fakePort()
    openExportDecode(native, contents(), first.port, request('dup'))
    expect(() => openExportDecode(native, contents(), fakePort().port, request('dup'))).toThrow('already exists')
    expect(resources.reserve).toHaveBeenCalledOnce()
    // Once the first session closes, its id is free again.
    first.farEndCloses()
    expect(() => openExportDecode(native, contents(), fakePort().port, request('dup'))).not.toThrow()
  })

  it('releases its reservation once, when the session closes', () => {
    const { backend, native } = fakeBackend()
    const { port, farEndCloses } = fakePort()
    openExportDecode(native, contents(), port, { ...request('s'), finalizationId: 7 })
    expect(resources.reserve).toHaveBeenCalledWith('/home/u/clip.mov', 7)
    expect(releases[0]).not.toHaveBeenCalled()
    farEndCloses()
    farEndCloses()
    expect(backend.exportDecodeClose.mock.calls).toEqual([['s']])
    expect(releases[0]).toHaveBeenCalledOnce()
  })

  it('releases its reservation when the native open fails, leaving the id free and the owner untracked', () => {
    const { backend, native } = fakeBackend()
    backend.exportDecodeOpen.mockImplementationOnce(() => { throw new Error('codec failed') })
    const owner = new EventEmitter()
    expect(() => openExportDecode(native, owner as unknown as WebContents, fakePort().port, request('bad'))).toThrow('codec failed')
    expect(releases[0]).toHaveBeenCalledOnce()
    expect(owner.eventNames()).toEqual([])
    expect(backend.exportDecodeClose).not.toHaveBeenCalled()
    expect(() => openExportDecode(native, contents(), fakePort().port, request('bad'))).not.toThrow()
  })

  it('drives the native session by its id from the port, and posts what it delivers', () => {
    const { backend, native, callbacks } = fakeBackend()
    const { port, posted, send } = fakePort()
    openExportDecode(native, contents(), port, request('s'))
    expect(backend.exportDecodeOpen).toHaveBeenCalledWith('s', '/home/u/clip.mov', 'NV12', 6, expect.any(Function))
    send({ type: 'range', aUs: 0, bUs: 500 })
    send({ type: 'release', lease: 4 })
    expect(backend.exportDecodeRange).toHaveBeenCalledWith('s', 0, 500)
    expect(backend.exportDecodeRelease).toHaveBeenCalledWith('s', 4)
    const onMsg = callbacks.get('s')!
    onMsg(null, { kind: 'end' })
    // A message the addon failed to hand over still fails the range loudly.
    onMsg(new Error('convert failed'), { kind: 'end' })
    expect(posted).toEqual([{ kind: 'end' }, { kind: 'error', message: 'convert failed', terminal: false }])
  })

  it('closes only the sessions of the document that went away', () => {
    const { backend, native } = fakeBackend()
    const a = new EventEmitter(), b = new EventEmitter()
    openExportDecode(native, a as unknown as WebContents, fakePort().port, request('a1'))
    openExportDecode(native, a as unknown as WebContents, fakePort().port, request('a2'))
    openExportDecode(native, b as unknown as WebContents, fakePort().port, request('b'))
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(backend.exportDecodeClose.mock.calls).toEqual([['a1'], ['a2']])
    expect(releases.map(release => release.mock.calls.length)).toEqual([1, 1, 0])
  })
})
