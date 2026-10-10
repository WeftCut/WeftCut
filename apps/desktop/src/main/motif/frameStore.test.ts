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
  it('reads the same cached pixels on CPU when GPU allocation is unavailable', async () => {
    const { store, rgba } = await fixture()
    const header = Buffer.alloc(16)
    header.write('WCMFRM01')
    header.writeUInt32LE(1, 8); header.writeUInt32LE(1, 12)
    await (await store.prepareWrite(hash, 0))!.encoded(header)
    const gpu = vi.fn(async () => { throw new Error('Motif GPU budget exhausted') })
    expect(await store.read(hash, 0, gpu)).toEqual({ kind: 'rgba', width: 1, height: 1, rgba })
    expect(gpu).toHaveBeenCalledOnce()
  })

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

  it('inventories canonical frames while rejecting truncated payloads, impossible dimensions and temporary files', async () => {
    const { root, store } = await fixture()
    const bytes = Buffer.alloc(68)
    bytes.write('WCMFRM01'); bytes.writeUInt32LE(2, 8); bytes.writeUInt32LE(2, 12)
    await (await store.prepareWrite(hash, 2))!.encoded(bytes)
    const dir = path.join(root, 'Cache', 'raster', hash)
    await fs.writeFile(path.join(dir, '3.wfrm'), bytes.subarray(0, 52))
    const huge = Buffer.from(bytes); huge.writeUInt32LE(9000, 8)
    await fs.writeFile(path.join(dir, '4.wfrm'), huge)
    const codec = Buffer.from(bytes); codec.writeUInt32LE(9, 16)
    await fs.writeFile(path.join(dir, '5.wfrm'), codec)
    for (const name of ['02.wfrm', '-1.wfrm', '6.tmp', '7.png', '9007199254740993.wfrm']) await fs.writeFile(path.join(dir, name), bytes)
    await fs.mkdir(path.join(dir, '8.wfrm'))
    expect(await store.inventory(hash)).toEqual([{ frame: 2, bytes: 68 }])
  })

  it('keeps other inventory entries when one frame disappears during enumeration', async () => {
    const { store } = await fixture()
    const bytes = Buffer.alloc(68)
    bytes.write('WCMFRM01'); bytes.writeUInt32LE(2, 8); bytes.writeUInt32LE(2, 12)
    for (const frame of [0, 1]) await (await store.prepareWrite(hash, frame))!.encoded(bytes)
    const original = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('0.wfrm')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return original(...args)
    })
    try { expect(await store.inventory(hash)).toEqual([{ frame: 1, bytes: 68 }]) }
    finally { spy.mockRestore() }
  })

  it('collects only orphan hash directories and rechecks session validity before mutation', async () => {
    const { root, store } = await fixture()
    const orphan = 'b'.repeat(32)
    await (await store.prepareWrite(hash, 0))!.encoded(Buffer.from('live'))
    await (await store.prepareWrite(orphan, 0))!.encoded(Buffer.from('orphan'))
    const raster = path.join(root, 'Cache', 'raster')
    const legacy = path.join(raster, 'deadbeef')
    await fs.mkdir(legacy)
    await fs.writeFile(path.join(legacy, '0.png'), Buffer.from('legacy orphan'))
    await fs.mkdir(path.join(raster, 'unrelated'))
    await store.collect(new Set([hash]), () => false)
    expect(await store.has(orphan, 0)).toBe(true)
    expect(await fs.readdir(legacy)).toEqual(['0.png'])
    await store.collect(new Set([hash]), () => true)
    expect(await store.has(hash, 0)).toBe(true)
    expect(await store.has(orphan, 0)).toBe(false)
    expect(await fs.readdir(raster)).toEqual([hash, 'unrelated'])
  })

  it('notifies exact successful writes and corrupt-read misses', async () => {
    const { root, codec } = await fixture()
    const changed = vi.fn()
    const store = new MotifFrameStore(async () => root, codec, changed)
    await (await store.prepareWrite(hash, 7))!.encoded(Buffer.from('payload'))
    expect(changed).toHaveBeenLastCalledWith(hash, 7, true, 7)
    vi.mocked(codec.motifReadFrame).mockRejectedValue(new Error('checksum mismatch'))
    expect(await store.read(hash, 7)).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(hash, 7, false)
  })

  it('checks encoded size before either native or PNG writes and keeps the queue usable after refusal', async () => {
    const { root, codec } = await fixture()
    const admit = vi.fn().mockImplementationOnce(() => { throw new Error('motif-disk-capacity') })
    const changed = vi.fn()
    const store = new MotifFrameStore(async () => root, codec, changed, admit)
    await expect((await store.prepareWrite(hash, 0))!.encoded(Buffer.from('native'))).rejects.toThrow('motif-disk-capacity')
    expect(changed).not.toHaveBeenCalled()
    expect(await store.has(hash, 0)).toBe(false)
    await store.write(hash, 1, new Uint8Array([1]))
    expect(admit).toHaveBeenNthCalledWith(1, hash, 0, 6)
    expect(admit).toHaveBeenNthCalledWith(2, hash, 1, Buffer.byteLength('fast cache'))
    expect(await store.has(hash, 1)).toBe(true)
  })
})
