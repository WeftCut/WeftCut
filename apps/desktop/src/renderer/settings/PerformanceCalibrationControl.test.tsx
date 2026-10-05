// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { PerformanceCalibrationControl } from './PerformanceCalibrationControl';
import { PLAYBACK_CALIBRATION, playbackCalibrationRecommendation, type CalibrationSnapshot } from '../../shared/playback-calibration';

vi.mock('../state/playbackStore', () => ({ transportPause: vi.fn() }));
const profile = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({
  count, status: count <= 3 ? 'pass' : 'slow', reasons: [],
})))!;
const onApply = vi.fn().mockResolvedValue(true), onRunning = vi.fn(), onError = vi.fn();
const api = { status: vi.fn(), start: vi.fn(), cancel: vi.fn() };
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', { configurable: true, value: { performanceCalibration: api } });
  api.status.mockResolvedValue({ available: true, running: false,
    report: { state: 'complete', cells: [], recommendation: profile } } satisfies CalibrationSnapshot);
});
afterEach(cleanup);

it('requires explicit application and allows reapplying after Restore defaults', async () => {
  const user = userEvent.setup();
  const props = { disabled: false, onApply, onRunning, onError };
  const { rerender } = render(<PerformanceCalibrationControl {...props} accepted={null} />);
  const apply = await screen.findByRole('button', { name: 'Use test presets' });
  expect(onApply).not.toHaveBeenCalled();
  await user.click(apply);
  expect(onApply).toHaveBeenCalledWith(profile);
  rerender(<PerformanceCalibrationControl {...props} accepted={profile} />);
  expect((await screen.findByRole('button', { name: 'Applied' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<PerformanceCalibrationControl {...props} accepted={null} />);
  expect((await screen.findByRole('button', { name: 'Use test presets' }) as HTMLButtonElement).disabled).toBe(false);
});

it('offers no apply action for invalid results', async () => {
  api.status.mockResolvedValue({ available: true, running: false, report: { state: 'error', cells: [], recommendation: null } });
  render(<PerformanceCalibrationControl disabled={false} onApply={onApply} onRunning={onRunning} onError={onError} />);
  await screen.findByText('The test could not produce a valid result. Settings were not changed; you can retry.');
  expect(screen.queryByRole('button', { name: 'Use test presets' })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
});
