import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MotifFrameStore, type FrameCodec, type MotifTextureUpload } from './frameStore'

const roots: string[] = []
const hash = 'a'.repeat(32)
const texture = { kind: 'texture', key: 'motif-key', token: 'lease' } as const
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motif-store-test-'))
  roots.push(root)
  const codec: FrameCodec = { motifEncodePng: vi.fn(async () => Buffer.from('fast cache')) }
  const changed = vi.fn()
  const gpu = vi.fn<MotifTextureUpload>(async () => texture)
  return { root, codec, changed, gpu, store: new MotifFrameStore(async () => root, codec, changed) }
}
/** A `.wfrm` header (magic, width, height) padded to the minimum frame size. */
function frameHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(68)
  bytes.write('WCMFRM01'); bytes.writeUInt32LE(width, 8); bytes.writeUInt32LE(height, 12)
  return bytes
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

describe('MotifFrameStore', () => {
  it.each([
    [3840, 2160, 1, 3840, 2160], [3840, 2160, 2, 1920, 1080], [3840, 2160, 4, 960, 540],
    [3841, 2161, 1, 3841, 2161], [3841, 2161, 2, 1921, 1081], [3841, 2161, 4, 961, 541],
    [1, 1, 4, 1, 1], [5, 3, 2, 3, 2],
  ] as const)('uploads %ix%i at 1/%i into a %ix%i texture', async (width, height, div, scaledWidth, scaledHeight) => {
    const { root, store, gpu, changed } = await fixture()
    await (await store.prepareWrite(hash, 3))!.encoded(frameHeader(width, height))
    changed.mockClear()
    expect(await store.readTexture(hash, 3, div, gpu)).toEqual(texture)
    expect(gpu).toHaveBeenCalledExactlyOnceWith(path.join(root, 'Cache', 'raster', hash, '3.wfrm'), scaledWidth, scaledHeight, div)
    expect(changed).not.toHaveBeenCalled()
  })

  it('reads an absent frame as a miss without touching the texture lane', async () => {
    const { store, gpu, changed } = await fixture()
    expect(await store.readTexture(hash, 0, 1, gpu)).toBeNull()
    expect(gpu).not.toHaveBeenCalled()
    expect(changed.mock.calls).toEqual([[hash, 0, false]])
  })

  it.each([
    ['a short file', Buffer.from('WCMFRM01')],
    ['another magic', Buffer.concat([Buffer.from('WCMFRM02'), frameHeader(2, 2).subarray(8)])],
    ['a zero width', frameHeader(0, 2)],
    ['a width beyond the native bound', frameHeader(9000, 2)],
  ])('reads a bad header (%s) as a miss', async (_, bytes) => {
    const { store, gpu, changed } = await fixture()
    await (await store.prepareWrite(hash, 1))!.encoded(bytes)
    changed.mockClear()
    expect(await store.readTexture(hash, 1, 2, gpu)).toBeNull()
    expect(gpu).not.toHaveBeenCalled()
    expect(changed.mock.calls).toEqual([[hash, 1, false]])
  })

  it.each([
    'motif-frame: BLAKE3 mismatch',
    'motif-frame: scaled frame 1920x1080 does not fit the 1921x1081 pool',
  ])('takes a native file failure from the upload as a miss: %s', async message => {
    const { store, gpu, changed } = await fixture()
    await (await store.prepareWrite(hash, 2))!.encoded(frameHeader(3840, 2160))
    changed.mockClear()
    gpu.mockRejectedValueOnce(new Error(message))
    expect(await store.readTexture(hash, 2, 2, gpu)).toBeNull()
    expect(changed.mock.calls).toEqual([[hash, 2, false]])
  })

  it('keeps a frame in coverage when the texture lane is unavailable', async () => {
    const { store, gpu, changed } = await fixture()
    await (await store.prepareWrite(hash, 2))!.encoded(frameHeader(16, 16))
    changed.mockClear()
    gpu.mockResolvedValueOnce({ kind: 'unavailable' })
    expect(await store.readTexture(hash, 2, 1, gpu)).toEqual({ kind: 'unavailable' })
    expect(changed).not.toHaveBeenCalled()
  })

  it('passes a closed consumer through as an error, not a miss', async () => {
    const { store, gpu, changed } = await fixture()
    await (await store.prepareWrite(hash, 2))!.encoded(frameHeader(16, 16))
    changed.mockClear()
    gpu.mockRejectedValueOnce(new Error('Motif consumer closed'))
    await expect(store.readTexture(hash, 2, 1, gpu)).rejects.toThrow('Motif consumer closed')
    expect(changed).not.toHaveBeenCalled()
  })

  it('answers no workspace as a miss that leaves coverage alone', async () => {
    const { codec, changed, gpu } = await fixture()
    const store = new MotifFrameStore(async () => null, codec, changed)
    expect(await store.readTexture(hash, 0, 1, gpu)).toBeNull()
    expect(gpu).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
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
  it('persists only the new format', async () => {
    const { root, store, codec } = await fixture()
    const png = new Uint8Array([1, 2, 3])
    await store.write(hash, 7, png)
    expect(await store.has(hash, 7)).toBe(true)
    expect(codec.motifEncodePng).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(path.join(root, 'Cache', 'raster', hash))).toEqual(['7.wfrm'])
  })

  it('ignores old PNGs so the baker regenerates missing frames without migration', async () => {
    const { root, store, codec, gpu } = await fixture()
    const dir = path.join(root, 'Cache', 'raster', hash)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '0.png'), Buffer.from('old PNG'))
    expect(await store.has(hash, 0)).toBe(false)
    expect(await store.readTexture(hash, 0, 1, gpu)).toBeNull()
    expect(gpu).not.toHaveBeenCalled()
    expect(codec.motifEncodePng).not.toHaveBeenCalled()
    await store.write(hash, 0, new Uint8Array([1]))
    expect(await store.has(hash, 0)).toBe(true)
    expect(codec.motifEncodePng).toHaveBeenCalledExactlyOnceWith(Buffer.from([1]), true)
  })

  it('does not mark a frame persisted when encoding fails', async () => {
    const { root, store, codec, gpu } = await fixture()
    vi.mocked(codec.motifEncodePng).mockRejectedValue(new Error('encode failed'))
    await expect(store.write(hash, 0, new Uint8Array([1]))).rejects.toThrow('encode failed')
    expect(await store.has(hash, 0)).toBe(false)
    expect(await store.readTexture(hash, 0, 1, gpu)).toBeNull()
    expect(await fs.readdir(path.join(root, 'Cache', 'raster', hash))).toEqual([])
  })

  it('rejects traversal, negative and fractional frame addresses before accessing a workspace', async () => {
    const { codec, gpu } = await fixture()
    const workspace = vi.fn(async () => null)
    const store = new MotifFrameStore(workspace, codec)
    for (const [key, frame] of [['../outside', 0], [hash, -1], [hash, 0.5]] as const) {
      await expect(store.readTexture(key, frame, 1, gpu)).rejects.toThrow('Invalid Motif cache address')
    }
    for (const div of [0, 3, 8, 1.5, '2']) {
      await expect(store.readTexture(hash, 0, div as 1, gpu)).rejects.toThrow('Invalid Motif read divisor')
    }
    expect(workspace).not.toHaveBeenCalled()
    expect(gpu).not.toHaveBeenCalled()
    expect(await store.readTexture(hash, 0, 1, gpu)).toBeNull()
  })

  it('inventories canonical frames by stat alone while rejecting header-only files and temporary files', async () => {
    const { root, store } = await fixture()
    const bytes = frameHeader(2, 2)
    await (await store.prepareWrite(hash, 2))!.encoded(bytes)
    const dir = path.join(root, 'Cache', 'raster', hash)
    await fs.writeFile(path.join(dir, '3.wfrm'), bytes.subarray(0, 52))
    for (const name of ['02.wfrm', '-1.wfrm', '6.tmp', '7.png', '9007199254740993.wfrm']) await fs.writeFile(path.join(dir, name), bytes)
    await fs.mkdir(path.join(dir, '8.wfrm'))
    // Opening each file costs ~6 ms cold under on-access scanning (ADR 0144).
    const open = vi.spyOn(fs, 'open')
    try {
      expect(await store.inventory(hash)).toEqual([{ frame: 2, bytes: 68 }])
      expect(open).not.toHaveBeenCalled()
    } finally { open.mockRestore() }
  })

  it('leaves invalid headers to the reader, whose miss removes the inventoried frame', async () => {
    const { store, changed, gpu } = await fixture()
    await (await store.prepareWrite(hash, 4))!.encoded(frameHeader(9000, 2))
    expect(await store.inventory(hash)).toEqual([{ frame: 4, bytes: 68 }])
    expect(await store.readTexture(hash, 4, 1, gpu)).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(hash, 4, false)
  })

  it('takes a reader utility miss as a failed read: the frame leaves coverage, nothing else', async () => {
    const { root, codec } = await fixture()
    const changed = vi.fn()
    const admit = vi.fn()
    const store = new MotifFrameStore(async () => root, codec, changed, admit)
    store.reportMiss(hash, 4)
    expect(changed.mock.calls).toEqual([[hash, 4, false]])
    expect(admit).not.toHaveBeenCalled()
    expect(codec.motifEncodePng).not.toHaveBeenCalled()
  })

  it('keeps other inventory entries when one frame disappears during enumeration', async () => {
    const { store } = await fixture()
    const bytes = frameHeader(2, 2)
    for (const frame of [0, 1]) await (await store.prepareWrite(hash, frame))!.encoded(bytes)
    const original = fs.lstat.bind(fs)
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
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
    const { store, changed, gpu } = await fixture()
    await (await store.prepareWrite(hash, 7))!.encoded(frameHeader(2, 2))
    expect(changed).toHaveBeenLastCalledWith(hash, 7, true, 68)
    gpu.mockRejectedValueOnce(new Error('motif-frame: BLAKE3 mismatch'))
    expect(await store.readTexture(hash, 7, 1, gpu)).toBeNull()
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
