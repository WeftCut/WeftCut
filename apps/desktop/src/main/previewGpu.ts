// Native GPU preview sessions (Windows d3d11va): the hardware lane that keeps
// decoded frames on the GPU. Each session is a decode session like the byte
// lanes' (frameCarrier/decodeSessionHost.ts): its `slot`, `end` and `error`
// messages reach only its own port, and `request` and `release` come up it.
// What is particular to slots lives here: the GPU admission a session
// reserves, and handing the pool's textures to the owner's document once, at
// open (frameCarrier/sharedTextureImport.ts). docs/preview.md § The Standard
// engine.
//
// The pool is imported and sent once and kept for the whole session; a frame
// is only a `slot` message naming which texture holds it. A per-frame import
// and send would be bound by IPC, and a benchmark built on it would report IPC
// latency as decode throughput.
//
// Windows-only: the addon's `previewGpu*` methods throw "preview-gpu not built"
// elsewhere; the lane selection upstream decides when a session is opened.
import type { SharedTextureImported, WebContents } from 'electron'
import type { NativeDecode, PreviewGpuAdapter } from '@weftcut/native-decode'
import {
  HW_BUDGET_EXCEEDED,
  HW_BUDGET_RESERVATION_MISMATCH,
  type PreviewGpuBudgetSnapshot,
  type PreviewGpuColorSpace,
  type PreviewGpuOpenReply,
  type PreviewGpuTimingReport,
} from '../shared/ipc'
import type { PreviewGpuCommand } from '../shared/frameCarrier/wire'
import { clearMainPendingFor, recordConsumeAck, recordFrameReadySent } from './previewGpuTiming.js'
import { gpuBufferBudget, retainGpuBufferLease } from './gpuBufferBudget.js'
import { performanceSettings } from '../shared/performance-settings.js'
import { reserveResources } from './resources.js'
import { createPreviewGpuBudget } from './previewGpuBudget.js'
import { admitDecodeSession } from './frameCarrier/decodeSessionAdmission.js'
import type { CarrierPort } from './frameCarrier/decodeSessionHost.js'
import { importAndSend } from './frameCarrier/sharedTextureImport.js'

export interface PreviewGpuRequest {
  sessionId: string
  path: string
  poolSize: number
  /** The source's resolved colour: native converts NV12 to RGBA with it. */
  colorSpace: PreviewGpuColorSpace
  /** Renderer-probed coded dimensions, reserved before native allocates. */
  codedWidth: number
  codedHeight: number
}

interface GpuSession {
  width: number
  height: number
  slots: number
  adapter: PreviewGpuAdapter | null
}

const sessions = new Map<string, GpuSession>()

/** Actual active decoder identities, including unknown identity explicitly. */
export function previewGpuDevices(): Array<{ streamId: string; adapter: PreviewGpuAdapter | null }> {
  return [...sessions].map(([streamId, session]) => ({ streamId, adapter: session.adapter }))
}

/// One admission authority for every open and close. It greedily reserves
/// coded pixel AREA (not pixel rate), a hard session slot and shared-buffer
/// bytes before native allocation. The budget owns validation and idempotent
/// lease release; callers never recompute policy.
const previewGpuBudget = createPreviewGpuBudget(performanceSettings, gpuBufferBudget)

/// Live HW-session count (for the renderer's budget-aware resolution + tests).
export function hwSessionCount(): number {
  return previewGpuBudget.snapshot().sessions.used
}

/// The budget as the renderer sees it (`previewGpu:budget`). Both admission
/// constraints travel together: the hard session cap and the coded-pixel-area
/// currency, whose reference is 30fps by default or 60fps after an accepted
/// benchmark. Shared-buffer bytes also constrain admission.
///
/// A sample is a point in time, not a promise: a session another document
/// closes may still hold its lease when the sample is taken, so `used < max`
/// at read time does not guarantee the next open succeeds.
///
/// `slotVram` is computed HERE from the live session records: Σ w×h×4×slots
/// over open sessions. The shared buffer budget separately retains credits for
/// retired imports and Motif pools.
export function hwBudget(): PreviewGpuBudgetSnapshot {
  let usedBytes = 0
  for (const s of sessions.values()) usedBytes += s.width * s.height * 4 * s.slots
  return { ...previewGpuBudget.snapshot(), slotVram: { usedBytes, bytesPerPixel: 4 } }
}

/** Opens a session served on `port` until its consumer closes it or `owner`'s
 * document goes away, and hands the pool's textures to `owner`'s document.
 * Resolves once every texture has arrived there, so a slot message can never
 * name a texture the preload does not hold yet; slots fill only after the
 * first `request`. Rejects with `HW_BUDGET_EXCEEDED` when admission is full. */
export async function openPreviewGpu(
  backend: NativeDecode,
  owner: WebContents,
  port: CarrierPort,
  request: PreviewGpuRequest,
): Promise<PreviewGpuOpenReply> {
  const { sessionId, path, poolSize, colorSpace, codedWidth, codedHeight } = request
  let buffers!: ReturnType<typeof retainGpuBufferLease>
  const imports: Promise<SharedTextureImported>[] = []
  let sent: Promise<unknown> = Promise.resolve()
  const session = admitDecodeSession({
    sessionId,
    port,
    owner,
    // Invalid or missing dimensions fail closed in the same transient capacity
    // class: a stale probe must never let main under-count decode load.
    reserve: () => {
      const lease = previewGpuBudget.reserve(sessionId, { width: codedWidth, height: codedHeight }, poolSize)
      if (!lease) throw new Error(HW_BUDGET_EXCEEDED)
      const lifetime = retainGpuBufferLease(gpuBufferBudget, lease.bufferLease)
      buffers = lifetime
      let releaseDecoder = () => {}
      // A failed step of the release must not stop the next: a single leak
      // here holds capacity for the rest of the app session.
      const release = () => {
        try { previewGpuBudget.release(lease, true) }
        finally {
          try { lifetime.retire() }
          finally { releaseDecoder() }
        }
      }
      try { releaseDecoder = reserveResources(0, 64 + codedWidth * codedHeight * 24 / 1048576) }
      catch (error) { release(); throw error }
      return release
    },
    open: onMsg => {
      const frame = owner.mainFrame
      // The renderer's conversion of the source goes to native, which converts
      // NV12 to RGBA with its own shader (constants held to the renderer's by
      // one golden); Chromium never sees the YUV.
      const conversion = { matrix: colorSpace.matrix, fullRange: colorSpace.range === 'full', primaries: colorSpace.primaries }
      const info = backend.previewGpuOpen(sessionId, path, poolSize, conversion, (err, msg) => {
        // Only a message the addon could not hand over arrives as `err`. A
        // lost slot comes back through native's lease reclaim, so the session
        // stays whole.
        if (err) { console.warn(`[main] previewGpu ${sessionId}: message lost`, err); return }
        if (msg.kind === 'slot') recordFrameReadySent(sessionId, msg.slot, performance.now())
        onMsg(msg)
      })
      // The host closes only a session whose open returned, so a failure from
      // here on has to undo the native open itself.
      try {
        if (info.width !== codedWidth || info.height !== codedHeight) {
          throw new Error(
            `${HW_BUDGET_RESERVATION_MISMATCH}: reserved ${codedWidth}x${codedHeight}, native opened ${info.width}x${info.height}`,
          )
        }
        for (const [slot, { handle }] of info.slots.entries()) {
          // Imported as RGBA tagged sRGB passthrough, never the source's colour:
          // the colour math already happened in the native shader.
          imports.push(importAndSend(frame, { handle, width: info.width, height: info.height, format: 'rgba' },
            { key: sessionId, slot }, buffers.reference()))
        }
      } catch (error) {
        try { backend.previewGpuClose(sessionId) }
        catch (closeErr) { console.warn(`[main] previewGpu rollback close failed for ${sessionId}`, closeErr) }
        for (const imported of imports) void imported.then(releaseImport, () => {})
        throw error
      }
      sent = Promise.all(imports)
      sessions.set(sessionId, { width: info.width, height: info.height, slots: info.slots.length, adapter: info.adapter ?? null })
      return info
    },
    parse: gpuCommand,
    command: cmd => {
      if (cmd.type === 'request') {
        // `targetUs` is source microseconds; the addon takes it as f64 (napi
        // has no ergonomic i64 parameter) and casts it down.
        backend.previewGpuRequestFrameAt(sessionId, cmd.targetUs)
        return
      }
      recordConsumeAck(sessionId, cmd.slot, performance.now())
      backend.previewGpuRelease(sessionId, cmd.slot, cmd.gen)
    },
    // Native first: its close stops the decode thread, so no slot is written
    // after main's imports go. The admission lease is released after this.
    close: () => {
      clearMainPendingFor(sessionId)
      sessions.delete(sessionId)
      try { backend.previewGpuClose(sessionId) }
      finally {
        // A failed send released its own import; one still sending is
        // released once it settles.
        for (const imported of imports) void imported.then(releaseImport, () => {})
      }
    },
  })
  try { await sent }
  catch (error) {
    session.close()
    throw error
  }
  return { width: session.info.width, height: session.info.height, poolSize: session.info.slots.length }
}

/// Best-effort GPU-reference teardown: one broken Electron import must not
/// prevent the others from releasing.
function releaseImport(imported: SharedTextureImported): void {
  try { imported.release() }
  catch (error) { console.warn('[main] previewGpu import release failed', error) }
}

function gpuCommand(data: Record<string, unknown>): PreviewGpuCommand | null {
  if (data.type === 'request' && Number.isFinite(data.targetUs)) return { type: 'request', targetUs: data.targetUs as number }
  if (data.type === 'release' && isU32(data.slot) && isU32(data.gen))
    return { type: 'release', slot: data.slot as number, gen: data.gen as number }
  return null
}

const isU32 = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffff_ffff

/// Drain a session's per-frame timing samples. Delegates straight to the addon;
/// the registry drains its accumulator and returns the ms summaries.
export function takeTimingsPreviewGpu(backend: NativeDecode, sessionId: string): PreviewGpuTimingReport {
  return backend.previewGpuTakeTimings(sessionId)
}
