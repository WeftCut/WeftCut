import type { PreviewGpuBudgetSnapshot } from '../shared/ipc'
import { MIB, PERFORMANCE_DEFAULTS, performanceSettings, previewGpuReferenceFps, type PerformanceSettings } from '../shared/performance-settings'
import { createGpuBufferBudget, type GpuBufferBudget, type GpuBufferLease } from './gpuBufferBudget'

export const PREVIEW_GPU_MAX_SESSIONS = PERFORMANCE_DEFAULTS.preview_gpu_sessions
// Admission currency is coded pixel AREA (30fps-calibrated), not bytes — but
// area implies pool VRAM: slot bytes = area × 4 (RGBA8) × poolSize (3 by
// default), i.e. this cap fully subscribed ≈ 3×(3840×2160) × 4B × 3 slots ≈
// 299MB of shared pool. The live number (not this arithmetic) is
// `hwBudget().slotVram` / takeTimings' `poolSlotBytes`.
export const PREVIEW_GPU_MAX_CODED_PIXEL_AREA = PERFORMANCE_DEFAULTS.preview_gpu_pixel_area

export interface PreviewGpuCodedSize {
  width: number
  height: number
}

export interface PreviewGpuBudgetLease {
  readonly sessionId: string
  readonly codedPixelArea: number
  readonly bufferLease: GpuBufferLease
}

export interface PreviewGpuBudgetController {
  reserve(sessionId: string, codedSize: PreviewGpuCodedSize, poolSize?: number): PreviewGpuBudgetLease | null
  release(lease: PreviewGpuBudgetLease | null | undefined, retainBuffer?: boolean): void
  /// Active decoder count and picture area. previewGpu.ts adds open-pool
  /// footprint; the shared byte allocator also accounts for retired imports.
  snapshot(): Omit<PreviewGpuBudgetSnapshot, 'slotVram'>
}

export function createPreviewGpuBudget(getSettings: () => PerformanceSettings = performanceSettings,
  buffers: GpuBufferBudget = createGpuBufferBudget(() => getSettings().gpu_buffer_mib * MIB)): PreviewGpuBudgetController {
  const leases = new Map<string, PreviewGpuBudgetLease>()
  let usedCodedPixelArea = 0

  return {
    reserve(sessionId, codedSize, poolSize = getSettings().preview_gpu_pool_slots) {
      const limits = getSettings()
      if (leases.has(sessionId)) return null
      if (leases.size >= limits.preview_gpu_sessions) return null
      if (
        !Number.isSafeInteger(codedSize.width)
        || !Number.isSafeInteger(codedSize.height)
        || codedSize.width <= 0
        || codedSize.height <= 0
      ) {
        return null
      }
      const codedPixelArea = codedSize.width * codedSize.height
      if (!Number.isSafeInteger(codedPixelArea)) return null
      if (usedCodedPixelArea + codedPixelArea > limits.preview_gpu_pixel_area) return null
      if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 16) return null
      const bufferLease = buffers.reserve('preview', codedPixelArea * 4 * poolSize)
      if (!bufferLease) return null
      const lease = Object.freeze({
        sessionId,
        codedPixelArea,
        bufferLease,
      })
      leases.set(sessionId, lease)
      usedCodedPixelArea += codedPixelArea
      return lease
    },

    release(lease, retainBuffer = false) {
      if (!lease || leases.get(lease.sessionId) !== lease) return
      leases.delete(lease.sessionId)
      usedCodedPixelArea -= lease.codedPixelArea
      if (!retainBuffer) buffers.release(lease.bufferLease)
    },

    snapshot() {
      const limits = getSettings()
      return {
        currency: 'coded-pixel-area',
        sessions: { used: leases.size, max: limits.preview_gpu_sessions },
        codedPixelArea: {
          used: usedCodedPixelArea,
          max: limits.preview_gpu_pixel_area,
          calibratedFps: previewGpuReferenceFps(),
        },
      }
    },
  }
}
