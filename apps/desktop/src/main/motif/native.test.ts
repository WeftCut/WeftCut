import { describe, expect, it, vi } from 'vitest'
import { loadMotifNative } from './native'
import { MOTIF_LIMITS } from '../../shared/motifs/limits'

const TUNING = { scratchIdleBytes: 8 * 1024 * 1024, bandThreads: 3 }
const timing = { read: { readMs: 1, decodeMs: 2, hashMs: 3, scaleMs: 4 }, mapMs: 5, acquireMs: 6, gpuMs: 7 }
const tagged = (code: string) => new Error(`[motif:${code}] synthetic ${code}`)
const expectCode = (code: string) => expect.objectContaining({ name: 'MotifError', code })
/** What `call` throws. */
function thrown(call: () => unknown): unknown {
  try { call() } catch (error) { return error }
  throw new Error('did not throw')
}

/** A stand-in for `@weftcut/core`'s Motif exports; every call is recorded. */
function fakeCore() {
  const raw = { finish: vi.fn(async (to: string) => Buffer.from(to === 'png' ? 'png' : 'wfrm')) }
  const pool = {
    handle: vi.fn(() => Buffer.from('nt-handle')),
    upload: vi.fn(async (_path: string, _div: number) => timing),
    copy: vi.fn(async (_handle: Buffer) => {}),
    close: vi.fn(),
  }
  const pools = {
    forUpload: vi.fn((_w: number, _h: number) => pool),
    forCopy: vi.fn((_w: number, _h: number, _bgra: boolean) => pool),
  }
  const encoder = { read: vi.fn(async (_handle: Buffer, _height: number) => raw), close: vi.fn() }
  const marker = { read: vi.fn(async (_handle: Buffer, pixels: number) => Buffer.alloc(pixels * 4, 1)), close: vi.fn() }
  const frames = {
    read: vi.fn(async (_path: string, _div: number) => ({ width: 2, height: 1, rgba: Buffer.alloc(8), timing: timing.read })),
    close: vi.fn(),
  }
  const classes = {
    // A napi class with factories alone: `new` is not how it is made.
    MotifGpuPool: Object.assign(function () { throw new Error('use a factory') }, pools),
    MotifTextureEncoder: vi.fn(function () { return encoder }),
    MotifMarkerReader: vi.fn(function () { return marker }),
  }
  const core: Record<string, unknown> = {
    motifLimits: vi.fn(() => ({ ...MOTIF_LIMITS })),
    motifConfigure: vi.fn(),
    motifConvert: vi.fn(async (_pixels: Buffer, _width: number, _height: number, from: string, to: string) => Buffer.from(`${from} as ${to}`)),
    MotifFrameFileReader: vi.fn(function () { return frames }),
    ...classes,
  }
  return { core, raw, pool, pools, encoder, marker, frames, classes }
}

const load = (core: unknown, platform: NodeJS.Platform = 'win32') => loadMotifNative(TUNING, core, platform)

describe('loadMotifNative', () => {
  it('configures the core once with its share of the tuning', async () => {
    const { core } = fakeCore()
    const native = load(core)
    await native.convert({ from: 'rgba', to: 'frame' }, Buffer.alloc(8), 2, 1)
    await native.openFrameFileReader().read('0.wfrm', 1)
    native.gpu!.openPool({ use: 'upload', width: 2, height: 1 })
    expect(core.motifConfigure).toHaveBeenCalledExactlyOnceWith({ scratchIdleBytes: TUNING.scratchIdleBytes, bandThreads: 3 })
  })

  it('refuses a core whose limits differ from the app\'s, before configuring it', () => {
    const { core } = fakeCore()
    core.motifLimits = () => ({ ...MOTIF_LIMITS, maxDimension: 4096 })
    expect(() => load(core)).toThrow(/Motif limits differ/)
    expect(core.motifConfigure).not.toHaveBeenCalled()
  })

  it('names every missing export and asks for a rebuild', () => {
    const { core } = fakeCore()
    delete core.motifConvert
    delete core.motifConfigure
    delete core.MotifFrameFileReader
    expect(() => load(core)).toThrow(/motifConfigure, motifConvert, MotifFrameFileReader: rebuild it/)
    expect(() => load(null)).toThrow(/rebuild it/)
  })

  it('has no GPU side off Windows, or on Windows without every D3D11 class', () => {
    expect(load(fakeCore().core, 'linux').gpu).toBeNull()
    expect(load(fakeCore().core, 'darwin').gpu).toBeNull()
    for (const name of ['MotifGpuPool', 'MotifTextureEncoder', 'MotifMarkerReader']) {
      const { core } = fakeCore()
      delete core[name]
      expect(load(core).gpu, name).toBeNull()
    }
    expect(load(fakeCore().core).gpu).not.toBeNull()
  })

  describe('convert', () => {
    it('hands each conversion to the native core by name', async () => {
      const { core } = fakeCore()
      const native = load(core, 'linux')
      const px = Buffer.alloc(12)
      expect(String(await native.convert({ from: 'rgba', to: 'frame' }, px, 3, 1))).toBe('rgba as frame')
      expect(String(await native.convert({ from: 'premultipliedBgra', to: 'frame' }, px, 3, 1))).toBe('premultipliedBgra as frame')
      expect(String(await native.convert({ from: 'premultipliedBgra', to: 'rgba' }, px, 3, 1))).toBe('premultipliedBgra as rgba')
      expect(core.motifConvert).toHaveBeenLastCalledWith(px, 3, 1, 'premultipliedBgra', 'rgba')
    })

    it('decodes a tagged failure of every conversion', async () => {
      const { core } = fakeCore()
      const codes: Record<string, string> = { 'rgba as frame': 'disk', 'premultipliedBgra as frame': 'oversize', 'premultipliedBgra as rgba': 'capacity' }
      core.motifConvert = async (_px: Buffer, _w: number, _h: number, from: string, to: string) => { throw tagged(codes[`${from} as ${to}`]!) }
      const native = load(core, 'linux')
      await expect(native.convert({ from: 'rgba', to: 'frame' }, Buffer.alloc(4), 1, 1)).rejects.toEqual(expectCode('disk'))
      await expect(native.convert({ from: 'premultipliedBgra', to: 'frame' }, Buffer.alloc(4), 1, 1)).rejects.toEqual(expectCode('oversize'))
      await expect(native.convert({ from: 'premultipliedBgra', to: 'rgba' }, Buffer.alloc(4), 1, 1)).rejects.toEqual(expectCode('capacity'))
    })

    it('leaves an untagged failure as it is', async () => {
      const { core } = fakeCore()
      const failure = new Error('motif bitmap is smaller than its picture')
      core.motifConvert = async () => { throw failure }
      await expect(load(core, 'linux').convert({ from: 'premultipliedBgra', to: 'frame' }, Buffer.alloc(4), 1, 1)).rejects.toBe(failure)
    })
  })

  it('opens a native frame file reader per reader and closes it, decoding every failure', async () => {
    const { core, frames } = fakeCore()
    const native = load(core, 'linux')
    expect(core.MotifFrameFileReader).not.toHaveBeenCalled()
    const reader = native.openFrameFileReader()
    expect(core.MotifFrameFileReader).toHaveBeenCalledOnce()
    await expect(reader.read('a.wfrm', 2)).resolves.toMatchObject({ width: 2, height: 1 })
    expect(frames.read).toHaveBeenCalledExactlyOnceWith('a.wfrm', 2)
    frames.read.mockRejectedValueOnce(tagged('miss'))
    await expect(reader.read('b.wfrm', 1)).rejects.toEqual(expectCode('miss'))
    reader.close()
    expect(frames.close).toHaveBeenCalledOnce()
    frames.read.mockRejectedValueOnce(tagged('closed'))
    await expect(reader.read('c.wfrm', 1)).rejects.toEqual(expectCode('closed'))
    frames.close.mockImplementationOnce(() => { throw tagged('device') })
    expect(thrown(() => reader.close())).toEqual(expectCode('device'))
    ;(core.MotifFrameFileReader as ReturnType<typeof vi.fn>).mockImplementationOnce(function () { throw tagged('oversize') })
    expect(thrown(() => native.openFrameFileReader())).toEqual(expectCode('oversize'))
  })

  describe('gpu', () => {
    it('opens a pool per spec through its factory and drives it', async () => {
      const { core, pool, pools } = fakeCore()
      const gpu = load(core).gpu!
      const upload = gpu.openPool({ use: 'upload', width: 4, height: 2 })
      gpu.openPool({ use: 'copy', width: 4, height: 2, format: 'bgra' })
      gpu.openPool({ use: 'copy', width: 4, height: 2, format: 'rgba' })
      expect(pools.forUpload.mock.calls).toEqual([[4, 2]])
      expect(pools.forCopy.mock.calls).toEqual([[4, 2, true], [4, 2, false]])
      expect(String(upload.handle())).toBe('nt-handle')
      await expect(upload.upload('f.wfrm', 4)).resolves.toEqual(timing)
      expect(pool.upload).toHaveBeenCalledExactlyOnceWith('f.wfrm', 4)
      await upload.copy(Buffer.from('osr'))
      expect(pool.copy).toHaveBeenCalledExactlyOnceWith(Buffer.from('osr'))
      upload.close()
      expect(pool.close).toHaveBeenCalledOnce()
    })

    it('decodes a failure of every constructor and method', async () => {
      const { core, pool, encoder, marker, raw } = fakeCore()
      const gpu = load(core).gpu!
      pool.upload.mockRejectedValueOnce(tagged('miss'))
      pool.copy.mockRejectedValueOnce(tagged('transient'))
      pool.handle.mockImplementationOnce(() => { throw tagged('closed') })
      pool.close.mockImplementationOnce(() => { throw tagged('device') })
      const opened = gpu.openPool({ use: 'upload', width: 1, height: 1 })
      await expect(opened.upload('f.wfrm', 1)).rejects.toEqual(expectCode('miss'))
      await expect(opened.copy(Buffer.alloc(8))).rejects.toEqual(expectCode('transient'))
      expect(thrown(() => opened.handle())).toEqual(expectCode('closed'))
      expect(thrown(() => opened.close())).toEqual(expectCode('device'))

      encoder.read.mockRejectedValueOnce(tagged('closed'))
      raw.finish.mockRejectedValueOnce(tagged('disk'))
      raw.finish.mockRejectedValueOnce(tagged('oversize'))
      const textures = gpu.openTextureReader()
      await expect(textures.read(Buffer.alloc(8), 1)).rejects.toEqual(expectCode('closed'))
      const frame = await textures.read(Buffer.alloc(8), 1)
      await expect(frame.finish('frame')).rejects.toEqual(expectCode('disk'))
      await expect(frame.finish('png')).rejects.toEqual(expectCode('oversize'))
      encoder.close.mockImplementationOnce(() => { throw tagged('device') })
      expect(thrown(() => textures.close())).toEqual(expectCode('device'))

      marker.read.mockRejectedValueOnce(tagged('transient'))
      const markers = gpu.openMarkerReader()
      await expect(markers.read(Buffer.alloc(8), 4)).rejects.toEqual(expectCode('transient'))
      marker.close.mockImplementationOnce(() => { throw tagged('device') })
      expect(thrown(() => markers.close())).toEqual(expectCode('device'))

      for (const name of ['forUpload', 'forCopy', 'MotifTextureEncoder', 'MotifMarkerReader'] as const) {
        const broken = fakeCore()
        if (name === 'forUpload' || name === 'forCopy') broken.pools[name].mockImplementationOnce(() => { throw tagged('device') })
        else broken.classes[name].mockImplementationOnce(function () { throw tagged('device') })
        const brokenGpu = load(broken.core).gpu!
        const open = { forUpload: () => brokenGpu.openPool({ use: 'upload', width: 1, height: 1 }),
          forCopy: () => brokenGpu.openPool({ use: 'copy', width: 1, height: 1, format: 'rgba' }),
          MotifTextureEncoder: () => brokenGpu.openTextureReader(), MotifMarkerReader: () => brokenGpu.openMarkerReader() }[name]
        expect(thrown(open), name).toEqual(expectCode('device'))
      }
    })

    it('finishes a raw frame as a stored frame or a PNG', async () => {
      const { core, raw } = fakeCore()
      const frame = await load(core).gpu!.openTextureReader().read(Buffer.alloc(8), 2)
      expect(String(await frame.finish('frame'))).toBe('wfrm')
      expect(String(await frame.finish('png'))).toBe('png')
      expect(raw.finish.mock.calls).toEqual([['frame'], ['png']])
    })
  })

  // e2e specs replace addon exports and prototype methods after main has
  // loaded the adapter (motif-bake, motif-frame-reader).
  describe('calls the core as it is when called', () => {
    it('a replaced export', async () => {
      const { core } = fakeCore()
      const native = load(core, 'linux')
      const original = core.motifConvert as (...args: unknown[]) => Promise<Buffer>
      let held = 0
      core.motifConvert = (...args: unknown[]) => { held++; return original(...args) }
      await native.convert({ from: 'premultipliedBgra', to: 'frame' }, Buffer.alloc(4), 1, 1)
      expect(held).toBe(1)
    })

    it('a replaced frame file reader class or its read', async () => {
      class Reader {
        read(_path: string, _div: number) { return Promise.resolve({ width: 9, height: 9, rgba: Buffer.alloc(0), timing: timing.read }) }
        close() {}
      }
      const { core } = fakeCore()
      const native = load(core, 'linux')
      core.MotifFrameFileReader = Reader
      const reader = native.openFrameFileReader()
      await expect(reader.read('x.wfrm', 1)).resolves.toMatchObject({ width: 9 })
      const read = Reader.prototype.read
      const reads: string[] = []
      Reader.prototype.read = function (this: Reader, path: string, div: number) { reads.push(path); return read.call(this, path, div) }
      await reader.read('held.wfrm', 1)
      expect(reads).toEqual(['held.wfrm'])
    })

    it('a replaced class or prototype method', async () => {
      class Encoder {
        read(_handle: Buffer, _height: number) { return Promise.resolve({ finish: async () => Buffer.from('a') }) }
        close() {}
      }
      class Pool {
        static forUpload() { return new Pool() }
        static forCopy() { return new Pool() }
        handle() { return Buffer.alloc(8) }
        upload(_path: string, _div: number) { return Promise.resolve(timing) }
        copy() { return Promise.resolve() }
        close() {}
      }
      const { core } = fakeCore()
      core.MotifTextureEncoder = Encoder
      core.MotifGpuPool = Pool
      const gpu = load(core).gpu!
      const pool = gpu.openPool({ use: 'upload', width: 1, height: 1 })
      const uploads: string[] = []
      const upload = Pool.prototype.upload
      Pool.prototype.upload = function (this: Pool, path: string, div: number) { uploads.push(path); return upload.call(this, path, div) }
      await pool.upload('held.wfrm', 1)
      expect(uploads).toEqual(['held.wfrm'])
      const reader = gpu.openTextureReader()
      Encoder.prototype.read = () => Promise.reject(new Error('injected readback failure'))
      await expect(reader.read(Buffer.alloc(8), 1)).rejects.toThrow('injected readback failure')
      let opened = 0
      core.MotifMarkerReader = function () { opened++; return { read: async () => Buffer.alloc(0), close() {} } }
      gpu.openMarkerReader()
      expect(opened).toBe(1)
    })
  })
})
