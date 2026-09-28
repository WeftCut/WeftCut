import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MotifFrameStore, type FrameCodec } from './frameStore'

const roots: string[] = []
const hash = 'a'.repeat(32)
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motif-store-test-'))
  roots.push(root)
  const rgba = new Uint8Array([22, 33, 44, 128])
  const codec: FrameCodec = {
    motifEncodePng: vi.fn(async () => Buffer.from('fast cache')),
    motifReadFrame: vi.fn(async file => { await fs.readFile(file); return { width: 1, height: 1, rgba } }),
  }
  return { root, codec, store: new MotifFrameStore(async () => root, codec), rgba }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

describe('MotifFrameStore', () => {
  it('binds a native write to the workspace at admission and uses the same reader', async () => {
    const { root, codec } = await fixture()
    let workspace: string | null = root
    const store = new MotifFrameStore(async () => workspace, codec)
    const writer = await store.prepareWrite(hash, 2)
    workspace = null
    await writer!.encoded(Buffer.from('native frame'))
    expect(await fs.readFile(path.join(root, 'Cache', 'raster', hash, '2.wfrm'), 'utf8')).toBe('native frame')
    expect(codec.motifEncodePng).not.toHaveBeenCalled()
    expect(await fs.readdir(path.join(root, 'Cache', 'raster', hash))).toEqual(['2.wfrm'])
  })
  it('persists only the new format, then resolves pixels without PNG decoding', async () => {
    const { root, store, rgba, codec } = await fixture()
    const png = new Uint8Array([1, 2, 3])
    await store.write(hash, 7, png)
    expect(await store.has(hash, 7)).toBe(true)
    expect(await store.read(hash, 7)).toEqual({ kind: 'rgba', width: 1, height: 1, rgba })
    expect(codec.motifEncodePng).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(path.join(root, 'Cache', 'raster', hash))).toEqual(['7.wfrm'])
  })

  it('ignores old PNGs so the baker regenerates missing frames without migration', async () => {
    const { root, store, codec, rgba } = await fixture()
    const dir = path.join(root, 'Cache', 'raster', hash)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '0.png'), Buffer.from('old PNG'))
    expect(await store.has(hash, 0)).toBe(false)
    expect(await store.read(hash, 0)).toBeNull()
    expect(codec.motifEncodePng).not.toHaveBeenCalled()
    await store.write(hash, 0, new Uint8Array([1]))
    expect(await store.has(hash, 0)).toBe(true)
    expect(await store.read(hash, 0)).toEqual({ kind: 'rgba', width: 1, height: 1, rgba })
    expect(codec.motifEncodePng).toHaveBeenCalledExactlyOnceWith(Buffer.from([1]), true)
  })

  it('treats corrupt frames as cache misses without starting a conversion', async () => {
    const { store, codec } = await fixture()
    vi.mocked(codec.motifReadFrame).mockRejectedValue(new Error('corrupt'))
    expect(await store.read(hash, 0)).toBeNull()
    expect(codec.motifEncodePng).not.toHaveBeenCalled()
  })

  it('does not mark a frame persisted when encoding fails', async () => {
    const { root, store, codec } = await fixture()
    vi.mocked(codec.motifEncodePng).mockRejectedValue(new Error('encode failed'))
    await expect(store.write(hash, 0, new Uint8Array([1]))).rejects.toThrow('encode failed')
    expect(await store.has(hash, 0)).toBe(false)
    expect(await store.read(hash, 0)).toBeNull()
    expect(await fs.readdir(path.join(root, 'Cache', 'raster', hash))).toEqual([])
  })

  it('rejects traversal, negative and fractional frame addresses before accessing a workspace', async () => {
    const { codec } = await fixture()
    const workspace = vi.fn(async () => null)
    const store = new MotifFrameStore(workspace, codec)
    for (const [key, frame] of [['../outside', 0], [hash, -1], [hash, 0.5]] as const) {
      await expect(store.read(key, frame)).rejects.toThrow('Invalid Motif cache address')
    }
    expect(workspace).not.toHaveBeenCalled()
    expect(await store.read(hash, 0)).toBeNull()
  })
})
