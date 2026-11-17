import { describe, expect, it } from 'vitest';
import { exportReadbackFrames, sinkBytesPerPixel } from './export-resources';

describe('native sink frames', () => {
  it('sizes each layout as ffmpeg reads one rawvideo frame of it', () => {
    const [w, h] = [1920, 1080];
    expect(w * h * sinkBytesPerPixel('yuv420p')).toBe(w * h + 2 * (w / 2) * (h / 2));
    expect(w * h * sinkBytesPerPixel('yuv420p10le')).toBe(2 * (w * h + 2 * (w / 2) * (h / 2)));
    expect(w * h * sinkBytesPerPixel('yuv422p')).toBe(w * h + 2 * (w / 2) * h);
    expect(w * h * sinkBytesPerPixel('yuv422p10le')).toBe(2 * (w * h + 2 * (w / 2) * h));
  });

  it('reads every frame back before the next while a Motif plays', () => {
    expect(exportReadbackFrames({ hasMotifs: true, frameBytes: 64 * 64 * 1.5 })).toBe(1);
  });

  it('batches fewer frames as they grow, and always at least one', () => {
    const depth = (w: number, h: number, pixFmt: Parameters<typeof sinkBytesPerPixel>[0]) =>
      exportReadbackFrames({ hasMotifs: false, frameBytes: w * h * sinkBytesPerPixel(pixFmt) });
    expect(depth(1920, 1080, 'yuv420p')).toBeGreaterThan(1);
    expect(depth(3840, 2160, 'yuv420p')).toBeLessThan(depth(1920, 1080, 'yuv420p'));
    expect(depth(3840, 2160, 'yuv422p10le')).toBeLessThanOrEqual(depth(3840, 2160, 'yuv420p'));
    expect(depth(7680, 4320, 'yuv422p10le')).toBe(1);
  });
});
