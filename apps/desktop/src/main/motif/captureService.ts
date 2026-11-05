import type { OffscreenSharedTexture, WebContents } from 'electron'
import type { CaptureArgs } from './capture'
import type { MotifFrameStore, FrameWriter } from './frameStore'
import type { MotifCacheAddress, MotifTextureFrame, StoredMotifFrame } from '../../shared/motifs/frameTransport'
import { CAPTURE_SUPERSEDED_MESSAGE, MotifCaptureTimeoutError } from '../../shared/motifs/captureErrors'
import { backgroundResourcePause, reserveResources } from '../resources'
import { isResourceCapacityError } from '../../shared/resource-policy'
import { MotifFrameWriteQueue, type FrameRead, type QueuedWrite } from './frameWriteQueue'

/** Pixels read back from a texture, held natively until `finish` encodes them. */
export interface RawMotifFrame { finish(): Promise<Buffer> }
export interface TextureEncoder { read(handle: Buffer): Promise<RawMotifFrame>; close(): void }
export interface CaptureRequest extends CaptureArgs {
  coalesceKey?: string
  high?: boolean
  bake?: MotifCacheAddress
  /** Committed display address to recheck after renderer-side cache misses. */
  cache?: MotifCacheAddress
  finalizationToken?: string
}
export interface CaptureServiceDeps {
  store: MotifFrameStore
  texture: <T>(args: CaptureArgs, consume: (texture: OffscreenSharedTexture) => Promise<T>, key?: string, high?: boolean, isCurrent?: () => boolean) => Promise<T>
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
/** Main never reads stored pixels on the capture path (ADR 0154). */
const storedFrame = (): StoredMotifFrame => ({ kind: 'stored', persisted: true })

/** A capture reads its pixels inside the OSR lease and stores them through
 * `MotifFrameWriteQueue`, after the lease (ADR 0158). A failed write costs the
 * cache, never the pixels a display already has. A readback failure keeps the
 * captured bitmap available for the PNG writer. */
export class MotifCaptureService {
  private useTexture: boolean
  private encoder: TextureEncoder | null = null
  private encoderFailed = false
  private liveWriteWarned = false
  private readonly writes = new MotifFrameWriteQueue()
  private readonly workspaceJobs = new WeakMap<MotifFrameStore, WorkspaceJobs>()
  constructor(private readonly deps: CaptureServiceDeps, enabled: boolean) {
    this.useTexture = enabled && !!(deps.copy || deps.createEncoder)
    deps.setTextureEnabled(this.useTexture)
  }

  /** Only a failure of the shared-texture output itself may switch the session
   * to PNG. A disk write, a resource refusal, a superseded request, the Motif's
   * own script and a hung host all happened before or beside that output: a
   * PNG retry would not fix them, and the downgrade would cost every later
   * frame its GPU path. */
  private keepsTexturePath(args: CaptureArgs, error: unknown, writeFailed = false): boolean {
    return writeFailed || isResourceCapacityError(error) || String(error).includes(CAPTURE_SUPERSEDED_MESSAGE)
      || error instanceof MotifCaptureTimeoutError || this.deps.isContentFailure(args, error)
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
        // Persisted: the renderer reads it through its reader (ADR 0154).
        return storedFrame()
      } catch (error) {
        // Neither cancelled background interest nor a failed write invalidates
        // a still-current display: it captures its own pixels. A Motif's own
        // failure would fail that capture too.
        if (!isCurrent() || this.deps.isContentFailure(request, error)) throw error
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
      // A display's write that outlived its lease needs no second capture.
      const writing = this.writes.inFlight(store, request.bake)
      if (writing && await writing.then(() => true, () => false)) return
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
    const { coalesceKey, high, bake, cache: _cache, finalizationToken: _token, ...args } = request
    const releaseResources = reserveResources(0, 16 + request.width * request.height * 16 / 1048576)
    let writeFailed = false
    const prepare = async () => {
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      try {
        const writer = await store.prepareWrite(bake.hash, bake.frame)
        if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
        if (!writer) throw new Error('Motif bake has no open workspace')
        return writer
      } catch (error) { writeFailed = true; throw error }
    }
    try {
      if (this.canReadTexture()) {
        let queued: QueuedWrite | undefined
        try {
          queued = await this.deps.texture(args, async texture => {
            const writer = await prepare()
            try { return await this.writes.offer(store, bake, 'wait', this.textureRead(texture, args, writer)) }
            catch { throw new ReadbackUnavailable('Motif texture readback unavailable') }
          }, coalesceKey, high, isCurrent)
        } catch (error) {
          if (this.keepsTexturePath(args, error, writeFailed)) throw error
          // Readback failure is independent from OSR/display transport. A PNG
          // retry needs no renderer and subsequent persistence skips readback.
          if (!(error instanceof ReadbackUnavailable)) {
            console.warn('[weftcut/motif] Shared-texture capture failed; using PNG fallback:', error)
            this.useTexture = false
            this.deps.setTextureEnabled(false)
          }
        }
        if (queued) { await queued.written; return }
      }
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      const bytes = Buffer.from(await this.deps.png(args, coalesceKey, high, isCurrent), 'base64')
      const writer = await prepare()
      await (await this.writes.offer(store, bake, 'wait', async () => () => writer.png(bytes))).written
    } finally { releaseResources() }
  }

  private canReadTexture(): boolean {
    return this.useTexture && !this.encoderFailed && !!this.deps.createEncoder
  }

  private async readTexture(texture: OffscreenSharedTexture, args: CaptureArgs): Promise<RawMotifFrame> {
    try {
      const { codedSize, pixelFormat, handle } = texture.textureInfo
      if (codedSize.width !== args.width || codedSize.height !== args.height ||
          (pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle) throw new Error('Unsupported bake texture')
      this.encoder ??= this.deps.createEncoder!()
      return await this.encoder.read(handle.ntHandle)
    } catch (error) {
      this.encoderFailed = true
      this.encoder?.close(); this.encoder = null
      throw error
    }
  }

  private textureRead(texture: OffscreenSharedTexture, args: CaptureArgs, writer: FrameWriter): FrameRead {
    return async () => {
      const raw = await this.readTexture(texture, args)
      return async () => writer.encoded(await raw.finish())
    }
  }

  /** The address a display's capture stores itself at when nobody asked it to.
   * It can be captured again, so memory pressure or a full cache simply skips. */
  private liveWriteAddress(request: CaptureRequest, store: MotifFrameStore): MotifCacheAddress | null {
    const address = request.cache
    if (!address || !this.canReadTexture() || backgroundResourcePause() === 'memory') return null
    return store.hasRoom(address.hash, address.frame) ? address : null
  }

  /** Pixels in flight are charged to the write, which outlives the capture. */
  private liveRead(texture: OffscreenSharedTexture, args: CaptureArgs, address: MotifCacheAddress, store: MotifFrameStore): FrameRead {
    return async () => {
      const release = reserveResources(0, args.width * args.height * 8 / 1048576)
      try {
        const writer = await store.prepareWrite(address.hash, address.frame)
        if (!writer) throw new Error('Motif frame has no open workspace')
        const encodeAndStore = await this.textureRead(texture, args, writer)()
        return () => encodeAndStore().finally(release)
      } catch (error) { release(); throw error }
    }
  }

  private warnLiveWrite(error: unknown): void {
    if (this.liveWriteWarned || isResourceCapacityError(error) || String(error).includes(CAPTURE_SUPERSEDED_MESSAGE)) return
    this.liveWriteWarned = true
    console.warn('[weftcut/motif] Live capture not stored:', error)
  }

  private async captureDisplay(owner: WebContents, request: CaptureRequest, isCurrent: () => boolean, finalizationId: number | undefined, store: MotifFrameStore, register: (attach: DisplayJob['attach']) => void): Promise<StoredMotifFrame> {
    if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
    const releaseResources = reserveResources(0, 16 + request.width * request.height * 16 / 1048576, finalizationId)
    const { coalesceKey, high, bake, cache, finalizationToken: _token, ...args } = request
    const key = coalesceKey === undefined ? undefined : `${owner.id}:${coalesceKey}`
    // Begin resolving the workspace now, without postponing capture admission:
    // control messages follow it on the same preload IPC sender.
    let kept: { address: MotifCacheAddress; writer: Promise<FrameWriter | null> } | undefined
    let acceptingBake = true
    const attach = (address: MotifCacheAddress) => {
      if (!acceptingBake) return false
      if (kept) return sameAddress(kept.address, address)
      kept = { address, writer: store.prepareWrite(address.hash, address.frame).catch(() => null) }
      return true
    }
    register(attach)
    if (bake) attach(bake)
    // A kept frame reports whether its file exists, so a joined baker and the
    // export's PNG fallback can act on it. A failed write costs only the cache.
    const persisted = async (queued: QueuedWrite | null) => {
      if (!queued) return false
      try { await queued.written; return true }
      catch { return false }
    }
    try {
      if (cache && (!bake || sameAddress(cache, bake))) {
        await this.writes.inFlight(store, cache)?.catch(() => {})
        // A background write may finish after the renderer's disk miss, with
        // no pending receipt left to join. Register this display job BEFORE
        // checking so any new persistence demand can join the same producer.
        // Stat-only (docs/motifs.md#preparation-l2-baking); the renderer's
        // reader reads and verifies it, and an unreadable entry captures live
        // as before.
        const stored = await store.has(cache.hash, cache.frame).catch(() => false)
        if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
        if (stored && (!kept || sameAddress(cache, kept.address))) return storedFrame()
      }
      if (this.useTexture && this.deps.copy) {
        const copy = this.deps.copy
        try {
          const { frame, queued } = await this.deps.texture(args, async texture => {
            acceptingBake = false
            if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
            const queued = await this.offerDisplayFrame(texture, request, args, kept, store)
            // Capture/encoding can finish after a document reload. Such work
            // cannot lease a texture to the new preload on the same WebContents.
            if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
            return { frame: await copy(owner, texture, finalizationId), queued }
          }, key, high, isCurrent)
          return { ...frame, persisted: kept ? await persisted(queued) : false }
        } catch (error) {
          if (this.keepsTexturePath(args, error)) throw error
          console.warn('[weftcut/motif] Shared-texture capture failed; using PNG fallback:', error)
          this.useTexture = false
          this.deps.setTextureEnabled(false)
        }
      }
      const bytes = Buffer.from(await this.deps.png(args, key, high, isCurrent), 'base64')
      acceptingBake = false
      if (!isCurrent()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE)
      const writer = await kept?.writer
      const queued = writer ? await this.writes.offer(store, kept!.address, 'wait', async () => () => writer.png(bytes)) : null
      return { kind: 'png', bytes, persisted: await persisted(queued) }
    } finally {
      releaseResources()
      acceptingBake = false
    }
  }

  /** Inside the lease. A frame nobody can store is still delivered: no failure
   * here reaches the display. */
  private async offerDisplayFrame(texture: OffscreenSharedTexture, request: CaptureRequest, args: CaptureArgs, kept: { address: MotifCacheAddress; writer: Promise<FrameWriter | null> } | undefined, store: MotifFrameStore): Promise<QueuedWrite | null> {
    try {
      if (kept) {
        const writer = await kept.writer
        if (!writer || !this.canReadTexture()) return null
        return await this.writes.offer(store, kept.address, 'wait', this.textureRead(texture, args, writer))
      }
      const address = this.liveWriteAddress(request, store)
      if (!address) return null
      const queued = await this.writes.offer(store, address, 'skip', this.liveRead(texture, args, address, store))
      queued?.written.catch(error => this.warnLiveWrite(error))
      return queued
    } catch (error) {
      if (!kept) this.warnLiveWrite(error)
      return null
    }
  }

  dispose(): void { this.encoder?.close(); this.encoder = null }
}
