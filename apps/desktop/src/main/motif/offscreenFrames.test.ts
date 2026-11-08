import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { FRAME_MARKER_PIXELS, frameMarkerBits } from '../../shared/motifs/frameMarker'
import { MotifFrameSkippedError, OffscreenFrames } from './offscreenFrames'

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
/// A bitmap host's paint: its last row carries `id`.
const bitmap = (id: number | null, w = 128, h = 65) => ({
  isEmpty: () => false,
  getSize: () => ({ width: w, height: h }),
  crop: (rect: { y: number }) => ({ toBitmap: () => Buffer.from(rect.y === h - 1 ? markerRow(id) : new Uint8Array(FRAME_MARKER_PIXELS * 4)) }),
})
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(timeoutMs = 1000, reader: typeof readMarker | null = readMarker) {
  const events = Object.assign(new EventEmitter(), { stopPainting: vi.fn(), startPainting: vi.fn() })
  const frames = new OffscreenFrames(events as unknown as WebContents, reader, timeoutMs, 200)
  return {
    frames, events,
    paint: (t: ReturnType<typeof texture>) => events.emit('paint', { texture: t }, {}, null),
    paintBitmap: (image: ReturnType<typeof bitmap>) => events.emit('paint', {}, {}, image),
  }
}

describe('OffscreenFrames', () => {
  it('leases the first paint carrying the expected id and releases every other paint', async () => {
    const { frames, paint } = setup()
    const early = texture(null)
    paint(early) // nobody is waiting
    const old = frames.expect(128, 64)
    old.cancel()
    const lease = frames.expect(128, 64)
    const stale = texture(old.id), blank = texture(null), wrongSize = texture(lease.id, 64, 65), noMarkerRows = texture(lease.id, 128, 64)
    for (const t of [stale, blank, wrongSize, noMarkerRows]) paint(t)
    await settled()
    for (const t of [early, stale, blank, wrongSize, noMarkerRows]) expect(t.release).toHaveBeenCalledOnce()
    const right = texture(lease.id), later = texture(lease.id)
    paint(right); paint(later)
    const frame = await lease.frame
    expect(frame).toEqual({ kind: 'texture', texture: right, width: 128, height: 64 })
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

  it('a cancelled lease takes no paint', async () => {
    const { frames, paint } = setup()
    const lease = frames.expect(128, 64)
    lease.cancel()
    const t = texture(lease.id)
    paint(t)
    await settled()
    expect(t.release).toHaveBeenCalledOnce()
    const next = frames.expect(128, 64)
    paint(texture(next.id))
    await next.frame
  })

  it('holds several frames in flight, and a later frame\'s paint retires earlier ones as skipped', async () => {
    const { frames, paint } = setup()
    const [a, b, c] = [frames.expect(128, 64), frames.expect(128, 64), frames.expect(128, 64)]
    const ta = texture(a.id), tc = texture(c.id), lateB = texture(b.id)
    paint(ta)
    expect((await a.frame).kind).toBe('texture')
    paint(tc)
    await expect(b.frame).rejects.toBeInstanceOf(MotifFrameSkippedError)
    expect(await c.frame).toMatchObject({ texture: tc })
    paint(lateB) // paints arrive in frame order; a stray one is released
    await settled()
    expect(lateB.release).toHaveBeenCalledOnce()
  })

  it('leases a bitmap host\'s paint by the id in its last row', async () => {
    const { frames, paintBitmap } = setup(1000, null)
    const old = frames.expect(128, 64)
    old.cancel()
    const lease = frames.expect(128, 64)
    paintBitmap(bitmap(null))
    paintBitmap(bitmap(lease.id, 128, 64)) // no marker row below the picture
    paintBitmap(bitmap(old.id))
    const right = bitmap(lease.id)
    paintBitmap(right)
    expect(await lease.frame).toEqual({ kind: 'bitmap', image: right, width: 128, height: 64 })
  })

  it('a texture host without a marker reader leases nothing', async () => {
    const { frames, paint } = setup(5, null)
    const lease = frames.expect(128, 64)
    const t = texture(lease.id)
    paint(t)
    expect(t.release).toHaveBeenCalledOnce()
    await expect(lease.frame).rejects.toThrow('timed out')
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
