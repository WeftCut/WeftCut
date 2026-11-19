import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedTexture, type WebContents } from 'electron'
import type { DecodeMsg, NativeDecode } from '@weftcut/native-decode'
import { MIB, hydratePerformanceSettings } from '../shared/performance-settings'
import { HW_BUDGET_EXCEEDED, HW_BUDGET_RESERVATION_MISMATCH, type PreviewGpuColorSpace } from '../shared/ipc'
import type { CarrierPort } from './frameCarrier/decodeSessionHost'
import { gpuBufferBudget } from './gpuBufferBudget'
import { hwBudget, hwSessionCount, openPreviewGpu, type PreviewGpuRequest } from './previewGpu'

vi.mock('electron', () => ({ sharedTexture: { importSharedTexture: vi.fn(), sendSharedTexture: vi.fn() } }))
// The shared buffer budget reserves through the same call; the decoder's
// reservation is the one sized by the decoder formula.
const decoder = vi.hoisted(() => ({ released: [] as number[] }))
vi.mock('./resources', () => ({ reserveResources: vi.fn((_threads: number, mib: number) => () => { decoder.released.push(mib) }) }))
const decoderMiB = (width: number, height: number) => 64 + width * height * 24 / 1048576
const decoderReleases = (width = 3840, height = 2160) => decoder.released.filter(mib => mib === decoderMiB(width, height)).length

/** Every import Electron made, with the release callback it was given. */
const imports: { release: ReturnType<typeof vi.fn>; allReleased: () => void }[] = []

function fakeBackend(width = 3840, height = 2160) {
  const sinks = new Map<string, (err: Error | null, msg: DecodeMsg) => void>()
  const backend = {
    previewGpuOpen: vi.fn((id: string, _path: string, size: number, _matrix: string, _full: boolean, onMsg: (err: Error | null, msg: DecodeMsg) => void) => {
      sinks.set(id, onMsg)
      return { width, height, slots: Array.from({ length: size }, () => ({ handle: Buffer.alloc(8) })) }
    }),
    previewGpuClose: vi.fn(),
    previewGpuRequestFrameAt: vi.fn(),
    previewGpuRelease: vi.fn(),
  }
  return { backend, native: backend as unknown as NativeDecode, emit: (id: string, msg: DecodeMsg) => sinks.get(id)!(null, msg) }
}

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
  return { port, posted, state, send: (data: unknown) => listeners.message!({ data }), consumerCloses: () => listeners.close!() }
}

/** The document that opens sessions: navigating it away ends them. */
function fakeOwner() {
  const owner = Object.assign(new EventEmitter(), { mainFrame: { frame: 'main' } })
  return { owner, contents: owner as unknown as WebContents, reloads: () => owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }) }
}

const color: PreviewGpuColorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' }
const request = (sessionId: string, over: Partial<PreviewGpuRequest> = {}): PreviewGpuRequest =>
  ({ sessionId, path: 'C:/u/clip.mp4', poolSize: 3, colorSpace: color, codedWidth: 3840, codedHeight: 2160, ...over })
const POOL_BYTES = 3840 * 2160 * 4 * 3

beforeEach(() => {
  hydratePerformanceSettings({ gpu_buffer_mib: 128 })
  vi.clearAllMocks()
  imports.length = 0
  decoder.released.length = 0
  vi.mocked(sharedTexture.importSharedTexture).mockImplementation(({ allReferencesReleased }) => {
    const entry = { release: vi.fn(), allReleased: allReferencesReleased! }
    imports.push(entry)
    return { release: entry.release } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>
  })
  vi.mocked(sharedTexture.sendSharedTexture).mockResolvedValue()
})
afterEach(() => {
  // Electron's last references go, so the next test starts with an empty budget.
  for (const entry of imports) entry.allReleased()
  hydratePerformanceSettings(undefined)
})

/** Lets the import release callbacks a close queued run. */
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

describe('GPU preview sessions', () => {
  it("sends each slot's texture tagged with its own session and slot, imported as sRGB-passthrough RGBA", async () => {
    const { native } = fakeBackend()
    const { owner, contents } = fakeOwner()
    const port = fakePort()
    await openPreviewGpu(native, contents, () => port.port, request('tagged'))
    const sends = vi.mocked(sharedTexture.sendSharedTexture).mock.calls
    expect(sends.map(([options, tag]) => [options.frame, tag])).toEqual([0, 1, 2].map(slot => [owner.mainFrame, { key: 'tagged', slot }]))
    for (const [{ textureInfo }] of vi.mocked(sharedTexture.importSharedTexture).mock.calls) {
      expect(textureInfo.pixelFormat).toBe('rgba')
      expect(textureInfo.colorSpace).toEqual({ primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' })
    }
    port.consumerCloses()
  })

  it("resolves its open only once every texture has reached the document", async () => {
    const { native } = fakeBackend()
    let deliver!: () => void
    vi.mocked(sharedTexture.sendSharedTexture).mockReturnValueOnce(new Promise(resolve => { deliver = resolve }))
    const port = fakePort()
    let opened = false
    const opening = openPreviewGpu(native, fakeOwner().contents, () => port.port, request('arriving')).then(() => { opened = true })
    await settled()
    expect(opened).toBe(false)
    deliver()
    await opening
    port.consumerCloses()
  })

  it('carries slot, end and error messages on its port, and release and request commands to native', async () => {
    const { backend, native, emit } = fakeBackend()
    const port = fakePort()
    await openPreviewGpu(native, fakeOwner().contents, () => port.port, request('wire'))
    const msgs: DecodeMsg[] = [
      { kind: 'slot', slot: 1, gen: 4, ptsUs: 0, durUs: 33_333 },
      { kind: 'error', message: 'seek failed', terminal: false },
      { kind: 'end' },
    ]
    for (const msg of msgs) emit('wire', msg)
    expect(port.posted).toEqual(msgs)
    port.send({ type: 'request', targetUs: 5_000 })
    port.send({ type: 'release', slot: 1, gen: 4 })
    port.send({ type: 'release', slot: -1, gen: 4 })
    port.send({ type: 'release', lease: 1 })
    expect(backend.previewGpuRequestFrameAt.mock.calls).toEqual([['wire', 5_000]])
    expect(backend.previewGpuRelease.mock.calls).toEqual([['wire', 1, 4]])
    port.consumerCloses()
  })

  it('refuses a pool over the shared buffer budget before native allocates, holding nothing', async () => {
    const { backend, native } = fakeBackend()
    const connect = vi.fn(() => fakePort().port)
    await expect(openPreviewGpu(native, fakeOwner().contents, connect, request('oversized', { poolSize: 16 }))).rejects.toThrow(HW_BUDGET_EXCEEDED)
    expect(backend.previewGpuOpen).not.toHaveBeenCalled()
    expect(gpuBufferBudget.snapshot().used_bytes).toBe(0)
    expect(hwSessionCount()).toBe(0)
    expect(connect, 'a refused session gets no port').not.toHaveBeenCalled()
  })

  it('charges a closed session until all imported slot references are gone', async () => {
    const { backend, native } = fakeBackend()
    const port = fakePort()
    await openPreviewGpu(native, fakeOwner().contents, () => port.port, request('charged'))
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(POOL_BYTES)
    expect(hwBudget().slotVram.usedBytes).toBe(POOL_BYTES)
    port.consumerCloses()
    await settled()
    expect(backend.previewGpuClose).toHaveBeenCalledOnce()
    expect(imports.every(entry => entry.release.mock.calls.length === 1), "main's imports go with the session").toBe(true)
    expect(hwSessionCount()).toBe(0)
    expect(hwBudget().slotVram.usedBytes).toBe(0)
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(POOL_BYTES)
    expect(gpuBufferBudget.reserve('motif', 40 * MIB)).toBeNull()
    imports[0]!.allReleased(); imports[1]!.allReleased()
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(POOL_BYTES)
    imports[2]!.allReleased()
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(0)
  })

  it('a failed import rolls back: native closed, the imports so far released, the reservation released once', async () => {
    const { backend, native } = fakeBackend()
    const real = vi.mocked(sharedTexture.importSharedTexture).getMockImplementation()!
    vi.mocked(sharedTexture.importSharedTexture)
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => { throw new Error('import failed') })
    const port = fakePort()
    await expect(openPreviewGpu(native, fakeOwner().contents, () => port.port, request('import-fails'))).rejects.toThrow('import failed')
    await settled()
    expect(backend.previewGpuClose).toHaveBeenCalledOnce()
    expect(imports.map(entry => entry.release.mock.calls.length)).toEqual([1, 1])
    expect(hwSessionCount()).toBe(0)
    expect(decoderReleases()).toBe(1)
    expect(port.state.closed).toBe(true)
    port.consumerCloses()
    expect(decoderReleases(), 'released once, whatever closes it after').toBe(1)
    for (const entry of imports) entry.allReleased()
    expect(gpuBufferBudget.snapshot().used_bytes).toBe(0)
  })

  it('a failed send rolls back the same way, and its own import is released once', async () => {
    const { backend, native } = fakeBackend()
    vi.mocked(sharedTexture.sendSharedTexture)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('send timed out'))
    const port = fakePort()
    await expect(openPreviewGpu(native, fakeOwner().contents, () => port.port, request('send-fails'))).rejects.toThrow('send timed out')
    await settled()
    expect(backend.previewGpuClose).toHaveBeenCalledOnce()
    expect(imports.map(entry => entry.release.mock.calls.length)).toEqual([1, 1, 1])
    expect(hwSessionCount()).toBe(0)
    expect(decoderReleases()).toBe(1)
  })

  it('a reservation mismatch closes native and releases the reservation', async () => {
    const { backend, native } = fakeBackend(1920, 1080)
    const port = fakePort()
    await expect(openPreviewGpu(native, fakeOwner().contents, () => port.port, request('mismatch'))).rejects.toThrow(HW_BUDGET_RESERVATION_MISMATCH)
    expect(backend.previewGpuClose).toHaveBeenCalledOnce()
    expect(sharedTexture.importSharedTexture).not.toHaveBeenCalled()
    expect(hwSessionCount()).toBe(0)
    expect(decoderReleases()).toBe(1)
  })

  it("a reload closes the document's GPU sessions and releases what they held", async () => {
    const { backend, native } = fakeBackend(1920, 1080)
    const page = fakeOwner()
    const other = fakeOwner()
    const small = { codedWidth: 1920, codedHeight: 1080 }
    await openPreviewGpu(native, page.contents, () => fakePort().port, request('page-a', small))
    await openPreviewGpu(native, page.contents, () => fakePort().port, request('page-b', small))
    const kept = fakePort()
    await openPreviewGpu(native, other.contents, () => kept.port, request('other', small))
    expect(hwSessionCount()).toBe(3)
    page.reloads()
    expect(backend.previewGpuClose.mock.calls.map(([id]) => id).sort()).toEqual(['page-a', 'page-b'])
    expect(hwSessionCount()).toBe(1)
    expect(decoderReleases(1920, 1080)).toBe(2)
    kept.consumerCloses()
  })
})
