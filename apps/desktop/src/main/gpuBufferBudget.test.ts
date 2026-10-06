import { describe, expect, it } from 'vitest';
import { createGpuBufferBudget, retainGpuBufferLease } from './gpuBufferBudget';
import { createPreviewGpuBudget } from './previewGpuBudget';
import { MIB, PERFORMANCE_DEFAULTS } from '../shared/performance-settings';

describe('shared GPU buffer allocation', () => {
  it('charges both consumers before allocation and rejects oversubscription at the exact byte boundary', () => {
    const budget = createGpuBufferBudget(() => 100);
    const video = budget.reserve('preview', 60)!;
    const motif = budget.reserve('motif', 40)!;
    expect(budget.reserve('preview', 1)).toBeNull();
    expect(budget.snapshot()).toEqual({ used_bytes: 100, limit_bytes: 100, preview_bytes: 60, motif_bytes: 40 });
    budget.release(video); budget.release(video);
    expect(budget.reserve('preview', 60)).not.toBeNull();
    budget.release(motif);
  });

  it('continues charging retired imports until the final reference and ignores duplicate callbacks', () => {
    const budget = createGpuBufferBudget(() => 100);
    const lifetime = retainGpuBufferLease(budget, budget.reserve('preview', 100)!);
    const first = lifetime.reference(), second = lifetime.reference();
    first(); first();
    expect(budget.snapshot().used_bytes).toBe(100);
    lifetime.retire(); lifetime.retire();
    expect(budget.reserve('motif', 1)).toBeNull();
    second(); second();
    expect(budget.snapshot().used_bytes).toBe(0);
    expect(budget.reserve('motif', 100)).not.toBeNull();
  });

  it('refuses new allocation after lowering the limit without revoking existing leases', () => {
    let limit = 100;
    const budget = createGpuBufferBudget(() => limit);
    const video = budget.reserve('preview', 80)!;
    limit = 60;
    expect(budget.snapshot().used_bytes).toBe(80);
    expect(budget.reserve('motif', 1)).toBeNull();
    budget.release(video);
    expect(budget.reserve('motif', 60)).not.toBeNull();
    for (const invalid of [0, -1, 1.5, Infinity, NaN]) expect(budget.reserve('preview', invalid)).toBeNull();
  });

  it('prices real slot count and prevents a diagnostic override from bypassing the memory budget', () => {
    const settings = { ...PERFORMANCE_DEFAULTS, gpu_buffer_mib: 128 };
    const buffers = createGpuBufferBudget(() => settings.gpu_buffer_mib * MIB);
    const videos = createPreviewGpuBudget(() => settings, buffers);
    const size = { width: 3840, height: 2160 };
    expect(videos.reserve('too-many-slots', size, 16)).toBeNull();
    const video = videos.reserve('normal', size, 3)!;
    expect(buffers.snapshot().preview_bytes).toBe(3840 * 2160 * 4 * 3);
    const motif = buffers.reserve('motif', 3840 * 2160 * 4)!;
    expect(motif).not.toBeNull();
    expect(videos.reserve('another', size, 1)).toBeNull();
    videos.release(video, true);
    expect(videos.snapshot().sessions.used).toBe(0);
    expect(buffers.snapshot().preview_bytes).toBeGreaterThan(0);
    buffers.release(video.bufferLease); buffers.release(motif);
    expect(videos.reserve('replacement', size, 3)).not.toBeNull();
  });
});
