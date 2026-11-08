import { MIB, performanceSettings, sharedResourceAllocationEnabled } from "../../shared/performance-settings";
import { sharedTexture, type SharedTextureImported, type WebContents } from 'electron'
import type { MotifOsrFrame } from './offscreenFrames.js'
import { randomUUID } from 'node:crypto'
import { asMotifCapacity, MotifError, motifErrorCode, motifSuperseded } from '../../shared/motifs/errors'
import { isResourceCapacityError } from '../../shared/resource-policy'
import { withSharedTextureQueue } from '../sharedTextureQueue.js'
import { gpuBufferBudget, type GpuBufferBudget, type GpuBufferLease } from '../gpuBufferBudget.js'
import { MOTIF_TEXTURE_LANE_RESET, type MotifReaderDiv } from '../../shared/motifs/readerProtocol.js'
import { fitsMotifTexture } from '../../shared/motifs/limits.js'
import { MOTIF_DEADLINES, type MotifTuning } from '../../shared/motifs/tuning.js'
import type { MotifReadUnavailable, MotifTextureFrame, MotifUploadTiming } from '../../shared/motifs/frameTransport.js'

export interface MotifPool {
  handles(): Buffer[]
  /** Reads, verifies and downscales by `div` (default 1); the pool must have
   * the scaled size. A `miss` rejection is about the file. */
  uploadFile(path: string, slot: number, div?: number): Promise<MotifUploadTiming>
  copyTexture(handle: Buffer, slot: number): Promise<void>
  close(): void
}
/** An `upload` pool reads stored frames through a staging texture as large as
 * its slot; a copy pool holds the slot alone. */
type PoolFactory = (w: number, h: number, bgra: boolean, upload: boolean) => MotifPool
type PoolUse = 'upload' | 'copy'
type Session = { finalizationId?: number | undefined; owner: WebContents; key: string; width: number; height: number; pool: MotifPool; imported: SharedTextureImported; busy: boolean }
/** The tuning keys the transport runs on (`shared/motifs/tuning.ts`). */
export type GpuTransportTuning = Pick<MotifTuning, 'gpuLanes' | 'gpuBudgetWaitMs'>

function consumerFrameAlive(owner: WebContents): boolean {
  try {
    if (owner.isDestroyed()) return false
    const frame = owner.mainFrame
    return !frame.isDestroyed() && !frame.detached
  } catch { return false }
}

/** Bounded transport lanes, NOT the decoded-frame cache. The receiver snapshots
 * into its own ImageBitmap, completes the GPU read, then releases the lease.
 * Old native pools survive until Electron releases all imported references. */
export class MotifGpuTransport {
  private sessions = new Map<string, Session>()
  private exportCancellations = new Map<number, Set<() => void>>()
  private readonly freeLanes: number[]
  private readonly laneWaiters: ((lane: number) => void)[] = []
  // Includes imports in progress and retired textures still held by Chromium.
  private allocatedBytes = 0
  private allocatedSessions = 0
  private budgetWaiters = new Set<() => void>()
  private budgetStalled = false
  private pending = new Map<string, { owner: number; retire: () => void; release: () => void }>()
  /** Owners whose pool device, import or send failed: their reads answer
   * `lane` until `close(owner)`. */
  private laneOff = new WeakSet<WebContents>()
  private generations = new WeakMap<WebContents, number>()
  private readonly budgetWaitMs: number
  constructor(private readonly createPool: PoolFactory, tuning: GpuTransportTuning, private readonly buffers: GpuBufferBudget = gpuBufferBudget) {
    if (!Number.isInteger(tuning.gpuLanes) || tuning.gpuLanes < 1) throw new Error('Invalid Motif transport lane count')
    this.freeLanes = Array.from({ length: tuning.gpuLanes }, (_, lane) => lane)
    this.budgetWaitMs = tuning.gpuBudgetWaitMs
  }

  private acquireLane(preferred?: number): Promise<number> {
    const index = preferred === undefined ? -1 : this.freeLanes.indexOf(preferred)
    const lane = index < 0 ? this.freeLanes.shift() : this.freeLanes.splice(index, 1)[0]
    return lane === undefined ? new Promise(resolve => this.laneWaiters.push(resolve)) : Promise.resolve(lane)
  }

  private releaseLane(lane: number): void {
    const next = this.laneWaiters.shift()
    if (next) next(lane)
    else this.freeLanes.push(lane)
  }

  private budgetChanged(): void {
    for (const wake of this.budgetWaiters) wake()
    this.budgetWaiters.clear()
  }

  private waitForBudget(deadline: number): Promise<void> {
    return new Promise(resolve => {
      const wake = (): void => {
        clearTimeout(timer)
        this.budgetWaiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, Math.max(0, deadline - performance.now()))
      this.budgetWaiters.add(wake)
    })
  }

  /** Moves an idle session of this shape from another lane to `address`.
   * Taking it costs nothing; retiring it to make room for a new pool would keep
   * its memory charged until Chromium releases it, and the lanes would rebuild
   * each other's pools. */
  private adopt(prefix: string, address: string): Session | undefined {
    for (const [key, s] of this.sessions) {
      if (key.startsWith(prefix) && !s.busy) {
        this.sessions.delete(key)
        this.sessions.set(address, s)
        return s
      }
    }
    return undefined
  }

  private retire(owner: WebContents): void {
    for (const [address, s] of this.sessions) if (s.owner === owner) this.retireSession(address, s)
  }

  private notifyRetired(owner: WebContents, key: string): void {
    // WebContents can outlive its render frame (notably after a crash).
    // Electron logs disposed-frame sends internally, so catching send alone
    // cannot prevent the error. Notification must never block local cleanup.
    try {
      if (!consumerFrameAlive(owner)) return
      owner.send('evt:motifGpu:close', { key })
    } catch { /* renderer/frame already gone */ }
  }

  private retireSession(address: string, s: Session): void {
    if (this.sessions.get(address) !== s) return
    this.sessions.delete(address)
    this.notifyRetired(s.owner, s.key)
    try { s.imported.release() } catch { /* renderer/GPU process already gone */ }
    this.budgetChanged()
  }

  release(owner: WebContents, token: string, failed = false): void {
    const lease = this.pending.get(token)
    if (lease?.owner === owner.id) {
      if (failed) lease.retire()
      this.pending.delete(token); lease.release()
    }
  }

  /** False once the owner's pool device, import or send failed, until
   * `close(owner)`. */
  available(owner: WebContents): boolean {
    return !this.laneOff.has(owner)
  }

  /** The owner's lane generation; every `close(owner)` advances it. */
  generation(owner: WebContents): number {
    return this.generations.get(owner) ?? 0
  }

  private turnLaneOff(owner: WebContents, generation: number): void {
    if (this.generation(owner) === generation) this.laneOff.add(owner)
  }

  /** Uploads a cached frame scaled by `div` into a session of the scaled
   * `width × height`. A `miss`, a `closed` consumer or pool and a `superseded`
   * export reject. Any other failure sends the read to the utility lane
   * (ADR 0154): `lane` once the owner's lane is off, else `read` (the texture
   * limit, the GPU budget, a held file or mutex, a failed upload). */
  async read(owner: WebContents, file: string, width: number, height: number, div: MotifReaderDiv, finalizationId?: number): Promise<MotifTextureFrame | MotifReadUnavailable> {
    const generation = this.generation(owner)
    if (!this.available(owner)) return { kind: 'unavailable', reason: 'lane', generation }
    try {
      return await this.produce(owner, width, height, 'rgba', 'upload', pool => pool.uploadFile(file, 0, div), finalizationId)
    } catch (error) {
      const code = motifErrorCode(error)
      if (code === 'miss' || code === 'closed' || code === 'superseded') throw error
      const off = !this.available(owner) && this.generation(owner) === generation
      return { kind: 'unavailable', reason: off ? 'lane' : 'read', generation }
    }
  }

  /** Copies the frame's picture, above the capture host's marker rows. */
  copy(owner: WebContents, frame: Extract<MotifOsrFrame, { kind: 'texture' }>, finalizationId?: number): Promise<MotifTextureFrame> {
    const { pixelFormat, handle } = frame.texture.textureInfo
    if ((pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle) {
      return Promise.reject(new Error('Unsupported Motif OSR texture'))
    }
    return this.produce(owner, frame.width, frame.height, pixelFormat, 'copy',
      pool => pool.copyTexture(handle.ntHandle!, 0), finalizationId)
  }

  private textureBudgetBytes(): number {
    const settings = performanceSettings()
    // Budget mode can borrow unused video allowance; the aggregate byte lease
    // still accounts for every live or retired texture. Legacy sub-limits stay.
    return (sharedResourceAllocationEnabled() ? settings.gpu_buffer_mib : settings.motif_gpu_mib) * MIB
  }

  private async produce(owner: WebContents, width: number, height: number, format: 'rgba' | 'bgra', use: PoolUse, fill: (pool: MotifPool) => Promise<MotifUploadTiming | void>, finalizationId?: number): Promise<MotifTextureFrame> {
    if (!this.available(owner)) throw new MotifError('device', 'Motif shared textures are off for this document')
    // Over the limit is this frame's size, never the lane's health.
    if (!fitsMotifTexture(width, height, use)) throw new MotifError('oversize', `Motif ${use} texture ${width}x${height} exceeds the texture limit`)
    const generation = this.generation(owner)
    let exportOpen = true
    const cancelExport = () => { exportOpen = false }
    if (finalizationId !== undefined) {
      const readers = this.exportCancellations.get(finalizationId) ?? new Set<() => void>()
      readers.add(cancelExport)
      this.exportCancellations.set(finalizationId, readers)
    }
    const assertOpen = (): void => {
      if (!exportOpen) throw motifSuperseded()
      if (!consumerFrameAlive(owner) || this.generation(owner) !== generation) throw new MotifError('closed', 'Motif consumer closed')
    }
    // Independent leases let native reading/upload overlap the preceding
    // consumer's GPU read. A lane still cannot overwrite an unacknowledged slot.
    // Reuse an idle pool before rotating lanes. Retirement keeps its memory
    // charged until Chromium releases every reference; needless rotation would
    // require a second pool even for a one-frame export plan.
    const prefix = `${owner.id}:${finalizationId ?? "preview"}:${use}:${width}:${height}:${format}:`
    const reusable = this.freeLanes.find(lane => this.sessions.has(`${prefix}${lane}`))
    const lane = await this.acquireLane(reusable)
    const unlock = (): void => this.releaseLane(lane)
    let active: Session | undefined
    const address = `${prefix}${lane}`
    try {
      assertOpen()
      let s = this.sessions.get(address) ?? this.adopt(prefix, address)
      if (s) { this.sessions.delete(address); this.sessions.set(address, s) }
      if (!s) {
        // Export retains at most one size per idle lane. Its parent reservation
        // owns these pools until finalization/cancellation retires them.
        if (finalizationId !== undefined) {
          for (const [key, old] of this.sessions) if (old.finalizationId === finalizationId && !old.busy) this.retireSession(key, old);
        }
        // The staging texture counts like the slot.
        const bytes = width * height * 4 * (use === 'upload' ? 2 : 1)
        if (bytes > this.textureBudgetBytes()) throw new MotifError('capacity', 'Motif GPU budget exhausted')
        const deadline = performance.now() + this.budgetWaitMs
        let bufferLease: GpuBufferLease | null = null
        for (;;) {
          assertOpen()
          // A session of this shape finishing its read serves this one too.
          s = this.adopt(prefix, address)
          if (s) break
          let capacityError: unknown
          for (const [key, old] of this.sessions) {
            const global = this.buffers.snapshot()
            if (this.allocatedBytes + bytes <= this.textureBudgetBytes() && this.allocatedSessions < performanceSettings().motif_gpu_sessions
              && global.used_bytes + bytes <= global.limit_bytes) break
            if (old.busy) continue
            this.retireSession(key, old)
          }
          if (this.allocatedBytes + bytes <= this.textureBudgetBytes() && this.allocatedSessions < performanceSettings().motif_gpu_sessions) {
            try { bufferLease = this.buffers.reserve('motif', bytes, finalizationId) }
            catch (error) {
              if (!isResourceCapacityError(error)) throw error
              // A retired RGBA pool can still hold the export's credit when
              // a cache miss needs a BGRA pool. Wait for the final-reference
              // callback just as we do for the shared GPU byte budget.
              capacityError = error
            }
            if (bufferLease) break
          }
          // Retired imports can outlive their document. Keep their pools alive,
          // but let the caller use another lane instead of wedging every GPU lane.
          // Once stalled, new allocations fail promptly until references free,
          // unless a pool of this shape will come free when its read is acked.
          const sibling = [...this.sessions.keys()].some(key => key.startsWith(prefix))
          if ((this.budgetStalled && !sibling) || performance.now() >= deadline) {
            // Preserve hard admission failures: never turn them into a PNG
            // retry that bypasses the export's resource plan.
            if (capacityError) throw asMotifCapacity(capacityError)
            this.budgetStalled = true
            throw new MotifError('capacity', 'Motif GPU budget exhausted while awaiting texture release')
          }
          await this.waitForBudget(deadline)
        }
        if (!s) {
          // Reserve before awaiting the global import queue: another lane must
          // account for allocations whose import has not completed yet.
          this.allocatedBytes += bytes
          this.allocatedSessions++
          const releaseBudget = (): void => {
            this.buffers.release(bufferLease)
            this.allocatedBytes -= bytes
            this.allocatedSessions--
            this.budgetStalled = false
            this.budgetChanged()
          }
          s = await withSharedTextureQueue(async () => {
            try { assertOpen() } catch (error) { releaseBudget(); throw error }
            let pool: MotifPool
            try { pool = this.createPool(width, height, format === 'bgra', use === 'upload') }
            catch (error) {
              releaseBudget()
              // Native `oversize` is this size's; only the device is the lane's.
              if (motifErrorCode(error) === 'device') this.turnLaneOff(owner, generation)
              throw error
            }
            const key = `motif-${randomUUID()}`
            let imported: SharedTextureImported | undefined
            try {
              imported = sharedTexture.importSharedTexture({
                textureInfo: {
                  codedSize: { width, height }, pixelFormat: format,
                  colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
                  handle: { ntHandle: pool.handles()[0]! },
                },
                allReferencesReleased: () => { try { pool.close() } finally { releaseBudget() } },
              })
              owner.send('evt:previewGpu:slot', { streamId: key, slot: 0 })
              await sharedTexture.sendSharedTexture({ frame: owner.mainFrame, importedSharedTexture: imported })
              assertOpen()
              return { finalizationId, owner, key, width, height, pool, imported, busy: true }
            } catch (error) {
              const code = motifErrorCode(error)
              const failed = code !== 'closed' && code !== 'superseded'
              if (failed) this.turnLaneOff(owner, generation)
              this.notifyRetired(owner, key)
              if (imported) imported.release()
              else { try { pool.close() } finally { releaseBudget() } }
              throw failed && code === undefined
                ? new MotifError('device', `Motif shared texture import failed: ${String((error as Error | undefined)?.message ?? error)}`, { cause: error })
                : error
            }
          })
          this.sessions.set(address, s)
        }
      }
      active = s
      s.busy = true
      const timing = await fill(s.pool)
      assertOpen()
      const token = randomUUID()
      const timeout = setTimeout(() => {
        // Never overwrite a slot whose consumer hasn't acknowledged. Retire it;
        // a later request allocates a different resource, so late reads stay safe.
        this.release(owner, token, true)
      }, MOTIF_DEADLINES.gpuLeaseMs)
      this.pending.set(token, { owner: owner.id, retire: () => this.retireSession(address, s), release: () => {
        clearTimeout(timeout); s.busy = false; this.budgetChanged(); unlock()
      } })
      return timing ? { kind: 'texture', key: s.key, token, timing } : { kind: 'texture', key: s.key, token }
    } catch (error) {
      if (active) this.retireSession(address, active)
      this.budgetChanged(); unlock(); throw error
    } finally {
      if (finalizationId !== undefined) {
        const readers = this.exportCancellations.get(finalizationId)
        readers?.delete(cancelExport)
        if (!readers?.size) this.exportCancellations.delete(finalizationId)
      }
    }
  }

  closeExport(owner: WebContents, id: number): void {
    for (const cancel of this.exportCancellations.get(id) ?? []) cancel()
    for (const [address, session] of this.sessions) {
      if (session.owner === owner && session.finalizationId === id) this.retireSession(address, session);
    }
  }

  /** Retires the owner's sessions and leases and turns its lane on again. A
   * renderer told `lane` hears of it through `MOTIF_TEXTURE_LANE_RESET`. */
  close(owner: WebContents): void {
    const generation = this.generation(owner) + 1
    this.generations.set(owner, generation)
    if (this.laneOff.delete(owner)) {
      try { if (consumerFrameAlive(owner)) owner.send(MOTIF_TEXTURE_LANE_RESET, generation) } catch { /* renderer/frame already gone */ }
    }
    this.retire(owner)
    for (const [token, lease] of this.pending) if (lease.owner === owner.id) this.release(owner, token)
    this.budgetChanged()
  }
}
