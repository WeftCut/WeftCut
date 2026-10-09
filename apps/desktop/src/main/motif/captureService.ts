import type { OffscreenSharedTexture, WebContents } from 'electron'
import type { CaptureArgs } from './capture'
import type { MotifFrameStore, FrameWriter } from './frameStore'
import type { MotifCacheAddress, MotifTextureFrame, StoredMotifFrame } from '../../shared/motifs/frameTransport'
import { CAPTURE_SUPERSEDED_MESSAGE } from '../../shared/motifs/captureErrors'
import { reserveResources } from '../resources'
import { isResourceCapacityError } from '../../shared/resource-policy'

export interface TextureEncoder { encode(handle: Buffer): Promise<Buffer>; close(): void }
export interface CaptureRequest extends CaptureArgs {
  coalesceKey?: string
  high?: boolean
  bake?: MotifCacheAddress
  /** Export pixels remain usable when optional cache persistence fails. */
  bakeOptional?: boolean
  finalizationToken?: string
}
export interface CaptureServiceDeps {
  store: MotifFrameStore
  texture: (args: CaptureArgs, consume: (texture: OffscreenSharedTexture) => Promise<StoredMotifFrame>, key?: string, high?: boolean, isCurrent?: () => boolean) => Promise<StoredMotifFrame>
  png: (args: CaptureArgs, key?: string, high?: boolean, isCurrent?: () => boolean) => Promise<string>
  copy: ((owner: WebContents, texture: OffscreenSharedTexture, finalizationId?: number) => Promise<MotifTextureFrame>) | null
  createEncoder: (() => TextureEncoder) | null
  setTextureEnabled: (enabled: boolean) => void
  isContentFailure: (args: CaptureArgs, error: unknown) => boolean
  promote?: (key: string) => void
}

interface DisplayJob {
  attach: (address: MotifCacheAddress) => boolean
  result: Promise<StoredMotifFrame>
}
interface PersistenceJob { address: MotifCacheAddress; result: Promise<void>; consumers: Set<() => boolean>; key?: string }
interface WorkspaceJobs {
  display: Map<string, DisplayJob>
  persist: Map<string, PersistenceJob>
}
class ReadbackUnavailable extends Error {}

// The store object is a workspace-session capability, not merely a directory.
// Two openings of the same project may reuse files, never pending receipts.
function captureIdentity(a: CaptureArgs): string {
  return JSON.stringify([a.motifId, a.contentHash, a.tSec, a.propsJson, a.width, a.height, a.settleRafs, a.fpsNum, a.fpsDen])
}
const sameAddress = (a: MotifCacheAddress, b: MotifCacheAddress) => a.hash === b.hash && a.frame === b.frame

/** Capture and optional bake share the one OSR lease. A readback failure keeps
 * the captured bitmap available for the PNG writer; disk failures remain errors. */
export class MotifCaptureService {
  private useTexture: boolean
  private encoder: TextureEncoder | null = null
  private encoderFailed = false
  private jobs = new Map<string, { attach: (address: MotifCacheAddress) => void }>()
  private readonly workspaceJobs = new WeakMap<MotifFrameStore, WorkspaceJobs>()
  constructor(private readonly deps: CaptureServiceDeps, enabled: boolean) {
    this.useTexture = enabled && !!(deps.copy || deps.createEncoder)
    deps.setTextureEnabled(this.useTexture)
  }

  private jobsFor(store: MotifFrameStore): WorkspaceJobs {
    let jobs = this.workspaceJobs.get(store)
    if (!jobs) { jobs = { display: new Map(), persist: new Map() }; this.workspaceJobs.set(store, jobs) }
    return jobs
  }

  async capture(owner: WebContents, request: CaptureRequest, isCurrent: () => boolean = () => true, finalizationId?: number, store = this.deps.store): Promise<StoredMotifFrame> {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    const jobs = this.jobsFor(store), identity = captureIdentity(request)
    const pending = jobs.persist.get(identity)
    if (pending && (!request.bake || sameAddress(pending.address, request.bake))) {
      const consumer = () => isCurrent()
      pending.consumers.add(consumer)
      if (pending.key && (request.high ?? request.coalesceKey !== undefined)) this.deps.promote?.(pending.key)
      try {
        await pending.result
        if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
        const stored = await store.read(pending.address.hash, pending.address.frame)
        if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
        if (stored) return { ...stored, persisted: true }
      } catch (error) {
        // Cancelling background interest cannot invalidate a still-current
        // display consumer. Real content/disk failures retain their meaning.
        if (!isCurrent() || (!String(error).includes(CAPTURE_SUPERSEDED_MESSAGE)
          && (!request.bakeOptional || this.deps.isContentFailure(request, error)))) throw error
      } finally { pending.consumers.delete(consumer) }
    }
    const job: DisplayJob = { attach: () => false, result: Promise.resolve(null as unknown as StoredMotifFrame) }
    job.result = this.captureDisplay(owner, request, isCurrent, finalizationId, store, attach => { job.attach = attach })
    jobs.display.set(identity, job)
    try { return await job.result }
    finally { if (jobs.display.get(identity) === job) jobs.display.delete(identity) }
  }

  /** A persistence-only consumer owns no renderer document or GPU transport
   * lease. Its bound store and current-session guard are supplied at admission. */
  async persist(request: CaptureRequest & { bake: MotifCacheAddress }, isCurrent: () => boolean = () => true, store = this.deps.store): Promise<void> {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    const jobs = this.jobsFor(store), identity = captureIdentity(request)
    const pending = jobs.persist.get(identity)
    const consumer = () => isCurrent()
    if (pending && sameAddress(pending.address, request.bake)) {
      pending.consumers.add(consumer)
      try {
        await pending.result
        if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
        return
      } finally { pending.consumers.delete(consumer) }
    }
    const consumers = new Set([consumer])
    const wanted = () => [...consumers].some(current => current())
    const display = jobs.display.get(identity)
    const joined = display?.attach(request.bake) ? display.result : undefined
    const result = (async () => {
      if (joined) {
        try { if ((await joined).persisted) return }
        catch (error) { if (!String(error).includes(CAPTURE_SUPERSEDED_MESSAGE)) throw error }
      }
      if (!wanted()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      await this.persistFrame(request, wanted, store)
    })()
    const job = { address: request.bake, result, consumers, key: request.coalesceKey }
    jobs.persist.set(identity, job)
    try {
      await result
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    } finally {
      consumers.delete(consumer)
      if (jobs.persist.get(identity) === job) jobs.persist.delete(identity)
    }
  }

  private async persistFrame(request: CaptureRequest & { bake: MotifCacheAddress }, isCurrent: () => boolean, store: MotifFrameStore): Promise<void> {
    const { coalesceKey, high, bake, bakeOptional: _optional, finalizationToken: _token, ...args } = request
    const releaseResources = reserveResources(0, 16 + request.width * request.height * 16 / 1048576)
    let writeFailed = false
    const write = async (bytes: Uint8Array, png: boolean) => {
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      try {
        const writer = await store.prepareWrite(bake.hash, bake.frame)
        if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
        if (!writer) throw new Error('Motif bake has no open workspace')
        if (png) await writer.png(bytes); else await writer.encoded(bytes)
      } catch (error) { writeFailed = true; throw error }
    }
    try {
      if (this.useTexture && !this.encoderFailed && this.deps.createEncoder) {
        try {
          await this.deps.texture(args, async texture => {
            if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
            let bytes: Buffer
            try { bytes = await this.encode(texture, args) }
            catch { throw new ReadbackUnavailable('Motif texture readback unavailable') }
            await write(bytes, false)
            // Internal receipt only; no pixels or texture lease leave main.
            return { kind: 'png', bytes: Buffer.alloc(0), persisted: true }
          }, coalesceKey, high, isCurrent)
          return
        } catch (error) {
          if (writeFailed || isResourceCapacityError(error) || String(error).includes(CAPTURE_SUPERSEDED_MESSAGE) || this.deps.isContentFailure(args, error)) throw error
          // Readback failure is independent from OSR/display transport. A PNG
          // retry needs no renderer and subsequent persistence skips readback.
          if (!(error instanceof ReadbackUnavailable)) {
            this.useTexture = false
            this.deps.setTextureEnabled(false)
          }
        }
      }
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      const bytes = Buffer.from(await this.deps.png(args, coalesceKey, high, isCurrent), 'base64')
      await write(bytes, true)
    } finally { releaseResources() }
  }

  private async encode(texture: OffscreenSharedTexture, args: CaptureArgs): Promise<Buffer> {
    try {
      const { codedSize, pixelFormat, handle } = texture.textureInfo
      if (codedSize.width !== args.width || codedSize.height !== args.height ||
          (pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle) throw new Error('Unsupported bake texture')
      this.encoder ??= this.deps.createEncoder!()
      return await this.encoder.encode(handle.ntHandle)
    } catch (error) {
      this.encoderFailed = true
      this.encoder?.close(); this.encoder = null
      throw error
    }
  }

  private async captureDisplay(owner: WebContents, request: CaptureRequest, isCurrent: () => boolean, finalizationId: number | undefined, store: MotifFrameStore, register: (attach: DisplayJob['attach']) => void): Promise<StoredMotifFrame> {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    const releaseResources = reserveResources(0, 16 + request.width * request.height * 16 / 1048576, finalizationId)
    const { coalesceKey, high, bake, bakeOptional, finalizationToken: _token, ...args } = request
    const key = coalesceKey === undefined ? undefined : `${owner.id}:${coalesceKey}`
    // Begin resolving the workspace now, without postponing capture admission:
    // control messages follow it on the same preload IPC sender.
    let writeFailed = false
    const optionalFailure = (error: unknown) => bakeOptional && !String(error).includes(CAPTURE_SUPERSEDED_MESSAGE)
      && !this.deps.isContentFailure(args, error)
    let destination: Promise<FrameWriter | null> | undefined
    let destinationAddress: MotifCacheAddress | undefined
    let acceptingBake = true
    const job = { attach: (address: MotifCacheAddress) => {
      if (!acceptingBake) return false
      if (destination) return !!destinationAddress && sameAddress(destinationAddress, address)
      destinationAddress = address
      destination = store.prepareWrite(address.hash, address.frame)
        .catch(error => {
          if (optionalFailure(error)) return null
          writeFailed = true; throw error
        })
      void destination.catch(() => {})
      return true
    } }
    register(job.attach)
    if (bake) job.attach(bake)
    if (key) this.jobs.set(key, job)
    const write = async (writer: FrameWriter | null, bytes: Uint8Array, png: boolean): Promise<boolean> => {
      if (!writer) {
        if (bakeOptional) return false
        writeFailed = true; throw new Error('Motif bake has no open workspace')
      }
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      try { if (png) await writer.png(bytes); else await writer.encoded(bytes) }
      catch (error) {
        if (optionalFailure(error)) return false
        writeFailed = true; throw error
      }
      return true
    }
    try {
      if (this.useTexture && this.deps.copy) {
        try {
          return await this.deps.texture(args, async texture => {
            let persisted = false
            acceptingBake = false
            if (destination) {
              const writer = await destination
              let bytes: Buffer | undefined
              if (writer && !this.encoderFailed && this.deps.createEncoder) {
                try {
                  bytes = await this.encode(texture, args)
                } catch {
                  // No recapture: deliver this frame and let the compatibility
                  // PNG writer persist it. Subsequent frames skip failed readback.
                }
              }
              if (bytes) persisted = await write(writer, bytes, false)
            }
            // Capture/encoding can finish after a document reload. Such work
            // cannot lease a texture to the new preload on the same WebContents.
            if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
            return { ...await this.deps.copy!(owner, texture, finalizationId), persisted }
          }, key, high, isCurrent)
        } catch (error) {
          if (writeFailed || isResourceCapacityError(error) || String(error).includes(CAPTURE_SUPERSEDED_MESSAGE) || this.deps.isContentFailure(args, error)) throw error
          this.useTexture = false
          this.deps.setTextureEnabled(false)
        }
      }
      const bytes = Buffer.from(await this.deps.png(args, key, high, isCurrent), 'base64')
      acceptingBake = false
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      const persisted = destination ? await write(await destination, bytes, true) : false
      return { kind: 'png', bytes, persisted }
    } finally {
      releaseResources()
      acceptingBake = false
      if (key && this.jobs.get(key) === job) this.jobs.delete(key)
    }
  }

  requestBake(ownerId: number, key: string, address: MotifCacheAddress): void {
    this.jobs.get(`${ownerId}:${key}`)?.attach(address)
  }

  dispose(): void { this.encoder?.close(); this.encoder = null }
}
