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
  return { port, posted, send: (data: unknown) => listeners.message!({ data }) }
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

beforeEach(() => {
  resources.reserve.mockReset()
  resources.reserve.mockImplementation(() => () => {})
})

describe('openExportDecode', () => {
  it('reserves the decoder memory against the export it belongs to, and closes the native session by its id', () => {
    const { backend, native } = fakeBackend()
    const { port, send } = fakePort()
    const info = openExportDecode(native, contents(), port, { ...request('reserved'), finalizationId: 7 })
    expect(info).toEqual({ width: 2, height: 2, startPtsUs: 0 })
    expect(resources.reserve).toHaveBeenCalledWith('/home/u/clip.mov', 7)
    send({ type: 'close' })
    expect(backend.exportDecodeClose.mock.calls).toEqual([['reserved']])
  })

  it('drives the native session by its id from the port, and posts what it delivers', () => {
    const { backend, native, callbacks } = fakeBackend()
    const { port, posted, send } = fakePort()
    openExportDecode(native, contents(), port, request('s'))
    expect(backend.exportDecodeOpen).toHaveBeenCalledWith('s', '/home/u/clip.mov', 'NV12', 6, expect.any(Function))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    send({ type: 'range', aUs: 0, bUs: 500 })
    send({ type: 'release', lease: 4 })
    // A preview command is not an export one.
    send({ type: 'request', targetUs: 0, requestId: 1 })
    send({ type: 'range', aUs: 'x', bUs: 1 })
    expect(backend.exportDecodeRange.mock.calls).toEqual([['s', 0, 500]])
    expect(backend.exportDecodeRelease.mock.calls).toEqual([['s', 4]])
    const onMsg = callbacks.get('s')!
    onMsg(null, { kind: 'end' })
    // A message the addon failed to hand over still fails the range loudly.
    onMsg(new Error('convert failed'), { kind: 'end' })
    expect(posted).toEqual([{ kind: 'end' }, { kind: 'error', message: 'convert failed', terminal: false }])
  })
})
