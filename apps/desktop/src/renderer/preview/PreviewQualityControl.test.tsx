// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreviewQualityControl } from './PreviewQualityControl';

const state = vi.hoisted(() => ({ resolution: 'full', save: vi.fn() }));
vi.mock('../settings/appSettingsStore', () => ({ usePlaybackResolution: () => state.resolution, setPlaybackResolution: state.save }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../components/AppSelect', () => ({ AppSelect: (props: { value: string; ariaLabel: string; disabled: boolean; onValueChange(value: string): void; options: {value: string;label: string}[] }) =>
  <select aria-label={props.ariaLabel} value={props.value} disabled={props.disabled} onChange={event => props.onValueChange(event.target.value)}>
    {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select> }));
afterEach(() => { cleanup(); state.resolution = 'full'; state.save.mockReset(); });

it('exposes Original, half and quarter and writes only the preview setting', async () => {
  state.save.mockResolvedValue({}); render(<PreviewQualityControl />);
  expect(screen.getAllByRole('option')).toHaveLength(3);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'half' } });
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('half'));
  expect(state.save).toHaveBeenCalledTimes(1);
});
it('reflects changes made in Settings instead of keeping a second local setting', () => {
  const view = render(<PreviewQualityControl />); state.resolution = 'quarter'; view.rerender(<PreviewQualityControl />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('quarter');
  expect(state.save).not.toHaveBeenCalled();
});
it('shows save failures and leaves the existing mode selected', async () => {
  state.save.mockRejectedValue(new Error('synthetic disk failure')); render(<PreviewQualityControl />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'quarter' } });
  expect((await screen.findByRole('alert')).textContent).toBe('preview.quality_error');
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('full');
});
