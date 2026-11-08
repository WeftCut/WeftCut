import type { WebContents } from 'electron'
import type { MotifOsrFrame } from './offscreenFrames.js'
import type { CaptureArgs, CaptureOptions, CaptureRun } from './capture'
import type { MotifFrameStore, FrameWriter } from './frameStore'
import type { MotifCacheAddress, MotifCaptureControl, MotifCaptureReply, MotifCaptureRequest, MotifFramePriority, MotifTextureFrame } from '../../shared/motifs/frameTransport'
import { MotifError, motifErrorCode } from '../../shared/motifs/errors'
import { isMotifFrameAddress } from './frameAddress'
import { MotifFrameWriteQueue, type FrameRead } from './frameWriteQueue'
import { failsTexturePath, MotifFrameJobs, type FrameJobHandle, type FrameJobSession, type PersistSubscriber } from './frameJobs'

/** Pixels read back from a texture, held natively until `finish` encodes them
 * as a stored frame or `finishPng` as a PNG. */
export interface RawMotifFrame { finish(): Promise<Buffer>; finishPng(): Promise<Buffer> }
/** Reads the top `height` rows of a shared texture: the picture above the
 * capture host's marker rows. */
export interface TextureEncoder { read(handle: Buffer, height: number): Promise<RawMotifFrame>; close(): void }
/** Native conversions of a bitmap host's paint. */
export interface MotifPixelCodec {
  /** The top `height` rows of premultiplied BGRA rows `width` pixels wide, as
   * straight RGBA. */
  motifStraightenBgra(bgra: Buffer, width: number, height: number): Promise<Buffer>
  /** Straight RGBA as a stored frame. */
  motifEncodeRgba(rgba: Buffer, width: number, height: number): Promise<Buffer>
  /** The top `height` rows of premultiplied BGRA rows `width` pixels wide, as
   * a stored frame. */
  motifEncodeBgra(bgra: Buffer, width: number, height: number): Promise<Buffer>
}
type TextureOsrFrame = Extract<MotifOsrFrame, { kind: 'texture' }>
type BitmapOsrFrame = Extract<MotifOsrFrame, { kind: 'bitmap' }>
export interface CaptureServiceDeps {
  store: MotifFrameStore
  /** `captureMotifFrame`. */
  frame: <T>(args: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, options: CaptureOptions) => CaptureRun<T>
  copy: ((owner: WebContents, frame: TextureOsrFrame, finalizationId?: number) => Promise<MotifTextureFrame>) | null
  createEncoder: (() => TextureEncoder) | null
  pixels: MotifPixelCodec
  setTextureEnabled: (enabled: boolean) => void
  /** `writeSlots` (`shared/motifs/tuning.ts`). */
  writeSlots: number
}

const PRIORITIES: readonly MotifFramePriority[] = ['current', 'ahead', 'background']
const isPriority = (value: unknown): value is MotifFramePriority => PRIORITIES.includes(value as MotifFramePriority)
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** A `motif:capture` payload from a renderer, or a thrown error. */
export function parseMotifCaptureRequest(value: unknown): MotifCaptureRequest {
  const r = (value ?? {}) as Record<string, unknown>
  const address = r.address as MotifCacheAddress | undefined
  if (!isCount(r.requestId) || !isPriority(r.priority)
    || typeof r.motifId !== 'string' || typeof r.propsJson !== 'string' || typeof r.contentHash !== 'string'
    || typeof r.tSec !== 'number' || !Number.isFinite(r.tSec)
    || !Number.isSafeInteger(r.width) || (r.width as number) < 1 || !Number.isSafeInteger(r.height) || (r.height as number) < 1
    || !optional(r.fpsNum, v => typeof v === 'number') || !optional(r.fpsDen, v => typeof v === 'number')
    || !optional(address, () => isMotifFrameAddress(address!.hash, address!.frame))
    || !optional(r.store, v => v === 'keep' || v === 'offer') || !optional(r.afterMiss, v => typeof v === 'boolean')
    || !optional(r.finalizationToken, v => typeof v === 'string')) throw new Error('Invalid Motif capture request')
  return {
    requestId: r.requestId as number, priority: r.priority,
    motifId: r.motifId, tSec: r.tSec, propsJson: r.propsJson, width: r.width as number, height: r.height as number, contentHash: r.contentHash,
    ...(r.fpsNum !== undefined ? { fpsNum: r.fpsNum as number } : {}),
    ...(r.fpsDen !== undefined ? { fpsDen: r.fpsDen as number } : {}),
    ...(address ? { address: { hash: address.hash, frame: address.frame } } : {}),
    ...(r.store !== undefined ? { store: r.store as 'keep' | 'offer' } : {}),
    ...(r.afterMiss !== undefined ? { afterMiss: r.afterMiss as boolean } : {}),
    ...(r.finalizationToken !== undefined ? { finalizationToken: r.finalizationToken as string } : {}),
  }
}

/** A `motif:capture-control` payload, or null when it is not one. */
export function parseMotifCaptureControl(value: unknown): MotifCaptureControl | null {
  const c = (value ?? {}) as Record<string, unknown>
  if (!isCount(c.requestId)) return null
  const requestId = c.requestId as number
  if (c.action === 'cancel') return { requestId, action: 'cancel' }
  if (c.action === 'priority' && isPriority(c.priority)) return { requestId, action: 'priority', priority: c.priority }
  return null
}

/** The capture session: a capture reads its pixels inside the OSR lease and
 * stores them through `MotifFrameWriteQueue`, after the lease (ADR 0158). A
 * shared texture goes to a display by GPU copy; a bitmap goes as straight RGBA
 * (ADR 0159). Requests with a cache address share one job per address and
 * workspace store (`MotifFrameJobs`, ADR 0160). */
export class MotifCaptureService {
  private useTexture: boolean
  private encoder: TextureEncoder | null = null
  private liveWriteWarned = false
  private readonly session: FrameJobSession
  private readonly workspaceJobs = new WeakMap<MotifFrameStore, MotifFrameJobs>()
  /** Requests in flight by `${sender id}:${requestId}`, for their controls. */
  private readonly requests = new Map<string, FrameJobHandle>()

  constructor(private readonly deps: CaptureServiceDeps, enabled: boolean) {
    this.useTexture = enabled && !!deps.copy && !!deps.createEncoder
    deps.setTextureEnabled(this.useTexture)
    this.session = {
      capture: (args, consume, options) => deps.frame(args, consume, options),
      textures: () => this.useTexture,
      useBitmaps: reason => this.useBitmaps(reason),
      copy: (owner, frame, finalizationId) => {
        if (!deps.copy) return Promise.reject(new MotifError('device', 'Motif texture capture without a GPU transport'))
        return deps.copy(owner, frame, finalizationId)
      },
      straighten: frame => this.straighten(frame),
      read: (frame, args, writer, rgba) => this.frameRead(frame, args, writer, rgba),
      writes: new MotifFrameWriteQueue(deps.writeSlots),
      liveWriteFailed: error => this.warnLiveWrite(error),
    }
  }

  private useBitmaps(reason: unknown): void {
    if (!this.useTexture) return
    console.warn('[weftcut/motif] Shared-texture capture failed; using bitmap capture:', reason)
    this.useTexture = false
    this.encoder?.close(); this.encoder = null
    this.deps.setTextureEnabled(false)
  }

  // The store object is a workspace-session capability, not merely a
  // directory: two openings of the same project may reuse files, never jobs.
  private jobsFor(store: MotifFrameStore): MotifFrameJobs {
    let jobs = this.workspaceJobs.get(store)
    if (!jobs) { jobs = new MotifFrameJobs(store, this.session); this.workspaceJobs.set(store, jobs) }
    return jobs
  }

  /** `motif:capture`. Registered before it returns, so a control that follows
   * the request on the same sender finds it. A withdrawn request resolves
   * `superseded` instead of rejecting (`MotifCaptureReply`). */
  capture(owner: WebContents, request: MotifCaptureRequest, isCurrent: () => boolean = () => true, finalizationId?: number, store = this.deps.store): Promise<MotifCaptureReply> {
    const { requestId, priority, address, store: storeMode, afterMiss, finalizationToken: _token, ...args } = request
    const { result, handle } = this.jobsFor(store).display(address, args,
      { owner, priority, isCurrent, finalizationId, keep: storeMode === 'keep' }, afterMiss === true)
    // A reloaded document numbers its requests from 1 again on the same
    // WebContents: its request takes the entry over, and the old request's
    // settle must not remove it.
    const key = `${owner.id}:${requestId}`
    this.requests.set(key, handle)
    const forget = () => { if (this.requests.get(key) === handle) this.requests.delete(key) }
    result.then(forget, forget)
    return result.catch((error: unknown) => {
      if (motifErrorCode(error) === 'superseded') return { kind: 'superseded' } as const
      throw error
    })
  }

  /** `motif:capture-control`. A settled request has nothing to control: the
   * renderer drops whatever still arrives for it. */
  control(ownerId: number, control: MotifCaptureControl): void {
    const handle = this.requests.get(`${ownerId}:${control.requestId}`)
    if (!handle) return
    if (control.action === 'cancel') handle.cancel()
    else handle.setPriority(control.priority)
  }

  /** A persistence-only request owns no renderer document or GPU transport
   * lease. Its bound store and current-session guard are supplied at admission. */
  persist(address: MotifCacheAddress, args: CaptureArgs, subscriber: PersistSubscriber, store = this.deps.store): Promise<void> {
    return this.jobsFor(store).persist(address, args, subscriber).result
  }

  /** Every texture-output failure here switches the session to bitmaps before
   * it rejects: persistence captures the frame again on it, and that capture
   * must be a bitmap or it fails here again, without end. A display still
   * shows this frame. */
  private async readTexture(frame: TextureOsrFrame, args: CaptureArgs): Promise<RawMotifFrame> {
    try {
      const { pixelFormat, handle } = frame.texture.textureInfo
      if (frame.width !== args.width || frame.height !== args.height ||
          (pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle || !this.deps.createEncoder) throw new MotifError('device', 'Unsupported bake texture')
      // A texture leased before the switch: an encoder opened now would outlive
      // the switch's close, so the frame is captured again as a bitmap instead.
      if (!this.useTexture) throw new MotifError('device', 'Motif capture switched to bitmaps')
      this.encoder ??= this.deps.createEncoder()
      return await this.encoder.read(handle.ntHandle, frame.height)
    } catch (error) {
      if (failsTexturePath(error)) this.useBitmaps(error)
      throw error
    }
  }

  private straighten(frame: BitmapOsrFrame): Promise<Buffer> {
    return this.deps.pixels.motifStraightenBgra(frame.image.toBitmap(), frame.width, frame.height)
  }

  /** Only the copy happens in the lease: a paint nobody straightened yet is
   * straightened on the threads that encode it. */
  private frameRead(frame: MotifOsrFrame, args: CaptureArgs, writer: FrameWriter, rgba?: Buffer): FrameRead {
    if (frame.kind === 'texture') return async () => {
      const raw = await this.readTexture(frame, args)
      return async () => writer.encoded(await raw.finish())
    }
    if (rgba) return async () => async () => writer.encoded(await this.deps.pixels.motifEncodeRgba(rgba, frame.width, frame.height))
    return async () => {
      const bgra = frame.image.toBitmap()
      return async () => writer.encoded(await this.deps.pixels.motifEncodeBgra(bgra, frame.width, frame.height))
    }
  }

  private warnLiveWrite(error: unknown): void {
    const code = motifErrorCode(error)
    if (this.liveWriteWarned || code === 'capacity' || code === 'superseded') return
    this.liveWriteWarned = true
    console.warn('[weftcut/motif] Live capture not stored:', error)
  }

  dispose(): void { this.encoder?.close(); this.encoder = null }
}
