import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { DecodeMsg, NativeDecode } from '@weftcut/native-decode'
import type { CarrierPort } from './frameCarrier/decodeSessionHost'
const resources = vi.hoisted(() => ({ reserve: vi.fn() }))
vi.mock('./resources', () => ({ reserveDecoderResources: resources.reserve }))
import { openPreviewDecode, type PreviewDecodeRequest } from './previewDecode'

function fakePort() {
  const listeners: { message?: (e: { data: unknown }) => void; close?: () => void } = {}
  const posted: DecodeMsg[] = []
  const state = { closed: false }
  const port: CarrierPort = {
    on: ((event: 'message' | 'close', listener: never) => { listeners[event] = listener }) as CarrierPort['on'],
    postMessage: msg => { posted.push(msg) },
    start: () => {},
    close: () => { state.closed = true },
  }
  return { port, posted, state, send: (data: unknown) => listeners.message!({ data }) }
}

type OnMsg = (err: Error | null, msg: DecodeMsg) => void

function fakeBackend() {
  const callbacks = new Map<string, OnMsg>()
  const backend = {
    previewDecodeOpen: vi.fn((id: string, _path: string, _options: unknown, onMsg: OnMsg) => {
      callbacks.set(id, onMsg)
      return { width: 2, height: 2 }
    }),
    previewDecodeFillFrom: vi.fn(),
    previewDecodeRelease: vi.fn(),
    previewDecodeClose: vi.fn(),
  }
  return { backend, native: backend as unknown as NativeDecode, callbacks }
}

const contents = () => new EventEmitter() as unknown as WebContents
const request = (sessionId: string): PreviewDecodeRequest =>
  ({ sessionId, path: '/home/u/clip.mov', options: { lane: 'vaapi', device: '/dev/dri/renderD128', scaleDiv: 2 } })

beforeEach(() => {
  resources.reserve.mockReset()
  resources.reserve.mockImplementation(() => () => {})
})

describe('openPreviewDecode', () => {
  it('opens the native session with every open option, returns its shipped size, and closes it by its id', () => {
    const { backend, native } = fakeBackend()
    const { port, send } = fakePort()
    const info = openPreviewDecode(native, contents(), port, request('opened'))
    expect(info).toEqual({ width: 2, height: 2 })
    expect(backend.previewDecodeOpen).toHaveBeenCalledWith(
      'opened', '/home/u/clip.mov', { lane: 'vaapi', device: '/dev/dri/renderD128', scaleDiv: 2 }, expect.any(Function))
    expect(resources.reserve).toHaveBeenCalledWith('/home/u/clip.mov')
    send({ type: 'close' })
    expect(backend.previewDecodeClose.mock.calls).toEqual([['opened']])
  })

  it('routes request and release commands to the native session by its id, and nothing else', () => {
    const { backend, native } = fakeBackend()
    const { port, send } = fakePort()
    openPreviewDecode(native, contents(), port, request('routed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    send({ type: 'request', targetUs: 500_000, requestId: 3 })
    send({ type: 'release', lease: 4 })
    send({ type: 'range', aUs: 0, bUs: 1 })
    send({ type: 'request', targetUs: 0 })
    send({ type: 'request', targetUs: 0, requestId: -1 })
    send({ type: 'request', targetUs: Number.NaN, requestId: 1 })
    expect(backend.previewDecodeFillFrom.mock.calls).toEqual([['routed', 500_000, 3]])
    expect(backend.previewDecodeRelease.mock.calls).toEqual([['routed', 4]])
  })

  it('posts what the session delivers in order, and ends the session on a message the addon could not hand over', () => {
    const { native, callbacks } = fakeBackend()
    const { port, posted } = fakePort()
    openPreviewDecode(native, contents(), port, request('posted'))
    const onMsg = callbacks.get('posted')!
    onMsg(null, { kind: 'error', message: 'seek failed', terminal: false })
    onMsg(null, { kind: 'end' })
    onMsg(new Error('convert failed'), { kind: 'end' })
    expect(posted).toEqual([
      { kind: 'error', message: 'seek failed', terminal: false },
      { kind: 'end' },
      { kind: 'error', message: 'convert failed', terminal: true },
    ])
  })
})
