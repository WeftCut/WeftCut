/** Local evidence, never project settings or a promise of whole-export speed. */
export interface MotifGpuProbe {
  state: 'not-tested' | 'testing' | 'gpu' | 'png';
  reason: 'disabled' | 'unsupported' | 'quality' | 'slower' | 'failed' | null;
  gpu_ms: number | null;
  png_ms: number | null;
  frames: number;
  sampled_at: number | null;
}
export function sameRgba(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (!a.length || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function median(samples: number[]): number {
  if (!samples.length || samples.some(v => !Number.isFinite(v) || v <= 0)) throw new Error('Invalid GPU probe timings');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
