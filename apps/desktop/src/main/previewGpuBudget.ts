import type { PreviewGpuBudgetSnapshot } from '../shared/ipc'
import { PERFORMANCE_DEFAULTS, performanceSettings, type PerformanceSettings } from '../shared/performance-settings'

export const PREVIEW_GPU_MAX_SESSIONS = PERFORMANCE_DEFAULTS.preview_gpu_sessions
// Admission currency is coded pixel AREA (30fps-calibrated), not bytes — but
// area implies pool VRAM: slot bytes = area × 4 (RGBA8) × poolSize (3 by
// default), i.e. this cap fully subscribed ≈ 3×(3840×2160) × 4B × 3 slots ≈
// 299MB of shared pool. The live number (not this arithmetic) is
// `hwBudget().slotVram` / takeTimings' `poolSlotBytes`.
export const PREVIEW_GPU_MAX_CODED_PIXEL_AREA = PERFORMANCE_DEFAULTS.preview_gpu_pixel_area
export const PREVIEW_GPU_BUDGET_CALIBRATED_FPS = 30

export interface PreviewGpuCodedSize {
  width: number
  height: number
}

export interface PreviewGpuBudgetLease {
  readonly sessionId: string
  readonly codedPixelArea: number
}

export interface PreviewGpuBudgetController {
  reserve(sessionId: string, codedSize: PreviewGpuCodedSize): PreviewGpuBudgetLease | null
  release(lease: PreviewGpuBudgetLease | null | undefined): void
  /// Everything admission knows. `slotVram` is deliberately absent: leases
  /// carry coded area, not pool sizes — previewGpu.ts merges the live VRAM sum
  /// from its session records (the only place slot counts exist).
  snapshot(): Omit<PreviewGpuBudgetSnapshot, 'slotVram'>
}

export function createPreviewGpuBudget(getSettings: () => PerformanceSettings = performanceSettings): PreviewGpuBudgetController {
  const leases = new Map<string, PreviewGpuBudgetLease>()
  let usedCodedPixelArea = 0

  return {
    reserve(sessionId, codedSize) {
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
      const lease = Object.freeze({
        sessionId,
        codedPixelArea,
      })
      leases.set(sessionId, lease)
      usedCodedPixelArea += codedPixelArea
      return lease
    },

    release(lease) {
      if (!lease || leases.get(lease.sessionId) !== lease) return
      leases.delete(lease.sessionId)
      usedCodedPixelArea -= lease.codedPixelArea
    },

    snapshot() {
      const limits = getSettings()
      return {
        currency: 'coded-pixel-area',
        sessions: { used: leases.size, max: limits.preview_gpu_sessions },
        codedPixelArea: {
          used: usedCodedPixelArea,
          max: limits.preview_gpu_pixel_area,
          calibratedFps: PREVIEW_GPU_BUDGET_CALIBRATED_FPS,
        },
      }
    },
  }
}
