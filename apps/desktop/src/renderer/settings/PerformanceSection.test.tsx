// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { APP_SETTINGS_DEFAULTS, type AppSettings, type AppSettingsPatch } from '../../shared/app-settings';
import { BASELINE_BUDGETS, DEFAULT_PERFORMANCE_POLICY, patchPerformancePolicy, resolvePerformancePolicy } from '../../shared/performance-policy';
import { PerformanceSection } from './PerformanceSection';
import { useAppSettingsStore } from './appSettingsStore';
import i18n from '../i18n';
import { readResourcePolicy, patchResourcePolicy, resolveResourcePolicy } from '../../shared/resource-policy';

const mocks = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../ipc', () => ({ APP_SETTINGS_EVENTS: { changed: 'changed' }, appSettingsGet: vi.fn(), appSettingsSet: mocks.set }));
vi.mock('../state/playbackStore', () => ({ transportPause: vi.fn() }));
vi.mock('../search/searchIndexStore', () => ({ onDescribeViewChanged: vi.fn() }));
const info = vi.fn(), onError = vi.fn();
let store: { get(): AppSettings; apply(patch: AppSettingsPatch): AppSettings };
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en-US');
  let settings: AppSettings = { ...APP_SETTINGS_DEFAULTS };
  store = { get: () => settings, apply: patch => {
    const policy = patch.performance_action === 'restore_defaults' ? { ...DEFAULT_PERFORMANCE_POLICY, ...BASELINE_BUDGETS }
      : patchPerformancePolicy(settings.performance_policy!, patch.performance_policy ?? {});
    const resolved = resolvePerformancePolicy(policy, 32768);
    settings = { ...settings, performance_policy: policy, performance_budget: resolved.budgets,
      performance: resolved.performance, decode_engine: patch.decode_engine ?? settings.decode_engine };
    if (patch.resource_policy !== undefined) settings.resource_policy = patchResourcePolicy(readResourcePolicy(settings.resource_policy), patch.resource_policy);
    settings.resource_allocation = resolveResourcePolicy(readResourcePolicy(settings.resource_policy), 32768, 8);
    return settings;
  } };
  useAppSettingsStore.getState().hydrate(store.get());
  mocks.set.mockImplementation(async patch => store.apply(patch));
  info.mockResolvedValue({ total_memory_mib: 32768, gpu_buffers: { used_bytes: 0, limit_bytes: 416 * 1024 * 1024, preview_bytes: 0, motif_bytes: 0 } });
  Object.defineProperty(window, 'api', { configurable: true, value: { performanceResources: { info },
    performanceCalibration: { status: vi.fn().mockResolvedValue({ available: true, running: false, report: null }) } } });
});
afterEach(cleanup);

it('edits a budget while resource telemetry is unavailable and preserves the other budget', async () => {
  info.mockRejectedValue(new Error('unavailable'));
  const user = userEvent.setup();
  render(<PerformanceSection onError={onError} />);
  const input = screen.getByLabelText('Memory target') as HTMLInputElement;
  expect(input.disabled).toBe(false);
  await user.clear(input); await user.type(input, '4');
  await waitFor(() => expect(store.get().resource_policy?.memory_mib).toBe(4096));
  expect(store.get().performance_policy?.gpu_buffer_mib).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(input.disabled).toBe(false);
});

it('does not clobber ongoing input with an older save response', async () => {
  let release!: () => void;
  mocks.set.mockImplementationOnce(patch => new Promise(resolve => { release = () => resolve(store.apply(patch)); }));
  const user = userEvent.setup();
  render(<PerformanceSection onError={onError} />);
  const input = screen.getByLabelText('Memory target') as HTMLInputElement;
  await user.clear(input); await user.type(input, '4');
  await waitFor(() => expect(release).toBeDefined());
  await user.clear(input); await user.type(input, '8');
  await act(async () => release());
  expect(input.value).toBe('8');
  expect(document.activeElement).toBe(input);
  await waitFor(() => expect(store.get().resource_policy?.memory_mib).toBe(8192));
});

it('keeps a failed edit visibly unsaved and allows retrying the same value', async () => {
  mocks.set.mockRejectedValueOnce(new Error('disk full'));
  const user = userEvent.setup();
  render(<PerformanceSection onError={onError} />);
  const input = screen.getByLabelText('Memory target') as HTMLInputElement;
  await user.clear(input); await user.type(input, '4');
  await waitFor(() => expect(onError).toHaveBeenCalledWith('Error: disk full'));
  expect(input.value).toBe('4');
  expect(store.get().performance_policy?.cache_mib).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Retry save' }));
  await waitFor(() => expect(store.get().resource_policy?.memory_mib).toBe(4096));
});

it('shows diagnostics as read-only details and restores default values without changing decode engine', async () => {
  const user = userEvent.setup();
  store.apply({ performance_policy: { cache_mib: 2304 }, decode_engine: 'webcodecs' });
  useAppSettingsStore.getState().hydrate(store.get());
  render(<PerformanceSection onError={onError} />);
  const before = store.get();
  await user.click(screen.getByRole('button', { name: 'Resource usage details' }));
  expect(store.get()).toEqual(before);
  expect(screen.getAllByRole('textbox')).toHaveLength(2);
  expect(screen.getByRole('combobox', { name: 'Processing effort' })).toBeDefined();
  expect(screen.queryByLabelText('Concurrent decoders')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
  await waitFor(() => expect(store.get().performance_budget).toEqual(BASELINE_BUDGETS));
  expect(store.get().decode_engine).toBe('webcodecs');
});
