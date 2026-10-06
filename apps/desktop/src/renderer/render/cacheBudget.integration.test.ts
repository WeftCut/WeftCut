import { afterEach, expect, it, vi } from 'vitest';
import { hydratePerformanceSettings, MIB } from '../../shared/performance-settings';
import { resolvePerformanceBudgets } from '../../shared/performance-budgets';
import { cacheBudget } from './cacheBudget';
import { MotifFrameCache } from './motifs/frameCache';
import { FrameRing } from './decoder/FrameRing';

afterEach(() => hydratePerformanceSettings(undefined));
const frame = (w = 1920, h = 1080) => ({ width: w, height: h, close: vi.fn() }) as unknown as ImageBitmap;

it('real video rings reclaim borrowed animation retention and both owners release their accounting', () => {
  hydratePerformanceSettings(resolvePerformanceBudgets({ cache_mib: 512, gpu_buffer_mib: 416 }), null, true);
  const animation = new MotifFrameCache(), video = new FrameRing();
  try {
    for (let i = 0; i < 50; i++) animation.setFrame('animation', i, frame());
    // With idle video/tiles, animation can exceed its ~151 MiB baseline share.
    expect(animation.size()).toBe(50);
    for (let i = 0; i < 10; i++) video.push(frame(3840, 2160), i * 33333, 33333);
    expect(animation.size()).toBeLessThan(30);
    expect(video.size()).toBe(10);
    expect(cacheBudget.snapshot().total).toBeLessThanOrEqual(512 * MIB);
  } finally { animation.dispose(); video.dispose(); }
  expect(cacheBudget.snapshot().total).toBe(0);
});

it('a pinned retired animation picture stays accounted until its final release', () => {
  hydratePerformanceSettings(resolvePerformanceBudgets({ cache_mib: 512, gpu_buffer_mib: 416 }), null, true);
  const animation = new MotifFrameCache(), picture = frame();
  try {
    animation.setFrame('animation', 0, picture);
    animation.retain(picture);
    animation.clearAll();
    expect(cacheBudget.snapshot().total).toBe(1920 * 1080 * 4);
    expect(picture.close).not.toHaveBeenCalled();
    animation.release(picture);
    expect(cacheBudget.snapshot().total).toBe(0);
    expect(picture.close).toHaveBeenCalledOnce();
  } finally { animation.dispose(); }
});
