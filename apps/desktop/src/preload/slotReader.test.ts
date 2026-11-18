import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedTextureImported } from 'electron'
import { createSlotReader } from './slotReader'

/** A received texture whose frames say which texture they came from. */
function texture(name: string) {
  const frames: { close: ReturnType<typeof vi.fn> }[] = []
  const imported = {
    release: vi.fn(),
    getVideoFrame: vi.fn(() => {
      const frame = { name, close: vi.fn() }
      frames.push(frame)
      return frame
    }),
  }
  return { imported: imported as unknown as SharedTextureImported, release: imported.release, frames }
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async (frame: { name: string }) => ({ from: frame.name })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('slot reader', () => {
  it('keys each texture by its own tag, whatever order textures and producers arrive in', async () => {
    const reader = createSlotReader()
    // Two sessions' pools interleaved, slots out of order, and a Motif pool.
    reader.receive(texture('b1').imported, { key: 'video-b', slot: 1 })
    reader.receive(texture('a2').imported, { key: 'video-a', slot: 2 })
    reader.receive(texture('m0').imported, { key: 'motif-x', slot: 0 })
    reader.receive(texture('a0').imported, { key: 'video-a', slot: 0 })
    reader.receive(texture('b0').imported, { key: 'video-b', slot: 0 })
    const read = async (key: string, slot: number) => ((await reader.read(key, slot)).bitmap as unknown as { from: string }).from
    expect(await read('video-a', 0)).toBe('a0')
    expect(await read('video-a', 2)).toBe('a2')
    expect(await read('video-b', 0)).toBe('b0')
    expect(await read('video-b', 1)).toBe('b1')
    expect(await read('motif-x', 0)).toBe('m0')
  })

  it('closes the video frame of every read, whether the bitmap was made or not', async () => {
    const reader = createSlotReader()
    const t = texture('a0')
    reader.receive(t.imported, { key: 'a', slot: 0 })
    await reader.read('a', 0)
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('context lost'))
    await expect(reader.read('a', 0)).rejects.toThrow('context lost')
    expect(t.frames.map(f => f.close.mock.calls.length)).toEqual([1, 1])
  })

  it('rejects a read of a slot that holds no texture', async () => {
    const reader = createSlotReader()
    reader.receive(texture('a0').imported, { key: 'a', slot: 0 })
    await expect(reader.read('a', 1)).rejects.toThrow()
    await expect(reader.read('b', 0)).rejects.toThrow()
  })

  it("releases a dropped producer's textures, and one of its textures that arrives after the drop", async () => {
    const reader = createSlotReader()
    const kept = texture('a0'), other = texture('b0'), late = texture('a1')
    reader.receive(kept.imported, { key: 'a', slot: 0 })
    reader.receive(other.imported, { key: 'b', slot: 0 })
    reader.drop('a')
    reader.receive(late.imported, { key: 'a', slot: 1 })
    expect(kept.release).toHaveBeenCalledOnce()
    expect(late.release).toHaveBeenCalledOnce()
    expect(other.release).not.toHaveBeenCalled()
    await expect(reader.read('a', 0)).rejects.toThrow()
    await expect(reader.read('b', 0)).resolves.toBeDefined()
  })

  it('releases a texture with a malformed tag instead of keeping it', () => {
    const reader = createSlotReader()
    const untagged = texture('x'), badSlot = texture('y')
    reader.receive(untagged.imported, undefined)
    reader.receive(badSlot.imported, { key: 'a', slot: 'one' })
    expect(untagged.release).toHaveBeenCalledOnce()
    expect(badSlot.release).toHaveBeenCalledOnce()
  })

  it('releases everything when the document goes, and every texture that arrives after', () => {
    const reader = createSlotReader()
    const a = texture('a0'), m = texture('m0'), late = texture('a1')
    reader.receive(a.imported, { key: 'a', slot: 0 })
    reader.receive(m.imported, { key: 'motif-x', slot: 0 })
    reader.close()
    reader.receive(late.imported, { key: 'c', slot: 0 })
    expect([a.release, m.release, late.release].map(r => r.mock.calls.length)).toEqual([1, 1, 1])
  })
})
