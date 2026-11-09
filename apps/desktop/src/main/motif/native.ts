import { createRequire } from 'node:module'
import { decodeMotifError, decodingMotifErrors, MotifError } from '../../shared/motifs/errors'
import { assertMotifLimits } from '../../shared/motifs/limits'
import type { MotifReadPixels } from '../../shared/motifs/readerProtocol'
import type { MotifUploadTiming } from '../../shared/motifs/frameTransport'
import type { ResolvedMotifTuning } from '../../shared/motifs/tuning'

// The one adapter between Motif code and the native core (`@weftcut/core`), in
// main and in the reader utility: it checks the addon, configures it once and
// decodes every `[motif:<code>]` failure (docs/motifs.md#failure-codes). No
// Electron import: the reader utility loads it too.

/** A pixel conversion the native core runs on its band threads, of the top
 * `height` rows of the pixels. `rgba` is straight RGBA; `premultipliedBgra` is
 * a bitmap host's paint. `frame` is a stored frame (`.wfrm`). */
export type MotifConversion =
  | { from: 'rgba'; to: 'frame' }
  | { from: 'premultipliedBgra'; to: 'frame' | 'rgba' }

/** Reads stored frames. */
export interface MotifFrameReader {
  /** Reads, verifies and downscales by `div`; the caller authorizes the path.
   * A `miss` rejection is about the file. */
  read(path: string, div: number): Promise<MotifReadPixels>
  close(): void
}

/** What a GPU pool is for. An `upload` pool reads stored frames through a
 * staging texture as large as its slot and is always RGBA; a `copy` pool holds
 * the slot alone. */
export type MotifPoolSpec =
  | { use: 'upload'; width: number; height: number }
  | { use: 'copy'; width: number; height: number; format: 'rgba' | 'bgra' }

/** One shared D3D11 texture and the worker that fills it. */
export interface MotifPool {
  /** The slot's NT handle, for `sharedTexture.importSharedTexture`. */
  handle(): Buffer
  /** Reads, verifies and downscales a stored frame by `div` into the slot; the
   * pool must have the scaled size. A `miss` rejection is about the file. */
  upload(path: string, div: number): Promise<MotifUploadTiming>
  /** Copies the top-left slot-sized picture of a shared texture; settles once
   * the GPU copy has run. */
  copy(handle: Buffer): Promise<void>
  close(): void
}

/** Pixels read back from a texture, held natively until `finish` encodes them
 * as a stored frame or a PNG. */
export interface MotifRawFrame { finish(to: 'frame' | 'png'): Promise<Buffer> }

/** Reads the top `height` rows of a shared texture: the picture above the
 * capture host's marker rows. */
export interface MotifTextureReader {
  read(handle: Buffer, height: number): Promise<MotifRawFrame>
  close(): void
}

/** Reads the first `pixels` of a shared texture's last row as RGBA. */
export interface MotifMarkerReader {
  read(handle: Buffer, pixels: number): Promise<Uint8Array>
  close(): void
}

/** The Windows shared-texture side of the core. Opening one creates a D3D11
 * device and its worker thread; a failure is a `device` MotifError. */
export interface MotifNativeGpu {
  openPool(spec: MotifPoolSpec): MotifPool
  openTextureReader(): MotifTextureReader
  openMarkerReader(): MotifMarkerReader
}

export interface MotifNative {
  convert(conversion: MotifConversion, pixels: Buffer, width: number, height: number): Promise<Buffer>
  openFrameReader(): MotifFrameReader
  /** Null off Windows, or when the addon has no D3D11 classes. */
  readonly gpu: MotifNativeGpu | null
}

/** The share of the tuning the core takes. */
export type MotifNativeTuning = Pick<ResolvedMotifTuning, 'scratchIdleBytes' | 'bandThreads'>

interface NativePool {
  handles(): Buffer[]
  uploadFile(path: string, slot: number, div?: number): Promise<MotifUploadTiming>
  copyTexture(handle: Buffer, slot: number): Promise<void>
  close(): void
}
interface NativeRawFrame { finish(): Promise<Buffer>; finishPng(): Promise<Buffer> }
interface NativeTextureEncoder { read(handle: Buffer, height: number): Promise<NativeRawFrame>; close(): void }
interface NativeMarkerReader { read(handle: Buffer, pixels: number): Promise<Buffer>; close(): void }

/** The addon's Motif exports, written by hand: the generated `index.d.ts` is
 * per platform and lacks the Windows classes elsewhere. */
interface NativeMotifCore {
  motifLimits(): unknown
  motifConfigure(config: { scratchIdleBytes: number; bandThreads: number }): void
  motifReadFrameScaled(path: string, div: number): Promise<MotifReadPixels>
  motifConvert(pixels: Buffer, width: number, height: number, from: MotifConversion['from'], to: MotifConversion['to']): Promise<Buffer>
  MotifGpuPool?: new (width: number, height: number, count: number, bgra: boolean, upload: boolean) => NativePool
  MotifTextureEncoder?: new () => NativeTextureEncoder
  MotifMarkerReader?: new () => NativeMarkerReader
}

const REQUIRED = [
  'motifLimits', 'motifConfigure', 'motifReadFrameScaled', 'motifConvert',
] as const satisfies readonly (keyof NativeMotifCore)[]
const GPU_CLASSES = ['MotifGpuPool', 'MotifTextureEncoder', 'MotifMarkerReader'] as const satisfies readonly (keyof NativeMotifCore)[]

/** A synchronous native call (a constructor, a getter); its throw comes back
 * decoded. */
function decoding<T>(call: () => T): T {
  try { return call() } catch (error) { throw decodeMotifError(error) }
}

const has = (core: object, name: string): boolean => typeof (core as Record<string, unknown>)[name] === 'function'

/** Checks the addon's Motif exports and limits, then gives it its share of
 * the tuning; a process calls it once, before its first frame read or write.
 *
 * LANDMINE: every call goes through `core` when it is made, never through a
 * reference taken here: e2e specs replace the addon's exports and prototype
 * methods to hold or count native work (motif-bake, motif-frame-reader). */
export function loadMotifNative(
  tuning: MotifNativeTuning,
  core: unknown = createRequire(import.meta.url)('@weftcut/core'),
  platform: NodeJS.Platform = process.platform,
): MotifNative {
  if (!core || typeof core !== 'object') throw new Error('The native core did not load: rebuild it')
  const missing = REQUIRED.filter(name => !has(core, name))
  if (missing.length) throw new Error(`The native core lacks ${missing.join(', ')}: rebuild it`)
  const native = core as NativeMotifCore
  assertMotifLimits(native.motifLimits())
  native.motifConfigure({ scratchIdleBytes: tuning.scratchIdleBytes, bandThreads: tuning.bandThreads })

  const gpu: MotifNativeGpu | null = platform === 'win32' && GPU_CLASSES.every(name => has(core, name)) ? {
    openPool: spec => {
      const pool = decoding(() => new native.MotifGpuPool!(spec.width, spec.height, 1,
        spec.use === 'copy' && spec.format === 'bgra', spec.use === 'upload'))
      return {
        handle: () => decoding(() => {
          const [handle] = pool.handles()
          if (!handle) throw new MotifError('device', 'Motif GPU pool has no slot')
          return handle
        }),
        upload: (path, div) => decodingMotifErrors(() => pool.uploadFile(path, 0, div)),
        copy: handle => decodingMotifErrors(() => pool.copyTexture(handle, 0)),
        close: () => decoding(() => pool.close()),
      }
    },
    openTextureReader: () => {
      const encoder = decoding(() => new native.MotifTextureEncoder!())
      return {
        read: (handle, height) => decodingMotifErrors(async () => {
          const raw = await encoder.read(handle, height)
          return { finish: to => decodingMotifErrors(() => to === 'png' ? raw.finishPng() : raw.finish()) }
        }),
        close: () => decoding(() => encoder.close()),
      }
    },
    openMarkerReader: () => {
      const reader = decoding(() => new native.MotifMarkerReader!())
      return {
        read: (handle, pixels) => decodingMotifErrors(() => reader.read(handle, pixels)),
        close: () => decoding(() => reader.close()),
      }
    },
  } : null

  return {
    convert: (conversion, pixels, width, height) =>
      decodingMotifErrors(() => native.motifConvert(pixels, width, height, conversion.from, conversion.to)),
    openFrameReader: () => ({
      read: (path, div) => decodingMotifErrors(() => native.motifReadFrameScaled(path, div)),
      close: () => {},
    }),
    gpu,
  }
}
