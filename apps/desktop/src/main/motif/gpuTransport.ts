import { sharedTexture, type SharedTextureImported, type WebContents, type OffscreenSharedTexture } from 'electron'
import { randomUUID } from 'node:crypto'
import { withSharedTextureQueue } from '../sharedTextureQueue.js'
import type { MotifTextureFrame } from '../../shared/motifs/frameTransport.js'

export interface MotifPool {
  handles(): Buffer[]
  uploadFile(path: string, slot: number): Promise<void>
  copyTexture(handle: Buffer, slot: number): Promise<void>
  close(): void
}
type PoolFactory = (w: number, h: number, bgra: boolean) => MotifPool
type Session = { owner: WebContents; key: string; width: number; height: number; pool: MotifPool; imported: SharedTextureImported; busy: boolean }
const MAX_BYTES = 128 * 1024 * 1024
const BUDGET_WAIT_MS = 250

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
  private readonly freeLanes: number[]
  private readonly laneWaiters: ((lane: number) => void)[] = []
  // Includes imports in progress and retired textures still held by Chromium.
  private allocatedBytes = 0
  private allocatedSessions = 0
  private budgetWaiters = new Set<() => void>()
  private budgetStalled = false
  private pending = new Map<string, { owner: number; retire: () => void; release: () => void }>()
  private unavailable = new WeakSet<WebContents>()
  private generations = new WeakMap<WebContents, number>()
  constructor(private readonly createPool: PoolFactory, concurrency = 3) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Invalid Motif transport concurrency')
    this.freeLanes = Array.from({ length: concurrency }, (_, lane) => lane)
  }

  private acquireLane(): Promise<number> {
    const lane = this.freeLanes.shift()
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

  read(owner: WebContents, file: string, width: number, height: number): Promise<MotifTextureFrame> {
    return this.produce(owner, width, height, 'rgba', pool => pool.uploadFile(file, 0))
  }

  copy(owner: WebContents, texture: OffscreenSharedTexture): Promise<MotifTextureFrame> {
    const { codedSize, pixelFormat, handle } = texture.textureInfo
    if ((pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle) {
      return Promise.reject(new Error('Unsupported Motif OSR texture'))
    }
    return this.produce(owner, codedSize.width, codedSize.height, pixelFormat,
      pool => pool.copyTexture(handle.ntHandle!, 0))
  }

  private async produce(owner: WebContents, width: number, height: number, format: 'rgba' | 'bgra', fill: (pool: MotifPool) => Promise<void>): Promise<MotifTextureFrame> {
    if (this.unavailable.has(owner)) throw new Error('Motif shared textures unavailable for this renderer')
    const generation = this.generations.get(owner) ?? 0
    const assertOpen = (): void => {
      if (!consumerFrameAlive(owner) || (this.generations.get(owner) ?? 0) !== generation) throw new Error('Motif consumer closed')
    }
    // Independent leases let native reading/upload overlap the preceding
    // consumer's GPU read. A lane still cannot overwrite an unacknowledged slot.
    const lane = await this.acquireLane()
    const unlock = (): void => this.releaseLane(lane)
    let active: Session | undefined
    const address = `${owner.id}:${width}:${height}:${format}:${lane}`
    try {
      assertOpen()
      let s = this.sessions.get(address)
      if (s) { this.sessions.delete(address); this.sessions.set(address, s) }
      if (!s) {
        const bytes = width * height * 4
        if (!Number.isSafeInteger(bytes) || width <= 0 || height <= 0 || bytes > MAX_BYTES) throw new Error('Motif GPU budget exhausted')
        const deadline = performance.now() + BUDGET_WAIT_MS
        for (;;) {
          assertOpen()
          for (const [key, old] of this.sessions) {
            if (this.allocatedBytes + bytes <= MAX_BYTES && this.allocatedSessions < 8) break
            if (old.busy) continue
            this.retireSession(key, old)
          }
          if (this.allocatedBytes + bytes <= MAX_BYTES && this.allocatedSessions < 8) break
          // Retired imports can outlive their document. Keep their pools alive,
          // but let the caller read on CPU instead of wedging every GPU lane.
          // Once stalled, new allocations fail promptly until references free.
          if (this.budgetStalled || performance.now() >= deadline) {
            this.budgetStalled = true
            throw new Error('Motif GPU budget exhausted while awaiting texture release')
          }
          await this.waitForBudget(deadline)
        }
        // Reserve before awaiting the global import queue: another lane must
        // account for allocations whose import has not completed yet.
        this.allocatedBytes += bytes
        this.allocatedSessions++
        const releaseBudget = (): void => {
          this.allocatedBytes -= bytes
          this.allocatedSessions--
          this.budgetStalled = false
          this.budgetChanged()
        }
        s = await withSharedTextureQueue(async () => {
          try { assertOpen() } catch (error) { releaseBudget(); throw error }
          let pool: MotifPool
          try { pool = this.createPool(width, height, format === 'bgra') }
          catch (error) { releaseBudget(); this.unavailable.add(owner); throw error }
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
            return { owner, key, width, height, pool, imported, busy: true }
          } catch (error) {
            if ((this.generations.get(owner) ?? 0) === generation) this.unavailable.add(owner)
            this.notifyRetired(owner, key)
            if (imported) imported.release()
            else { try { pool.close() } finally { releaseBudget() } }
            throw error
          }
        })
        this.sessions.set(address, s)
      }
      active = s
      s.busy = true
      await fill(s.pool)
      assertOpen()
      const token = randomUUID()
      const timeout = setTimeout(() => {
        // Never overwrite a slot whose consumer hasn't acknowledged. Retire it;
        // a later request allocates a different resource, so late reads stay safe.
        this.release(owner, token, true)
      }, 5000)
      this.pending.set(token, { owner: owner.id, retire: () => this.retireSession(address, s), release: () => {
        clearTimeout(timeout); s.busy = false; this.budgetChanged(); unlock()
      } })
      return { kind: 'texture', key: s.key, token }
    } catch (error) {
      if (active) this.retireSession(address, active)
      this.budgetChanged(); unlock(); throw error
    }
  }

  close(owner: WebContents): void {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1)
    this.unavailable.delete(owner)
    this.retire(owner)
    for (const [token, lease] of this.pending) if (lease.owner === owner.id) this.release(owner, token)
    this.budgetChanged()
  }
}
