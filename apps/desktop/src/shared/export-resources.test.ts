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

  it('reads every frame back before the next while a Motif plays, and batches otherwise', () => {
    expect(exportReadbackFrames(true)).toBe(1);
    expect(exportReadbackFrames(false)).toBeGreaterThan(1);
  });
});
