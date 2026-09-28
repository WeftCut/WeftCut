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
type Session = { owner: WebContents; key: string; width: number; height: number; pool: MotifPool; imported: SharedTextureImported }

/** A bounded transport slot, NOT the decoded-frame cache. The receiver snapshots
 * into its own ImageBitmap, completes the GPU read, then releases the lease.
 * Old native pools survive until Electron releases all imported references. */
export class MotifGpuTransport {
  private sessions = new Map<string, Session>()
  private tail: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, { owner: number; release: () => void }>()
  private unavailable = new WeakSet<WebContents>()
  constructor(private readonly createPool: PoolFactory) {}

  private retire(owner: WebContents): void {
    for (const [address, s] of this.sessions) if (s.owner === owner) this.retireSession(address, s)
  }

  private retireSession(address: string, s: Session): void {
    this.sessions.delete(address)
    if (!s.owner.isDestroyed()) s.owner.send('evt:motifGpu:close', { key: s.key })
    try { s.imported.release() } catch { /* renderer/GPU process already gone */ }
  }

  release(owner: WebContents, token: string, failed = false): void {
    const lease = this.pending.get(token)
    if (lease?.owner === owner.id) {
      if (failed) this.retire(owner)
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
    const previous = this.tail
    let unlock!: () => void
    this.tail = new Promise<void>(resolve => { unlock = resolve })
    await previous.catch(() => {})
    try {
      if (owner.isDestroyed()) throw new Error('Motif consumer closed')
      const address = `${owner.id}:${width}:${height}:${format}`
      let s = this.sessions.get(address)
      if (s) { this.sessions.delete(address); this.sessions.set(address, s) }
      if (!s) {
        const bytes = width * height * 4
        if (!Number.isSafeInteger(bytes) || width <= 0 || height <= 0 || bytes > 128 * 1024 * 1024) throw new Error('Motif GPU budget exhausted')
        let resident = [...this.sessions.values()].reduce((n, v) => n + v.width * v.height * 4, 0)
        for (const [key, old] of this.sessions) {
          if (resident + bytes <= 128 * 1024 * 1024 && this.sessions.size < 8) break
          this.retireSession(key, old)
          resident -= old.width * old.height * 4
        }
        s = await withSharedTextureQueue(async () => {
          let pool: MotifPool
          try { pool = this.createPool(width, height, format === 'bgra') }
          catch (error) { this.unavailable.add(owner); throw error }
          const key = `motif-${randomUUID()}`
          let imported: SharedTextureImported | undefined
          try {
            imported = sharedTexture.importSharedTexture({
              textureInfo: {
                codedSize: { width, height }, pixelFormat: format,
                colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
                handle: { ntHandle: pool.handles()[0]! },
              },
              allReferencesReleased: () => pool.close(),
            })
            owner.send('evt:previewGpu:slot', { streamId: key, slot: 0 })
            await sharedTexture.sendSharedTexture({ frame: owner.mainFrame, importedSharedTexture: imported })
            return { owner, key, width, height, pool, imported }
          } catch (error) {
            this.unavailable.add(owner)
            if (!owner.isDestroyed()) owner.send('evt:motifGpu:close', { key })
            if (imported) imported.release(); else pool.close()
            throw error
          }
        })
        this.sessions.set(address, s)
      }
      await fill(s.pool)
      const token = randomUUID()
      const timeout = setTimeout(() => {
        // Never overwrite a slot whose consumer hasn't acknowledged. Retire it;
        // a later request allocates a different resource, so late reads stay safe.
        this.retire(owner)
        this.release(owner, token)
      }, 5000)
      this.pending.set(token, { owner: owner.id, release: () => { clearTimeout(timeout); unlock() } })
      return { kind: 'texture', key: s.key, token }
    } catch (error) { this.retire(owner); unlock(); throw error }
  }

  close(owner: WebContents): void {
    this.unavailable.delete(owner)
    this.retire(owner)
    for (const [token, lease] of this.pending) if (lease.owner === owner.id) this.release(owner, token)
  }
}
