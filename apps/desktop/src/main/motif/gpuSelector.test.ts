import { expect, it, vi } from 'vitest';
import { MotifGpuSelector } from './gpuSelector';
import { sameRgba } from '../../shared/motifs/gpuProbe';
const fast = () => ({ quality: true, gpu: Array(7).fill(20), png: Array(7).fill(100) });
it('selects GPU only for exact quality and a material measured benefit', async () => {
  const run = vi.fn(async () => fast()), selector = new MotifGpuSelector(run);
  expect(selector.snapshot().state).toBe('not-tested');
  expect(await selector.ready()).toBe(true); expect(await selector.ready()).toBe(true);
  expect(run).toHaveBeenCalledOnce(); expect(selector.snapshot()).toMatchObject({ state: 'gpu', gpu_ms: 20, png_ms: 100, frames: 7 });
  for (const values of [{ ...fast(), quality: false }, { ...fast(), gpu: Array(7).fill(90) }, { ...fast(), gpu: [20] }]) {
    const rejected = new MotifGpuSelector(async () => values);
    expect(await rejected.ready()).toBe(false); expect(rejected.snapshot().state).toBe('png');
  }
});
it('rejects failed, empty or invalid measurements and explicit disablement', async () => {
  for (const run of [async () => { throw Error('No GBM surface'); }, async () => ({ ...fast(), gpu: [NaN] }), async () => ({ ...fast(), png: [] })]) {
    const selector = new MotifGpuSelector(run); expect(await selector.ready()).toBe(false);
  }
  const run = vi.fn(async () => fast()), selector = new MotifGpuSelector(run, false);
  expect(await selector.ready()).toBe(false); expect(run).not.toHaveBeenCalled();
});
it('coalesces concurrent probes and never applies a result from a retired GPU generation', async () => {
  let finish!: (v: ReturnType<typeof fast>) => void;
  const run = vi.fn(() => new Promise<ReturnType<typeof fast>>(resolve => { finish = resolve; }));
  const selector = new MotifGpuSelector(run), first = selector.ready(), second = selector.ready();
  expect(first).toBe(second); expect(run).toHaveBeenCalledOnce();
  selector.reset(); finish(fast()); expect(await first).toBe(false);
  expect(selector.snapshot().state).toBe('not-tested');
  const third = selector.ready(); finish(fast()); expect(await third).toBe(true);
  selector.failed(); expect(await selector.ready()).toBe(false);
});
it('requires exact RGBA equality including alpha and rejects empty images', () => {
  expect(sameRgba(new Uint8ClampedArray([2, 3, 4, 153]), new Uint8ClampedArray([2, 3, 4, 153]))).toBe(true);
  expect(sameRgba(new Uint8ClampedArray([2, 3, 4, 153]), new Uint8ClampedArray([2, 3, 4, 154]))).toBe(false);
  expect(sameRgba(new Uint8ClampedArray(), new Uint8ClampedArray())).toBe(false);
});
