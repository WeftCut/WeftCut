import { describe, expect, it } from 'vitest';
import { PLAYBACK_CALIBRATION as protocol, playbackCalibrationRecommendation, type PlaybackCalibrationCell } from './playback-calibration';

const cells = (passThrough: number): PlaybackCalibrationCell[] => protocol.counts.map(count => ({
  count, status: count <= passThrough ? 'pass' : 'slow', reasons: [],
}));

describe('controlled playback recommendations', () => {
  it('maps only the two calibrated fields and keeps the single-4K floor', () => {
    const result = playbackCalibrationRecommendation(cells(5))!;
    expect(result.maximum).toEqual({ preview_gpu_sessions: 5, preview_gpu_pixel_area: 5 * 3840 * 2160 });
    expect(result.standard).toEqual({ preview_gpu_sessions: 3, preview_gpu_pixel_area: 3 * 3840 * 2160 });
    expect(result.less).toEqual({ preview_gpu_sessions: 1, preview_gpu_pixel_area: 3840 * 2160 });
    expect(result.conservative).toBe(false);
  });
  it('labels a measured but slow single-video fallback instead of claiming a pass', () => {
    const result = playbackCalibrationRecommendation(cells(0))!;
    expect(result.conservative).toBe(true);
    expect(result.maximum.preview_gpu_sessions).toBe(1);
    expect(result.less).toEqual(result.maximum);
  });
  it.each(['invalid', 'not-run'] as const)('does not turn %s measurements into a recommendation', status => {
    const observations = cells(8);
    observations[4]!.status = status;
    expect(playbackCalibrationRecommendation(observations)).toBeNull();
    expect(playbackCalibrationRecommendation(cells(8).slice(1))).toBeNull();
    expect(playbackCalibrationRecommendation([...cells(8), cells(8)[0]!])).toBeNull();
  });
  it('does not infer an unbroken capability envelope across contradictory results', () => {
    const observations = cells(8);
    observations[2]!.status = 'slow';
    expect(playbackCalibrationRecommendation(observations)!.maximum.preview_gpu_sessions).toBe(2);
  });
});
