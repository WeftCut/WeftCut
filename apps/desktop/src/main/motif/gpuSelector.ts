import type { MotifGpuProbe } from '../../shared/motifs/gpuProbe';
import { median } from '../../shared/motifs/gpuProbe';

export interface ProbeSamples { quality: boolean; gpu: number[]; png: number[] }
/** One bounded, coalesced probe per GPU-process generation. Never persisted:
 * another compositor, renderer or driver must earn its own selection. */
export class MotifGpuSelector<T = void> {
  private generation = 0;
  private pending?: Promise<boolean>;
  private result: MotifGpuProbe;
  constructor(private readonly run: (context?: T) => Promise<ProbeSamples>, private readonly enabled = true) {
    this.result = this.initial();
  }
  private initial(): MotifGpuProbe {
    return { state: this.enabled ? 'not-tested' : 'png', reason: this.enabled ? null : 'disabled', gpu_ms: null, png_ms: null, frames: 0, sampled_at: null };
  }
  snapshot(): MotifGpuProbe { return { ...this.result }; }
  reset(): void { this.generation++; this.pending = undefined; this.result = this.initial(); }
  failed(): void { this.generation++; this.pending = undefined; this.result = { ...this.result, state: 'png', reason: 'failed', sampled_at: Date.now() }; }
  ready(context?: T): Promise<boolean> {
    if (this.pending) return this.pending;
    if (this.result.state !== 'not-tested') return Promise.resolve(this.result.state === 'gpu');
    const generation = this.generation;
    this.result = { ...this.result, state: 'testing' };
    const pending = (async () => {
      let result: MotifGpuProbe;
      try {
        const samples = await this.run(context);
        if (!samples.quality) {
          if (generation === this.generation) this.result = { ...this.initial(), state: 'png', reason: 'quality', sampled_at: Date.now() };
          return false;
        }
        const gpu = median(samples.gpu), png = median(samples.png);
        const enough = samples.gpu.length >= 7 && samples.png.length >= 7;
        const quality = samples.quality && enough;
        // Demand a material benefit rather than switching on measurement noise.
        const faster = gpu <= png * .85 && png - gpu >= 1;
        result = { state: quality && faster ? 'gpu' : 'png', reason: !quality ? 'quality' : !faster ? 'slower' : null,
          gpu_ms: gpu, png_ms: png, frames: Math.min(samples.gpu.length, samples.png.length), sampled_at: Date.now() };
      } catch { result = { ...this.initial(), state: 'png', reason: 'unsupported', sampled_at: Date.now() }; }
      if (generation !== this.generation) return false;
      this.result = result;
      return result.state === 'gpu';
    })();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; });
    return pending;
  }
}
