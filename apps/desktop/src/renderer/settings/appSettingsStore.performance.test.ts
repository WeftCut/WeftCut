// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { APP_SETTINGS_DEFAULTS, type AppSettings } from "../../shared/app-settings";
import { PERFORMANCE_DEFAULTS, performanceSettings } from "../../shared/performance-settings";
import { frameRingByteBudget } from "../render/decoder/frameRingBudget";
import { useAppSettingsStore, wireAppSettingsStream } from "./appSettingsStore";
import { resolveResourcePolicy, DEFAULT_RESOURCE_POLICY } from '../../shared/resource-policy';

const mocks = vi.hoisted(() => ({ get: vi.fn(), listen: vi.fn() }));
vi.mock("../ipc", () => ({
  APP_SETTINGS_EVENTS: { changed: "app_settings:changed" },
  appSettingsGet: mocks.get,
  appSettingsSet: vi.fn(),
}));
vi.mock("@/bridge/events", () => ({ listen: mocks.listen }));
vi.mock("../search/searchIndexStore", () => ({ onDescribeViewChanged: vi.fn() }));

afterEach(() => {
  useAppSettingsStore.getState().hydrate(APP_SETTINGS_DEFAULTS);
  vi.clearAllMocks();
});

function settings(sessions: number, mib: number): AppSettings {
  return { ...APP_SETTINGS_DEFAULTS, resource_allocation: resolveResourcePolicy({ ...DEFAULT_RESOURCE_POLICY, memory_mib: 32768 }), performance_policy: null, language: "en-US", performance: {
    ...PERFORMANCE_DEFAULTS, preview_gpu_sessions: sessions, frame_ring_mib: mib,
  } };
}

it("hydrates runtime readers on startup and on another window's settings event", async () => {
  let changed!: (event: { payload: AppSettings }) => void;
  const unlisten = vi.fn();
  mocks.listen.mockImplementation(async (_name, callback) => { changed = callback; return unlisten; });
  mocks.get.mockResolvedValue(settings(2, 256));
  const stop = await wireAppSettingsStream();
  expect(performanceSettings().preview_gpu_sessions).toBe(2);
  const initialBudget = frameRingByteBudget();
  // The app policy now permits borrowing idle cache shares. Legacy partition
  // values are retained, but are no longer the exclusive video-ring allowance.
  expect(performanceSettings().frame_ring_mib).toBe(256);
  expect(initialBudget).toBeGreaterThanOrEqual(256 * 1024 * 1024);
  changed({ payload: settings(8, 2048) });
  expect(performanceSettings().preview_gpu_sessions).toBe(8);
  expect(performanceSettings().frame_ring_mib).toBe(2048);
  expect(frameRingByteBudget()).toBeGreaterThan(initialBudget);
  expect(frameRingByteBudget()).toBeLessThanOrEqual(settings(8, 2048).resource_allocation!.cache_mib * 1024 * 1024);
  stop();
  expect(unlisten).toHaveBeenCalledTimes(2);
});

it("does not overwrite a new budget event with an older startup response", async () => {
  let changed!: (event: { payload: AppSettings }) => void;
  let seed!: (value: AppSettings) => void;
  mocks.listen.mockImplementation(async (_name, callback) => { changed = callback; return () => {}; });
  mocks.get.mockImplementation(() => new Promise<AppSettings>(resolve => { seed = resolve; }));
  const wiring = wireAppSettingsStream();
  await vi.waitFor(() => expect(seed).toBeDefined());
  changed({ payload: settings(8, 2048) });
  seed(settings(2, 256));
  const stop = await wiring;
  expect(performanceSettings().preview_gpu_sessions).toBe(8);
  expect(useAppSettingsStore.getState().settings.performance?.frame_ring_mib).toBe(2048);
  stop();
});
