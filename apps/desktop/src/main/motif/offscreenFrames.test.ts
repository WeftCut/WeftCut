import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { FRAME_MARKER_PIXELS, frameMarkerBits } from '../../shared/motifs/frameMarker'
import { OffscreenFrames } from './offscreenFrames'

/// A paint whose marker row carries `id` (null: no marker, as a blank or
/// unrelated surface). The fake handle is the id itself, for the fake reader.
const texture = (id: number | null, w = 128, h = 65) => ({
  release: vi.fn(),
  textureInfo: { codedSize: { width: w, height: h }, handle: { ntHandle: Buffer.from(JSON.stringify(id)) } },
})
const markerRow = (id: number | null) => {
  const rgba = new Uint8Array(FRAME_MARKER_PIXELS * 4)
  if (id !== null) frameMarkerBits(id).forEach((bit, i) => rgba.set(bit ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4))
  return rgba
}
const readMarker = vi.fn(async (handle: Buffer) => markerRow(JSON.parse(handle.toString()) as number | null))
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(timeoutMs = 1000) {
  const events = Object.assign(new EventEmitter(), { stopPainting: vi.fn(), startPainting: vi.fn() })
  const frames = new OffscreenFrames(events as unknown as WebContents, readMarker, timeoutMs)
  return { frames, events, paint: (t: ReturnType<typeof texture>) => events.emit('paint', { texture: t }) }
}

describe('OffscreenFrames', () => {
  it('leases the first paint carrying the expected id and releases every other paint', async () => {
    const { frames, paint } = setup()
    const early = texture(null)
    paint(early) // nobody is waiting
    const lease = frames.expect(128, 64)
    const stale = texture(lease.id + 1000), blank = texture(null), wrongSize = texture(lease.id, 64, 65), noMarkerRows = texture(lease.id, 128, 64)
    for (const t of [stale, blank, wrongSize, noMarkerRows]) paint(t)
    await settled()
    for (const t of [early, stale, blank, wrongSize, noMarkerRows]) expect(t.release).toHaveBeenCalledOnce()
    const right = texture(lease.id), later = texture(lease.id)
    paint(right); paint(later)
    const frame = await lease.frame
    expect(frame).toEqual({ texture: right, width: 128, height: 64 })
    expect(right.release).not.toHaveBeenCalled() // the holder owns it until its copy completes
    await settled()
    expect(later.release).toHaveBeenCalledOnce()
  })

  it('gives each frame a new id, so a repeated picture still needs its own paint', async () => {
    const { frames, paint } = setup()
    const first = frames.expect(128, 64)
    paint(texture(first.id))
    await first.frame
    const second = frames.expect(128, 64)
    expect(second.id).not.toBe(first.id)
    const repeat = texture(first.id)
    paint(repeat)
    await settled()
    expect(repeat.release).toHaveBeenCalledOnce()
    paint(texture(second.id))
    await second.frame
  })

  it('a cancelled lease takes no paint and frees the slot for the next frame', async () => {
    const { frames, paint } = setup()
    const lease = frames.expect(128, 64)
    expect(() => frames.expect(128, 64)).toThrow('Overlapping')
    lease.cancel()
    const t = texture(lease.id)
    paint(t)
    await settled()
    expect(t.release).toHaveBeenCalledOnce()
    const next = frames.expect(128, 64)
    paint(texture(next.id))
    await next.frame
  })

  it('times out, and a failed marker read fails the frame', async () => {
    const slow = setup(5)
    await expect(slow.frames.expect(128, 64).frame).rejects.toThrow('timed out')
    readMarker.mockRejectedValueOnce(new Error('device lost'))
    const { frames, paint } = setup()
    const lease = frames.expect(128, 64)
    const t = texture(lease.id)
    paint(t)
    await expect(lease.frame).rejects.toThrow('device lost')
    expect(t.release).toHaveBeenCalledOnce()
  })

  it('restarts the capturer while a frame goes without its paint, and stops once it arrives', async () => {
    vi.useFakeTimers()
    try {
      const { frames, events, paint } = setup(5000)
      const lease = frames.expect(128, 64)
      await vi.advanceTimersByTimeAsync(150)
      expect(events.startPainting).not.toHaveBeenCalled() // a prompt paint needs no restart
      await vi.advanceTimersByTimeAsync(300)
      expect(events.stopPainting).toHaveBeenCalledTimes(2)
      expect(events.startPainting).toHaveBeenCalledTimes(2)
      paint(texture(lease.id))
      await vi.advanceTimersByTimeAsync(0)
      await lease.frame
      await vi.advanceTimersByTimeAsync(1000)
      expect(events.startPainting).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('rejects a pending frame on host teardown', async () => {
    const { frames } = setup()
    const lease = frames.expect(128, 64)
    frames.dispose()
    await expect(lease.frame).rejects.toThrow('closed')
  })
})
