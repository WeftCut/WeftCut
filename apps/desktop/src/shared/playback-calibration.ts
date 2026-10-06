import { MIB, PERFORMANCE_DEFAULTS } from './performance-settings.ts';

/** Fixed experimental protocol. Changing any measurement rule requires a version bump. */
export const PLAYBACK_CALIBRATION = Object.freeze({
  version: 1, codec: 'h264', width: 3840, height: 2160, fps: 60,
  durationUs: 20_000_000, startUs: 2_000_000, warmupMs: 1500, sampleMs: 8000,
  counts: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
  // Experimental screening thresholds, not a sustained-stability guarantee.
  maxAnomalyRatio: .02, maxHeldMs: 100,
  outputWidth: 1280, outputHeight: 720,
  performance: Object.freeze({ ...PERFORMANCE_DEFAULTS,
    // Isolated test must fit all eight 4K triple-buffered videos plus the
    // shipping animation allowance. The fixed protocol never changes with user
    // budgets; the parent reserves capacity for the full run before launch.
    gpu_buffer_mib: Math.ceil((8 * 3840 * 2160 * 4 * 3 / MIB + PERFORMANCE_DEFAULTS.motif_gpu_mib) / 16) * 16,
    preview_gpu_sessions: 8, preview_gpu_pixel_area: 8 * 3840 * 2160 }),
});

export interface PlaybackCalibrationCell {
  count: number;
  status: 'pass' | 'slow' | 'invalid' | 'not-run';
  reasons: string[];
}

export type CalibrationRecommendation = NonNullable<ReturnType<typeof playbackCalibrationRecommendation>>;
export interface CalibrationReport {
  state: string;
  cells: PlaybackCalibrationCell[];
  recommendation?: CalibrationRecommendation | null;
  error?: string;
  elapsedMs?: number;
}
export interface CalibrationSnapshot {
  available: boolean;
  unavailableReason?: 'platform' | 'fixture';
  running: boolean;
  report: CalibrationReport | null;
}

/** Persist only a valid, internally consistent two-field preset family. */
export function readCalibrationRecommendation(value: unknown): CalibrationRecommendation | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as CalibrationRecommendation;
  const count = input.maximum?.preview_gpu_sessions;
  if (!Number.isInteger(count) || count < 1 || count > 8 || typeof input.conservative !== 'boolean') return null;
  const expected = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(n => ({
    count: n, status: n <= (input.conservative ? 0 : count) ? 'pass' : 'slow', reasons: [],
  })))!;
  if (input.reference !== expected.reference) return null;
  for (const tier of ['less', 'standard', 'maximum'] as const) {
    if (input[tier]?.preview_gpu_sessions !== expected[tier].preview_gpu_sessions
      || input[tier]?.preview_gpu_pixel_area !== expected[tier].preview_gpu_pixel_area) return null;
  }
  return expected;
}

/** Only the two calibrated fields. Never replace cache or texture-pool settings. */
export function playbackCalibrationRecommendation(cells: readonly PlaybackCalibrationCell[]) {
  const complete = cells.length === PLAYBACK_CALIBRATION.counts.length
    && PLAYBACK_CALIBRATION.counts.every(count => cells.filter(c => c.count === count).length === 1);
  if (!complete || cells.some(c => c.status === 'invalid' || c.status === 'not-run')) return null;
  // Do not claim a stable envelope across holes (e.g. 2 fails but 3 happens to pass).
  let maximum = 0;
  for (const count of PLAYBACK_CALIBRATION.counts) {
    if (cells.find(c => c.count === count)?.status !== 'pass') break;
    maximum = count;
  }
  const conservative = maximum === 0;
  maximum = Math.max(1, maximum);
  const budget = (fraction: number) => {
    const count = Math.max(1, Math.floor(maximum * fraction));
    return { preview_gpu_sessions: count, preview_gpu_pixel_area: count * 3840 * 2160 };
  };
  return { conservative, reference: 'H.264 4K/60fps',
    less: budget(1 / 3), standard: budget(2 / 3), maximum: budget(1) };
}
