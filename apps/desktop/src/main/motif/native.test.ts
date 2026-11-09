import { describe, expect, it, vi } from 'vitest'
import { loadMotifNative } from './native'
import { MotifError } from '../../shared/motifs/errors'
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
  const raw = { finish: vi.fn(async () => Buffer.from('wfrm')), finishPng: vi.fn(async () => Buffer.from('png')) }
  const pool = {
    handles: vi.fn(() => [Buffer.from('nt-handle')]),
    uploadFile: vi.fn(async (_path: string, _slot: number, _div?: number) => timing),
    copyTexture: vi.fn(async (_handle: Buffer, _slot: number) => {}),
    close: vi.fn(),
  }
  const encoder = { read: vi.fn(async (_handle: Buffer, _height: number) => raw), close: vi.fn() }
  const marker = { read: vi.fn(async (_handle: Buffer, pixels: number) => Buffer.alloc(pixels * 4, 1)), close: vi.fn() }
  const classes = {
    MotifGpuPool: vi.fn(function (_w: number, _h: number, _count: number, _bgra: boolean, _upload: boolean) { return pool }),
    MotifTextureEncoder: vi.fn(function () { return encoder }),
    MotifMarkerReader: vi.fn(function () { return marker }),
  }
  const core: Record<string, unknown> = {
    motifLimits: vi.fn(() => ({ ...MOTIF_LIMITS })),
    motifConfigure: vi.fn(),
    motifReadFrameScaled: vi.fn(async () => ({ width: 2, height: 1, rgba: Buffer.alloc(8), timing: timing.read })),
    motifConvert: vi.fn(async (_pixels: Buffer, _width: number, _height: number, from: string, to: string) => Buffer.from(`${from} as ${to}`)),
    ...classes,
  }
  return { core, raw, pool, encoder, marker, classes }
}

const load = (core: unknown, platform: NodeJS.Platform = 'win32') => loadMotifNative(TUNING, core, platform)

describe('loadMotifNative', () => {
  it('configures the core once with its share of the tuning', async () => {
    const { core } = fakeCore()
    const native = load(core)
    await native.convert({ from: 'rgba', to: 'frame' }, Buffer.alloc(8), 2, 1)
    await native.openFrameReader().read('0.wfrm', 1)
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
    expect(() => load(core)).toThrow(/motifConfigure, motifConvert: rebuild it/)
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

  it('reads stored frames, decoding a miss', async () => {
    const { core } = fakeCore()
    const reader = load(core, 'linux').openFrameReader()
    await expect(reader.read('a.wfrm', 2)).resolves.toMatchObject({ width: 2, height: 1 })
    expect(core.motifReadFrameScaled).toHaveBeenCalledExactlyOnceWith('a.wfrm', 2)
    core.motifReadFrameScaled = async () => { throw tagged('miss') }
    await expect(reader.read('b.wfrm', 1)).rejects.toEqual(expectCode('miss'))
    reader.close()
  })

  describe('gpu', () => {
    it('opens a one-slot pool per spec and drives slot 0', async () => {
      const { core, pool, classes } = fakeCore()
      const gpu = load(core).gpu!
      const upload = gpu.openPool({ use: 'upload', width: 4, height: 2 })
      gpu.openPool({ use: 'copy', width: 4, height: 2, format: 'bgra' })
      gpu.openPool({ use: 'copy', width: 4, height: 2, format: 'rgba' })
      expect(classes.MotifGpuPool.mock.calls).toEqual([[4, 2, 1, false, true], [4, 2, 1, true, false], [4, 2, 1, false, false]])
      expect(String(upload.handle())).toBe('nt-handle')
      await expect(upload.upload('f.wfrm', 4)).resolves.toEqual(timing)
      expect(pool.uploadFile).toHaveBeenCalledExactlyOnceWith('f.wfrm', 0, 4)
      await upload.copy(Buffer.from('osr'))
      expect(pool.copyTexture).toHaveBeenCalledExactlyOnceWith(Buffer.from('osr'), 0)
      upload.close()
      expect(pool.close).toHaveBeenCalledOnce()
    })

    it('decodes a failure of every constructor and method', async () => {
      const { core, pool, encoder, marker, raw } = fakeCore()
      const gpu = load(core).gpu!
      pool.uploadFile.mockRejectedValueOnce(tagged('miss'))
      pool.copyTexture.mockRejectedValueOnce(tagged('transient'))
      pool.handles.mockImplementationOnce(() => { throw tagged('closed') })
      pool.close.mockImplementationOnce(() => { throw tagged('device') })
      const opened = gpu.openPool({ use: 'upload', width: 1, height: 1 })
      await expect(opened.upload('f.wfrm', 1)).rejects.toEqual(expectCode('miss'))
      await expect(opened.copy(Buffer.alloc(8))).rejects.toEqual(expectCode('transient'))
      expect(thrown(() => opened.handle())).toBeInstanceOf(MotifError)
      expect(thrown(() => opened.close())).toEqual(expectCode('device'))

      encoder.read.mockRejectedValueOnce(tagged('closed'))
      raw.finish.mockRejectedValueOnce(tagged('disk'))
      raw.finishPng.mockRejectedValueOnce(tagged('oversize'))
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

      for (const name of ['MotifGpuPool', 'MotifTextureEncoder', 'MotifMarkerReader'] as const) {
        const broken = fakeCore()
        broken.classes[name].mockImplementationOnce(function () { throw tagged('device') })
        const brokenGpu = load(broken.core).gpu!
        const open = { MotifGpuPool: () => brokenGpu.openPool({ use: 'copy', width: 1, height: 1, format: 'rgba' }),
          MotifTextureEncoder: () => brokenGpu.openTextureReader(), MotifMarkerReader: () => brokenGpu.openMarkerReader() }[name]
        expect(thrown(open), name).toEqual(expectCode('device'))
      }
    })

    it('finishes a raw frame as a stored frame or a PNG', async () => {
      const { core, raw } = fakeCore()
      const frame = await load(core).gpu!.openTextureReader().read(Buffer.alloc(8), 2)
      expect(String(await frame.finish('frame'))).toBe('wfrm')
      expect(String(await frame.finish('png'))).toBe('png')
      expect(raw.finish).toHaveBeenCalledOnce()
      expect(raw.finishPng).toHaveBeenCalledOnce()
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
      core.motifReadFrameScaled = async () => ({ width: 9, height: 9, rgba: Buffer.alloc(0), timing: timing.read })
      await expect(native.openFrameReader().read('x.wfrm', 1)).resolves.toMatchObject({ width: 9 })
      expect(held).toBe(1)
    })

    it('a replaced class or prototype method', async () => {
      class Encoder {
        read(_handle: Buffer, _height: number) { return Promise.resolve({ finish: async () => Buffer.from('a'), finishPng: async () => Buffer.from('b') }) }
        close() {}
      }
      class Pool {
        handles() { return [Buffer.alloc(8)] }
        uploadFile(_path: string, _slot: number, _div?: number) { return Promise.resolve(timing) }
        copyTexture() { return Promise.resolve() }
        close() {}
      }
      const { core } = fakeCore()
      core.MotifTextureEncoder = Encoder
      core.MotifGpuPool = Pool
      const gpu = load(core).gpu!
      const pool = gpu.openPool({ use: 'upload', width: 1, height: 1 })
      const uploads: string[] = []
      const upload = Pool.prototype.uploadFile
      Pool.prototype.uploadFile = function (this: Pool, path: string, ...rest: [number, number?]) { uploads.push(path); return upload.call(this, path, ...rest) }
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
