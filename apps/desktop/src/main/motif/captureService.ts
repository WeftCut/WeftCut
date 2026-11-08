import type { WebContents } from 'electron'
import type { MotifOsrFrame } from './offscreenFrames.js'
import type { CaptureArgs } from './capture'
import type { MotifFrameStore, FrameWriter } from './frameStore'
import type { MotifCacheAddress, MotifTextureFrame, StoredMotifFrame } from '../../shared/motifs/frameTransport'
import { asMotifCapacity, MotifError, motifErrorCode, motifSuperseded } from '../../shared/motifs/errors'
import { backgroundResourcePause, reserveResources } from '../resources'
import { MotifFrameWriteQueue, type FrameRead, type QueuedWrite } from './frameWriteQueue'

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
export interface CaptureRequest extends CaptureArgs {
  coalesceKey?: string
  high?: boolean
  bake?: MotifCacheAddress
  /** Committed display address to recheck after renderer-side cache misses. */
  cache?: MotifCacheAddress
  finalizationToken?: string
}
type TextureOsrFrame = Extract<MotifOsrFrame, { kind: 'texture' }>
type BitmapOsrFrame = Extract<MotifOsrFrame, { kind: 'bitmap' }>
export interface CaptureServiceDeps {
  store: MotifFrameStore
  frame: <T>(args: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, key?: string, high?: boolean, isCurrent?: () => boolean) => Promise<T>
  copy: ((owner: WebContents, frame: TextureOsrFrame, finalizationId?: number) => Promise<MotifTextureFrame>) | null
  createEncoder: (() => TextureEncoder) | null
  pixels: MotifPixelCodec
  setTextureEnabled: (enabled: boolean) => void
  promote?: (key: string) => void
  /** `writeSlots` (`shared/motifs/tuning.ts`). */
  writeSlots: number
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

// The store object is a workspace-session capability, not merely a directory.
// Two openings of the same project may reuse files, never pending receipts.
function captureIdentity(a: CaptureArgs): string {
  return JSON.stringify([a.motifId, a.contentHash, a.tSec, a.propsJson, a.width, a.height, a.fpsNum, a.fpsDen])
}
const sameAddress = (a: MotifCacheAddress, b: MotifCacheAddress) => a.hash === b.hash && a.frame === b.frame
/** Main never reads stored pixels on the capture path (ADR 0154). */
const storedFrame = (): StoredMotifFrame => ({ kind: 'stored', persisted: true })

/** `reserveResources`, its refusal coded `capacity`. */
function reserve(...args: Parameters<typeof reserveResources>): () => void {
  try { return reserveResources(...args) } catch (error) { throw asMotifCapacity(error) }
}

/** Only a `device` failure, or an uncoded one, which comes from the
 * shared-texture output itself (its lease, GPU copy or readback), switches the
 * session to bitmaps. Every coded failure (a disk write, a resource refusal, a
 * superseded request, the Motif's own script, a hung host, a held mutex)
 * happened before or beside that output: a bitmap retry would not fix it, and
 * the switch would cost every later frame its GPU path. */
function failsTexturePath(error: unknown): boolean {
  const code = motifErrorCode(error)
  return code === undefined || code === 'device'
}

/** A capture reads its pixels inside the OSR lease and stores them through
 * `MotifFrameWriteQueue`, after the lease (ADR 0158). A failed write costs the
 * cache, never the pixels a display already has. A shared texture goes to the
 * display by GPU copy; a bitmap goes as straight RGBA (ADR 0159). */
export class MotifCaptureService {
  private useTexture: boolean
  private encoder: TextureEncoder | null = null
  private liveWriteWarned = false
  private readonly writes: MotifFrameWriteQueue
  private readonly workspaceJobs = new WeakMap<MotifFrameStore, WorkspaceJobs>()
  constructor(private readonly deps: CaptureServiceDeps, enabled: boolean) {
    this.writes = new MotifFrameWriteQueue(deps.writeSlots)
    this.useTexture = enabled && !!deps.copy && !!deps.createEncoder
    deps.setTextureEnabled(this.useTexture)
  }

  /** Runs `capture`; a failure of the shared-texture output moves the session
   * to the bitmap host, which captures the same frame again. A failed write
   * never does. */
  private async withFallback<T>(capture: () => Promise<T>, writeFailed: () => boolean = () => false): Promise<T> {
    for (;;) {
      const texture = this.useTexture
      try { return await capture() }
      catch (error) {
        if (!texture || writeFailed() || !failsTexturePath(error)) throw error
        this.useBitmaps(error)
      }
    }
  }

  private useBitmaps(reason: unknown): void {
    if (!this.useTexture) return
    console.warn('[weftcut/motif] Shared-texture capture failed; using bitmap capture:', reason)
    this.useTexture = false
    this.encoder?.close(); this.encoder = null
    this.deps.setTextureEnabled(false)
  }

  private jobsFor(store: MotifFrameStore): WorkspaceJobs {
    let jobs = this.workspaceJobs.get(store)
    if (!jobs) { jobs = { display: new Map(), persist: new Map() }; this.workspaceJobs.set(store, jobs) }
    return jobs
  }

  async capture(owner: WebContents, request: CaptureRequest, isCurrent: () => boolean = () => true, finalizationId?: number, store = this.deps.store): Promise<StoredMotifFrame> {
    if (!isCurrent()) throw motifSuperseded()
    const jobs = this.jobsFor(store), identity = captureIdentity(request)
    const pending = jobs.persist.get(identity)
    if (pending && (!request.bake || sameAddress(pending.address, request.bake))) {
      const consumer = () => isCurrent()
      pending.consumers.add(consumer)
      if (pending.key && (request.high ?? request.coalesceKey !== undefined)) this.deps.promote?.(pending.key)
      try {
        await pending.result
        if (!isCurrent()) throw motifSuperseded()
        // Persisted: the renderer reads it through its reader (ADR 0154).
        return storedFrame()
      } catch (error) {
        // Neither cancelled background interest nor a failed write invalidates
        // a still-current display: it captures its own pixels. A Motif's own
        // failure would fail that capture too.
        if (!isCurrent() || motifErrorCode(error) === 'content') throw error
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
    if (!isCurrent()) throw motifSuperseded()
    const jobs = this.jobsFor(store), identity = captureIdentity(request)
    const pending = jobs.persist.get(identity)
    const consumer = () => isCurrent()
    if (pending && sameAddress(pending.address, request.bake)) {
      pending.consumers.add(consumer)
      try {
        await pending.result
        if (!isCurrent()) throw motifSuperseded()
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
        catch (error) { if (motifErrorCode(error) !== 'superseded') throw error }
      }
      if (!wanted()) throw motifSuperseded()
      // A display's write that outlived its lease needs no second capture.
      const writing = this.writes.inFlight(store, request.bake)
      if (writing && await writing.then(() => true, () => false)) return
      await this.persistFrame(request, wanted, store)
    })()
    const job = { address: request.bake, result, consumers, key: request.coalesceKey }
    jobs.persist.set(identity, job)
    try {
      await result
      if (!isCurrent()) throw motifSuperseded()
    } finally {
      consumers.delete(consumer)
      if (jobs.persist.get(identity) === job) jobs.persist.delete(identity)
    }
  }

  private async persistFrame(request: CaptureRequest & { bake: MotifCacheAddress }, isCurrent: () => boolean, store: MotifFrameStore): Promise<void> {
    const { coalesceKey, high, bake, cache: _cache, finalizationToken: _token, ...args } = request
    const releaseResources = reserve(0, 16 + request.width * request.height * 16 / 1048576)
    let writeFailed = false
    const prepare = async () => {
      if (!isCurrent()) throw motifSuperseded()
      try {
        const writer = await store.prepareWrite(bake.hash, bake.frame)
        if (!isCurrent()) throw motifSuperseded()
        if (!writer) throw new MotifError('closed', 'Motif bake has no open workspace')
        return writer
      } catch (error) { writeFailed = true; throw error }
    }
    try {
      const queued = await this.withFallback(() => this.deps.frame(args, async frame => {
        const writer = await prepare()
        return this.writes.offer(store, bake, 'wait', this.frameRead(frame, args, writer))
      }, coalesceKey, high, isCurrent), () => writeFailed)
      await queued.written
    } finally { releaseResources() }
  }

  private async readTexture(frame: TextureOsrFrame, args: CaptureArgs): Promise<RawMotifFrame> {
    const { pixelFormat, handle } = frame.texture.textureInfo
    if (frame.width !== args.width || frame.height !== args.height ||
        (pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle || !this.deps.createEncoder) throw new MotifError('device', 'Unsupported bake texture')
    this.encoder ??= this.deps.createEncoder()
    try { return await this.encoder.read(handle.ntHandle, frame.height) }
    catch (error) {
      // The session can no longer store textures; later frames are bitmaps.
      // A display still shows this one.
      if (failsTexturePath(error)) this.useBitmaps(error)
      throw error
    }
  }

  /** A bitmap's picture as straight RGBA. */
  private straighten(frame: BitmapOsrFrame): Promise<Buffer> {
    return this.deps.pixels.motifStraightenBgra(frame.image.toBitmap(), frame.width, frame.height)
  }

  /** Reads the frame's pixels; the returned step encodes and stores them.
   * `rgba` is a bitmap's picture when the display already straightened it.
   * Otherwise only the copy happens in the lease: the paint straightens on
   * the threads that encode it. */
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

  /** The address a display's capture stores itself at when nobody asked it to.
   * It can be captured again, so memory pressure or a full cache simply skips. */
  private liveWriteAddress(request: CaptureRequest, store: MotifFrameStore): MotifCacheAddress | null {
    const address = request.cache
    if (!address || backgroundResourcePause() === 'memory') return null
    return store.hasRoom(address.hash, address.frame) ? address : null
  }

  /** Offered frames ask nothing of the display: no failure here reaches it.
   * Pixels in flight are charged to the write, which outlives the capture. */
  private async offerLiveFrame(request: CaptureRequest, args: CaptureArgs, store: MotifFrameStore, read: (writer: FrameWriter) => FrameRead): Promise<QueuedWrite | null> {
    try {
      const address = this.liveWriteAddress(request, store)
      if (!address) return null
      const queued = await this.writes.offer(store, address, 'skip', async () => {
        const release = reserve(0, args.width * args.height * 8 / 1048576)
        try {
          const writer = await store.prepareWrite(address.hash, address.frame)
          if (!writer) throw new MotifError('closed', 'Motif frame has no open workspace')
          const encodeAndStore = await read(writer)()
          return () => encodeAndStore().finally(release)
        } catch (error) { release(); throw error }
      })
      queued?.written.catch(error => this.warnLiveWrite(error))
      return queued
    } catch (error) {
      this.warnLiveWrite(error)
      return null
    }
  }

  private warnLiveWrite(error: unknown): void {
    const code = motifErrorCode(error)
    if (this.liveWriteWarned || code === 'capacity' || code === 'superseded') return
    this.liveWriteWarned = true
    console.warn('[weftcut/motif] Live capture not stored:', error)
  }

  private async captureDisplay(owner: WebContents, request: CaptureRequest, isCurrent: () => boolean, finalizationId: number | undefined, store: MotifFrameStore, register: (attach: DisplayJob['attach']) => void): Promise<StoredMotifFrame> {
    if (!isCurrent()) throw motifSuperseded()
    const releaseResources = reserve(0, 16 + request.width * request.height * 16 / 1048576, finalizationId)
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
        if (!isCurrent()) throw motifSuperseded()
        if (stored && (!kept || sameAddress(cache, kept.address))) return storedFrame()
      }
      const { frame, queued } = await this.withFallback(() => this.deps.frame(args, async leased => {
        acceptingBake = false
        if (!isCurrent()) throw motifSuperseded()
        if (leased.kind === 'texture') {
          if (!this.deps.copy) throw new MotifError('device', 'Motif texture capture without a GPU transport')
          const queued = await this.offerDisplayFrame(leased, request, args, kept, store)
          // Capture/encoding can finish after a document reload. Such work
          // cannot lease a texture to the new preload on the same WebContents.
          if (!isCurrent()) throw motifSuperseded()
          return { frame: await this.deps.copy(owner, leased, finalizationId) as StoredMotifFrame, queued }
        }
        const rgba = await this.straighten(leased)
        if (!isCurrent()) throw motifSuperseded()
        const queued = await this.offerDisplayFrame(leased, request, args, kept, store, rgba)
        const pixels: StoredMotifFrame = { kind: 'pixels', width: leased.width, height: leased.height, bytes: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) }
        return { frame: pixels, queued }
      }, key, high, isCurrent))
      return { ...frame, persisted: kept ? await persisted(queued) : false }
    } finally {
      releaseResources()
      acceptingBake = false
    }
  }

  /** Inside the lease. A frame nobody can store is still delivered: no failure
   * here reaches the display. */
  private async offerDisplayFrame(frame: MotifOsrFrame, request: CaptureRequest, args: CaptureArgs, kept: { address: MotifCacheAddress; writer: Promise<FrameWriter | null> } | undefined, store: MotifFrameStore, rgba?: Buffer): Promise<QueuedWrite | null> {
    if (!kept) return this.offerLiveFrame(request, args, store, writer => this.frameRead(frame, args, writer, rgba))
    try {
      const writer = await kept.writer
      return writer ? await this.writes.offer(store, kept.address, 'wait', this.frameRead(frame, args, writer, rgba)) : null
    } catch { return null }
  }

  dispose(): void { this.encoder?.close(); this.encoder = null }
}
