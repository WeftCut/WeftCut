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

it('requires explicit saving and allows saving again after clearing a record', async () => {
  const user = userEvent.setup();
  const props = { disabled: false, onApply, onRunning, onError };
  const { rerender } = render(<PerformanceCalibrationControl {...props} accepted={null} />);
  const apply = await screen.findByRole('button', { name: 'Save recommendation' });
  expect(onApply).not.toHaveBeenCalled();
  await user.click(apply);
  expect(onApply).toHaveBeenCalledWith(profile);
  rerender(<PerformanceCalibrationControl {...props} accepted={profile} />);
  expect((await screen.findByRole('button', { name: 'Recommendation saved' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<PerformanceCalibrationControl {...props} accepted={null} />);
  expect((await screen.findByRole('button', { name: 'Save recommendation' }) as HTMLButtonElement).disabled).toBe(false);
});

it('allows a new run with the same result to refresh the saved provenance', async () => {
  const user = userEvent.setup();
  render(<PerformanceCalibrationControl disabled={false} accepted={profile} onApply={onApply} onRunning={onRunning} onError={onError} />);
  const save = await screen.findByRole('button', { name: 'Save recommendation' });
  expect((save as HTMLButtonElement).disabled).toBe(false);
  await user.click(save);
  expect(onApply).toHaveBeenCalledOnce();
  api.start.mockResolvedValue({ available: true, running: false, report: { state: 'complete', cells: [], recommendation: profile } });
  await user.click(screen.getByRole('button', { name: 'Run benchmark' }));
  await user.click(await screen.findByRole('button', { name: 'Save recommendation' }));
  expect(onApply).toHaveBeenCalledTimes(2);
});

it('offers no apply action for invalid results', async () => {
  api.status.mockResolvedValue({ available: true, running: false, report: { state: 'error', cells: [], recommendation: null } });
  render(<PerformanceCalibrationControl disabled={false} onApply={onApply} onRunning={onRunning} onError={onError} />);
  await screen.findByText('Test failed. Please retry.');
  expect(screen.queryByRole('button', { name: 'Save recommendation' })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
});

it('shows first-use preparation and allows cancelling it', async () => {
  api.status.mockResolvedValue({ available: true, running: true, report: { state: 'preparing-media', cells: [] } });
  api.cancel.mockResolvedValue({ available: true, running: false, report: { state: 'cancelled', cells: [], recommendation: null } });
  render(<PerformanceCalibrationControl disabled={false} onApply={onApply} onRunning={onRunning} onError={onError} />);
  await screen.findByText('Preparing test media… The first run may take a few minutes.');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel test' }));
  expect(api.cancel).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
});
