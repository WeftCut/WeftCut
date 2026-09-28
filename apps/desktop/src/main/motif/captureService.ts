import type { OffscreenSharedTexture, WebContents } from 'electron'
import type { CaptureArgs } from './capture'
import type { MotifFrameStore, FrameWriter } from './frameStore'
import type { MotifCacheAddress, MotifTextureFrame, StoredMotifFrame } from '../../shared/motifs/frameTransport'
import { CAPTURE_SUPERSEDED_MESSAGE } from '../../shared/motifs/captureErrors'

export interface TextureEncoder { encode(handle: Buffer): Promise<Buffer>; close(): void }
export interface CaptureRequest extends CaptureArgs {
  coalesceKey?: string
  high?: boolean
  bake?: MotifCacheAddress
}
export interface CaptureServiceDeps {
  store: MotifFrameStore
  texture: (args: CaptureArgs, consume: (texture: OffscreenSharedTexture) => Promise<StoredMotifFrame>, key?: string, high?: boolean) => Promise<StoredMotifFrame>
  png: (args: CaptureArgs, key?: string, high?: boolean) => Promise<string>
  copy: ((owner: WebContents, texture: OffscreenSharedTexture) => Promise<MotifTextureFrame>) | null
  createEncoder: (() => TextureEncoder) | null
  setTextureEnabled: (enabled: boolean) => void
  isContentFailure: (args: CaptureArgs, error: unknown) => boolean
}

/** Capture and optional bake share the one OSR lease. A readback failure keeps
 * the captured bitmap available for the PNG writer; disk failures remain errors. */
export class MotifCaptureService {
  private useTexture: boolean
  private encoder: TextureEncoder | null = null
  private encoderFailed = false
  private jobs = new Map<string, { attach: (address: MotifCacheAddress) => void }>()
  constructor(private readonly deps: CaptureServiceDeps, enabled: boolean) {
    this.useTexture = enabled && !!deps.copy
    deps.setTextureEnabled(this.useTexture)
  }

  async capture(owner: WebContents, request: CaptureRequest): Promise<StoredMotifFrame> {
    const { coalesceKey, high, bake, ...args } = request
    const key = coalesceKey === undefined ? undefined : `${owner.id}:${coalesceKey}`
    // Begin resolving the workspace now, without postponing capture admission:
    // control messages follow it on the same preload IPC sender.
    let writeFailed = false
    let destination: Promise<FrameWriter | null> | undefined
    let acceptingBake = true
    const job = { attach: (address: MotifCacheAddress) => {
      if (!acceptingBake || destination) return
      destination = this.deps.store.prepareWrite(address.hash, address.frame)
        .catch(error => { writeFailed = true; throw error })
      void destination.catch(() => {})
    } }
    if (bake) job.attach(bake)
    if (key) this.jobs.set(key, job)
    const write = async (writer: FrameWriter | null, bytes: Uint8Array, png: boolean): Promise<boolean> => {
      if (!writer) { writeFailed = true; throw new Error('Motif bake has no open workspace') }
      try { if (png) await writer.png(bytes); else await writer.encoded(bytes) }
      catch (error) { writeFailed = true; throw error }
      return true
    }
    try {
      if (this.useTexture) {
        try {
          return await this.deps.texture(args, async texture => {
            let persisted = false
            acceptingBake = false
            if (destination) {
              const writer = await destination
              let bytes: Buffer | undefined
              if (!this.encoderFailed && this.deps.createEncoder) {
                try {
                  const { codedSize, pixelFormat, handle } = texture.textureInfo
                  if (codedSize.width !== args.width || codedSize.height !== args.height ||
                      (pixelFormat !== 'rgba' && pixelFormat !== 'bgra') || !handle.ntHandle) throw new Error('Unsupported bake texture')
                  this.encoder ??= this.deps.createEncoder()
                  bytes = await this.encoder.encode(handle.ntHandle)
                } catch {
                  // No recapture: deliver this frame and let the compatibility
                  // PNG writer persist it. Subsequent frames skip failed readback.
                  this.encoderFailed = true
                  this.encoder?.close(); this.encoder = null
                }
              }
              if (bytes) persisted = await write(writer, bytes, false)
            }
            return { ...await this.deps.copy!(owner, texture), persisted }
          }, key, high)
        } catch (error) {
          if (writeFailed || String(error).includes(CAPTURE_SUPERSEDED_MESSAGE) || this.deps.isContentFailure(args, error)) throw error
          this.useTexture = false
          this.deps.setTextureEnabled(false)
        }
      }
      const bytes = Buffer.from(await this.deps.png(args, key, high), 'base64')
      acceptingBake = false
      const persisted = destination ? await write(await destination, bytes, true) : false
      return { kind: 'png', bytes, persisted }
    } finally {
      acceptingBake = false
      if (key && this.jobs.get(key) === job) this.jobs.delete(key)
    }
  }

  requestBake(ownerId: number, key: string, address: MotifCacheAddress): void {
    this.jobs.get(`${ownerId}:${key}`)?.attach(address)
  }

  dispose(): void { this.encoder?.close(); this.encoder = null }
}
