import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
const resources = vi.hoisted(() => ({ reserve: vi.fn() }))
vi.mock('./resources', () => ({ reserveDecoderResources: resources.reserve }))
import { openExportSw, closeAllExportSw } from './exportSw'

it('reclaims native export sessions and memory on owner loss without affecting another window', () => {
  const releases: ReturnType<typeof vi.fn>[] = []
  resources.reserve.mockImplementation(() => { const release = vi.fn(); releases.push(release); return release })
  const a = Object.assign(new EventEmitter(), { id: 1, send: vi.fn(), isDestroyed: () => false })
  const b = Object.assign(new EventEmitter(), { id: 2, send: vi.fn(), isDestroyed: () => false })
  const win = (webContents: typeof a) => ({ webContents, isDestroyed: () => false }) as unknown as BrowserWindow
  const backend = { exportSwOpen: vi.fn(() => ({ width: 2, height: 2 })), exportSwClose: vi.fn() }
  const native = backend as unknown as NativeDecode
  openExportSw(native, win(a), 'a1', 'fixture', 'NV12', 6)
  openExportSw(native, win(a), 'a2', 'fixture', 'NV12', 6)
  openExportSw(native, win(b), 'b', 'fixture', 'NV12', 6)
  expect(a.listenerCount('destroyed')).toBe(1)
  a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  expect(backend.exportSwClose).not.toHaveBeenCalled()
  a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(backend.exportSwClose.mock.calls).toEqual([['a1'], ['a2']])
  expect(releases[0]).toHaveBeenCalledOnce(); expect(releases[1]).toHaveBeenCalledOnce()
  expect(releases[2]).not.toHaveBeenCalled()
  closeAllExportSw(native, a.id)
  expect(releases[2]).not.toHaveBeenCalled()
  expect(a.listenerCount('destroyed')).toBe(0)
  b.emit('render-process-gone'); b.emit('destroyed')
  expect(releases[2]).toHaveBeenCalledOnce()
  expect(b.listenerCount('did-start-navigation')).toBe(0)
  closeAllExportSw(native)
  expect(backend.exportSwClose).toHaveBeenCalledTimes(3)
})

it('rolls back a failed native open before publishing an owner', () => {
  const release = vi.fn(); resources.reserve.mockReturnValue(release)
  const contents = Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false })
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const native = { exportSwOpen: () => { throw new Error('codec failed') } } as unknown as NativeDecode
  expect(() => openExportSw(native, win, 'bad', 'fixture', 'NV12', 6)).toThrow('codec failed')
  expect(release).toHaveBeenCalledOnce()
  expect(contents.listenerCount('destroyed')).toBe(0)
})
