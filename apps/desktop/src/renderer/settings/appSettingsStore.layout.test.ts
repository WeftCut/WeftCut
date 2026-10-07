// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { APP_SETTINGS_DEFAULTS, type AppSettings } from '../../shared/app-settings';
import { useAppSettingsStore, wireAppSettingsStream, setAppSettings } from './appSettingsStore';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), listen: vi.fn() }));
vi.mock('../ipc', () => ({
  APP_SETTINGS_EVENTS: { changed: 'app_settings:changed' },
  appSettingsGet: mocks.get, appSettingsSet: mocks.set,
}));
vi.mock('@/bridge/events', () => ({ listen: mocks.listen }));
vi.mock('../search/searchIndexStore', () => ({ onDescribeViewChanged: vi.fn() }));

afterEach(() => {
  useAppSettingsStore.getState().hydrate(APP_SETTINGS_DEFAULTS);
  vi.clearAllMocks();
});

it('applies the saved theme at boot, a local edit and an external settings event to portal ancestors', async () => {
  let changed!: (event: { payload: AppSettings }) => void;
  mocks.listen.mockImplementation(async (_name, callback) => { changed = callback; return () => {}; });
  mocks.get.mockResolvedValue({ ...APP_SETTINGS_DEFAULTS, language: 'en-US', layout_theme: '2k-wide' });
  const stop = await wireAppSettingsStream();
  const root = document.documentElement;
  expect(root.dataset.layoutTheme).toBe('2k-wide');
  expect(root.style.getPropertyValue('--layout-font-scale')).toBe('1.32');
  expect(root.style.getPropertyValue('--layout-width-scale')).toBe('1.5');
  mocks.set.mockResolvedValue({ ...APP_SETTINGS_DEFAULTS, layout_theme: '4k-standard' });
  await setAppSettings({ layout_theme: '4k-standard' });
  expect(root.dataset.layoutTheme).toBe('4k-standard');
  changed({ payload: { ...APP_SETTINGS_DEFAULTS, layout_theme: '1080p-standard' } });
  expect(root.style.getPropertyValue('--layout-font-scale')).toBe('1');
  expect(root.style.getPropertyValue('--layout-width-scale')).toBe('1');
  stop();
});
