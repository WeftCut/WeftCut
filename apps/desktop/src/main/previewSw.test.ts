import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import { openPreviewSw, consumePreviewSw, closePreviewSw } from './previewSw'

it('enables native credit before requests, accepts only owner receipts and closes on renderer loss', () => {
  const contents = Object.assign(new EventEmitter(), { id: 17, send: vi.fn(), isDestroyed: () => false })
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const backend = { previewSwOpen: vi.fn(() => ({ width: 2, height: 2 })),
    previewSwEnableFlow: vi.fn(), previewSwConsume: vi.fn(), previewSwClose: vi.fn() }
  const native = backend as unknown as NativeDecode
  openPreviewSw(native, win, 'credits', 'fixture', null, null, null, null, null)
  expect(backend.previewSwEnableFlow).toHaveBeenCalledWith('credits')
  consumePreviewSw(native, 99, 'credits', 1)
  expect(backend.previewSwConsume).not.toHaveBeenCalled()
  consumePreviewSw(native, 17, 'credits', 1)
  expect(backend.previewSwConsume).toHaveBeenCalledWith('credits', 1)
  contents.emit('render-process-gone')
  expect(backend.previewSwClose).toHaveBeenCalledOnce()
  openPreviewSw(native, win, 'reload', 'fixture', null, null, null, null, null)
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  expect(backend.previewSwClose).toHaveBeenCalledTimes(1)
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(backend.previewSwClose).toHaveBeenCalledTimes(2)
  expect(contents.listenerCount('destroyed')).toBe(0)
  expect(contents.listenerCount('did-start-navigation')).toBe(0)
  closePreviewSw(native, 'credits')
  expect(backend.previewSwClose).toHaveBeenCalledTimes(2)
})
