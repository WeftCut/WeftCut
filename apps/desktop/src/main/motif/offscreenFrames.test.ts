import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { OffscreenFrames } from './offscreenFrames'

describe('OffscreenFrames', () => {
  it('releases unrequested and wrong-size paints and leases only the requested surface', async () => {
    const events = Object.assign(new EventEmitter(), { stopPainting: vi.fn(), startPainting: vi.fn(), invalidate: vi.fn() })
    const frames = new OffscreenFrames(events as unknown as WebContents)
    const texture = (w: number) => ({ release: vi.fn(), textureInfo: { codedSize: { width: w, height: 64 } } })
    const old = texture(128)
    events.emit('paint', { texture: old })
    expect(old.release).toHaveBeenCalledOnce()
    const wanted = frames.capture(128, 64)
    const wrong = texture(64)
    events.emit('paint', { texture: wrong })
    events.emit('paint', {}) // invalidate may return a NativeImage without a texture
    expect(wrong.release).toHaveBeenCalledOnce()
    const right = texture(128)
    events.emit('paint', { texture: right })
    expect(await wanted).toBe(right)
    expect(right.release).not.toHaveBeenCalled() // caller owns it until the GPU copy completes
    expect(events.stopPainting).toHaveBeenCalledOnce()
    expect(events.startPainting).toHaveBeenCalledOnce()
    right.release()
    frames.dispose()
  })
  it('rejects a pending capture on host teardown', async () => {
    const events = Object.assign(new EventEmitter(), { stopPainting() {}, startPainting() {}, invalidate() {} })
    const frames = new OffscreenFrames(events as unknown as WebContents)
    const wanted = frames.capture(128, 64)
    frames.dispose()
    await expect(wanted).rejects.toThrow('closed')
  })
})
