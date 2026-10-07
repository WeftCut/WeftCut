import { describe, it, expect, vi } from 'vitest'
import { createAppSettingsStore, type AppSettingsFs } from './app-settings'
import { APP_SETTINGS_DEFAULTS } from '../shared/app-settings'
import { LAYOUT_THEME_IDS } from '../shared/layout-theme'
import { PERFORMANCE_DEFAULTS } from '../shared/performance-settings'
import { playbackCalibrationRecommendation, PLAYBACK_CALIBRATION } from '../shared/playback-calibration'
import { resolvePerformanceBudgets } from '../shared/performance-budgets'
import { automaticPerformanceBudgets, DEFAULT_PERFORMANCE_POLICY } from '../shared/performance-policy'

const PATH = '/cfg/app_settings.json'
const DIR = '/cfg'

describe('layout theme persistence', () => {
  it.each([undefined, 'unknown', null, 42, '__proto__'])('recovers legacy/invalid theme %s to 1080p standard', value => {
    const { fs } = memFs({ [PATH]: JSON.stringify({ layout_theme: value }) });
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().layout_theme).toBe('1080p-standard');
  });

  it('persists all presets across restart and preserves unrelated preferences', () => {
    const { fs, files } = memFs();
    const deps = { fs, path: PATH, dir: DIR };
    const store = createAppSettingsStore(deps);
    store.apply({ language: 'zh-CN' });
    for (const layout_theme of LAYOUT_THEME_IDS) {
      store.apply({ layout_theme });
      expect(createAppSettingsStore(deps).get()).toMatchObject({ layout_theme, language: 'zh-CN' });
    }
    const before = files.get(PATH);
    expect(() => store.apply({ layout_theme: 'invalid' as never })).toThrow('Invalid layout theme');
    expect(files.get(PATH)).toBe(before);
  });
});

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: AppSettingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}
const store = (seed?: Record<string, string>) => createAppSettingsStore({ ...memFs(seed), path: PATH, dir: DIR })

describe('app-settings store', () => {
  it('merges resource intent across windows, reprojects on restart and never reinterprets legacy caches', () => {
    const { fs, files } = memFs();
    const a = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 8192, cores: 4 });
    const b = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 8192, cores: 4 });
    a.apply({ performance: { frame_ring_mib: 700 } });
    const legacy = a.get().performance;
    a.apply({ resource_policy: { memory_mib: 4096 } });
    b.apply({ resource_policy: { processing: 'low' } });
    expect(a.get().resource_policy).toMatchObject({ memory_mib: 4096, processing: 'low' });
    expect(a.get().performance).toEqual(legacy);
    const restarted = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 65536, cores: 32 });
    expect(restarted.get().resource_allocation).toMatchObject({ memory_mib: 4096, cpu_threads: 8 });
    const before = files.get(PATH);
    expect(() => a.apply({ resource_policy: { memory_mib: -1 } })).toThrow();
    expect(files.get(PATH)).toBe(before);
  });
  it('persists advanced limits, keeps manual budgets across hardware changes and resets all overrides', () => {
    const { fs } = memFs()
    const deps = { fs, path: PATH, dir: DIR, totalMemoryMiB: 65536, gpuMemoryMiB: 16384 }
    const s = createAppSettingsStore(deps)
    expect(s.get().performance_budget).toEqual({ cache_mib: 3456, gpu_buffer_mib: 2048 })
    s.apply({ performance_policy: { gpu_buffer_mib: 4096, decoder_limit: 12, buffer_frames: 6 } })
    const reload = createAppSettingsStore({ ...deps, gpuMemoryMiB: 8192 })
    expect(reload.get().performance).toMatchObject({ gpu_buffer_mib: 4096, preview_gpu_sessions: 12, preview_gpu_pool_slots: 6 })
    reload.apply({ performance_action: 'restore_defaults' })
    expect(reload.get().performance).toMatchObject({ gpu_buffer_mib: 1024, preview_gpu_sessions: 5, preview_gpu_pool_slots: 3 })
  })
  it('keeps independent automatic modes across writers, restarts and hardware capacity changes', () => {
    const { fs } = memFs()
    const a = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 32768 })
    const b = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 32768 })
    a.apply({ performance_policy: { cache_mib: 2304 } })
    b.apply({ performance_policy: { gpu_buffer_mib: 768 }, language: 'zh-CN' })
    expect(a.get().performance_policy).toEqual({ ...DEFAULT_PERFORMANCE_POLICY, cache_mib: 2304, gpu_buffer_mib: 768 })
    a.apply({ performance_policy: { cache_mib: null } })
    const small = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 4096 })
    expect(small.get().performance_budget).toEqual({ cache_mib: 512, gpu_buffer_mib: 768 })
    expect(small.get().language).toBe('zh-CN')
  })

  it('saves tests without changing runtime, restores a snapshot, and resets without deleting evidence', () => {
    const { fs } = memFs()
    const deps = { fs, path: PATH, dir: DIR, totalMemoryMiB: 32768, machineId: 'test-machine', appVersion: '1', now: () => '2026-01-01T00:00:00Z' }
    const s = createAppSettingsStore(deps)
    const recommendation = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: count <= 5 ? 'pass' : 'slow', reasons: [] })))!
    s.apply({ performance_policy: { cache_mib: 2304, gpu_buffer_mib: 768 } })
    const before = s.get().performance
    s.apply({ performance_test_recommendation: recommendation })
    expect(s.get().performance).toEqual(before)
    const record = s.get().performance_test_profile!
    expect(record).toMatchObject({ machine_id: 'test-machine', app_version: '1', saved_at: deps.now(), budgets: { cache_mib: 2304 } })
    s.apply({ performance_action: 'restore_tested' })
    expect(s.get().performance_budget).toEqual(record.budgets)
    expect(s.get().performance?.preview_gpu_pixel_area).toBe(recommendation.maximum.preview_gpu_pixel_area)
    const active = s.get().performance
    const slower = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: count <= 2 ? 'pass' : 'slow', reasons: [] })))!
    s.apply({ performance_test_recommendation: slower })
    expect(s.get().performance).toEqual(active)
    s.apply({ performance_action: 'restore_defaults' })
    expect(s.get().performance).toEqual(PERFORMANCE_DEFAULTS)
    expect(s.get().performance_policy).toEqual({ ...DEFAULT_PERFORMANCE_POLICY, ...automaticPerformanceBudgets(32768) })
    expect(s.get().performance_test_profile?.calibration).toEqual(slower)
    expect(createAppSettingsStore(deps).get()).toEqual(s.get())
    s.apply({ performance_action: 'clear_test' })
    expect(s.get().performance_test_profile).toBeNull()
    expect(() => s.apply({ performance_action: 'restore_tested' })).toThrow('No compatible')
  })

  it('retains stale test evidence and manual budgets without applying stale throughput', () => {
    const { fs } = memFs()
    const deps = { fs, path: PATH, dir: DIR, machineId: 'machine-a', appVersion: '1' }
    const s = createAppSettingsStore(deps)
    const recommendation = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: 'pass', reasons: [] })))!
    s.apply({ performance_test_recommendation: recommendation })
    s.apply({ performance_action: 'restore_tested' })
    const moved = createAppSettingsStore({ ...deps, machineId: 'machine-b' })
    expect(moved.get().performance_test_compatible).toBe(false)
    expect(moved.get().performance_test_profile).toEqual(s.get().performance_test_profile)
    expect(moved.get().performance_budget).toEqual(s.get().performance_budget)
    expect(moved.get().performance?.preview_gpu_sessions).toBe(PERFORMANCE_DEFAULTS.preview_gpu_sessions)
    expect(() => moved.apply({ performance_action: 'restore_tested' })).toThrow('No compatible')
    moved.apply({ performance_policy: { gpu_buffer_mib: 2048 } })
    expect(moved.get().performance_budget?.gpu_buffer_mib).toBe(2048)
    moved.apply({ performance_test_recommendation: recommendation })
    expect(moved.get().performance_policy?.decode).toBe('baseline')
    expect(moved.get().performance?.preview_gpu_sessions).toBe(PERFORMANCE_DEFAULTS.preview_gpu_sessions)
  })

  it('does not trust an active test when its provenance is missing or corrupt', () => {
    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const recommendation = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: 'pass', reasons: [] })))!
    s.apply({ performance_test_recommendation: recommendation })
    s.apply({ performance_action: 'restore_tested' })
    const raw = JSON.parse(files.get(PATH)!)
    files.set(PATH, JSON.stringify({ ...raw, performance_test_profile: { ...raw.performance_test_profile, saved_at: 'invalid' } }))
    expect(s.get().performance_test_profile).toBeNull()
    expect(s.get().performance?.preview_gpu_sessions).toBe(PERFORMANCE_DEFAULTS.preview_gpu_sessions)
    expect(s.get().performance_budget).toEqual(raw.performance_budget)
  })

  it('validates a policy atomically and publishes nothing when persistence fails', () => {
    const { fs, files } = memFs()
    const onCommitted = vi.fn()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR, onCommitted })
    s.apply({ performance_policy: { gpu_buffer_mib: 512 } })
    const before = files.get(PATH)
    for (const performance_policy of [{ cache_mib: -1 }, { gpu_buffer_mib: NaN }, { unknown: 1 }]) {
      expect(() => s.apply({ performance_policy } as never)).toThrow()
      expect(files.get(PATH)).toBe(before)
    }
    expect(() => s.apply({ performance_action: 'restore_defaults', performance_policy: {} })).toThrow()
    fs.rename = () => { throw new Error('disk full') }
    expect(() => s.apply({ performance_policy: { cache_mib: 2048 } })).toThrow('disk full')
    expect(onCommitted).toHaveBeenCalledTimes(1)
    expect(files.get(PATH)).toBe(before)
  })

  it('starts new installations with the machine recommendation without rewriting an old file', () => {
    const { fs, files } = memFs()
    const fresh = createAppSettingsStore({ fs, path: PATH, dir: DIR, totalMemoryMiB: 16384 })
    const budgets = automaticPerformanceBudgets(16384)
    expect(fresh.get().performance_budget).toEqual(budgets)
    expect(fresh.get().performance).toEqual(resolvePerformanceBudgets(budgets))
    files.set(PATH, JSON.stringify({ performance: { frame_ring_mib: 700, preview_gpu_pool_slots: 6 } }))
    const old = fresh.get()
    expect(old.performance_budget).toBeNull()
    expect(old.performance?.frame_ring_mib).toBe(700)
    expect(old.performance?.gpu_buffer_mib).toBe(704)
  })
  it('persists budget intent, derives consumers on reload, and preserves legacy values until adoption', () => {
    const { fs, files } = memFs({ [PATH]: JSON.stringify({ performance: { frame_ring_mib: 700, preview_gpu_pool_slots: 6 } }) })
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(s.get().performance?.frame_ring_mib).toBe(700)
    expect(s.get().performance?.preview_gpu_pool_slots).toBe(6)
    expect(s.get().performance_budget).toBeNull()
    const budgets = { cache_mib: 2048, gpu_buffer_mib: 256 }
    s.apply({ performance_budget: budgets })
    expect(s.get().performance).toEqual(resolvePerformanceBudgets(budgets))
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().performance_budget).toEqual(budgets)
    const saved = files.get(PATH)
    expect(() => s.apply({ performance_budget: { cache_mib: -1 }, language: 'zh-CN' })).toThrow('Invalid performance budgets')
    expect(files.get(PATH)).toBe(saved)
    s.apply({ performance_budget: { gpu_buffer_mib: 512 } })
    expect(s.get().performance_budget).toEqual({ cache_mib: 2048, gpu_buffer_mib: 512 })
    s.apply({ performance: { frame_ring_mib: 700 } })
    expect(s.get().performance_budget).toBeNull()
    expect(s.get().performance?.frame_ring_mib).toBe(700)
  })
  it('persists calibrated presets and applies only their two fields atomically', () => {
    const s = store()
    const profile = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({
      count, status: count <= 5 ? 'pass' : 'slow', reasons: [],
    })))!
    s.apply({ performance: { frame_ring_mib: 700, preview_gpu_pool_slots: 6 } })
    s.apply({ performance_calibration: profile, performance_calibration_tier: 'standard', performance: profile.standard })
    expect(s.get().performance_calibration).toEqual(profile)
    expect(s.get().performance).toMatchObject({ ...profile.standard, frame_ring_mib: 700, preview_gpu_pool_slots: 6 })
    expect(() => s.apply({ performance_calibration: { ...profile, maximum: { preview_gpu_sessions: 99, preview_gpu_pixel_area: 1 } },
      performance: profile.less })).toThrow('Invalid calibration')
    expect(s.get().performance?.preview_gpu_sessions).toBe(3)
    s.apply({ performance_calibration: null, performance: null })
    expect(s.get().performance_calibration).toBeNull()
    expect(s.get().performance).toEqual(PERFORMANCE_DEFAULTS)
  })
  it('persists partial performance edits across writers, and resets only performance', () => {
    const { fs } = memFs()
    const a = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const b = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    a.apply({ performance: { preview_gpu_sessions: 2 }, language: 'zh-CN' })
    b.apply({ performance: { motif_cache_mib: 64 } })
    expect(a.get().performance).toEqual({ ...PERFORMANCE_DEFAULTS, preview_gpu_sessions: 2, motif_cache_mib: 64 })
    a.apply({ performance: null })
    expect(b.get().performance).toEqual(PERFORMANCE_DEFAULTS)
    expect(b.get().language).toBe('zh-CN')
  })

  it('publishes only committed settings and leaves disk/runtime unchanged on invalid patches or failed writes', () => {
    const { fs, files } = memFs()
    const onCommitted = vi.fn()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR, onCommitted })
    s.apply({ performance: { preview_gpu_sessions: 2 } })
    const saved = files.get(PATH)
    expect(onCommitted).toHaveBeenCalledTimes(1)
    expect(() => s.apply({ language: 'en-US', performance: { motif_cache_mib: NaN } })).toThrow()
    expect(files.get(PATH)).toBe(saved)
    fs.rename = () => { throw new Error('disk full') }
    expect(() => s.apply({ performance: { preview_gpu_sessions: 8 } })).toThrow('disk full')
    expect(onCommitted).toHaveBeenCalledTimes(1)
    expect(s.get().performance?.preview_gpu_sessions).toBe(2)
  })

  it('recovers malformed performance fields and non-object settings files', () => {
    const s = store({ [PATH]: JSON.stringify({ performance: { frame_ring_mib: 256, motif_cache_mib: 'bad' } }) })
    expect(s.get().performance).toEqual({ ...PERFORMANCE_DEFAULTS, frame_ring_mib: 256 })
    for (const body of ['null', '[]', '42']) expect(store({ [PATH]: body }).get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('persists personal pause presets across readers without replacing unrelated edits', () => {
    const { fs } = memFs()
    const a = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const b = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const preset = { id: 'one', name: ' Interview ', thresholdDb: -32, minMs: 600, padMs: 150 }
    a.apply({ pause_preset_change: { kind: 'create', preset } })
    b.apply({ pause_preset_change: { kind: 'create', preset: { ...preset, id: 'two', name: 'Lecture' } } })
    a.apply({ pause_preset_change: { kind: 'update', id: 'one', values: { thresholdDb: -30, minMs: 800, padMs: 200 } } })
    b.apply({ pause_preset_change: { kind: 'rename', id: 'one', name: 'Podcast' } })
    expect(a.get().pause_presets).toEqual([
      { id: 'one', name: 'Podcast', thresholdDb: -30, minMs: 800, padMs: 200 },
      { ...preset, id: 'two', name: 'Lecture' },
    ])
    a.apply({ language: 'zh-CN' })
    expect(b.get().pause_presets).toHaveLength(2)
    b.apply({ pause_preset_change: { kind: 'delete', id: 'one' } })
    expect(a.get().pause_presets?.map(p => p.id)).toEqual(['two'])
  })

  it('rejects duplicate names and invalid pause parameters without changing saved recipes', () => {
    const s = store()
    const preset = { id: 'one', name: 'Interview', thresholdDb: -32, minMs: 600, padMs: 150 }
    s.apply({ pause_preset_change: { kind: 'create', preset } })
    expect(() => s.apply({ pause_preset_change: { kind: 'create', preset: { ...preset, id: 'two', name: ' INTERVIEW ' } } })).toThrow('already exists')
    expect(() => s.apply({ pause_preset_change: { kind: 'update', id: 'one', values: { ...preset, padMs: 300 } } })).toThrow('Invalid')
    expect(() => s.apply({ pause_preset_change: { kind: 'update', id: 'missing', values: preset } })).toThrow('no longer exists')
    expect(s.get().pause_presets).toEqual([preset])
  })

  it('recovers valid recipes from a partly damaged library and defaults old settings', () => {
    const valid = { id: 'one', name: 'Interview', thresholdDb: -32, minMs: 600, padMs: 150 }
    const s = store({ [PATH]: JSON.stringify({ pause_presets: [null, {}, valid, valid, { ...valid, id: 'bad', padMs: -1 }] }) })
    expect(s.get().pause_presets).toEqual([valid])
    expect(store({ [PATH]: '{}' }).get().pause_presets).toBeUndefined()
  })
  it('persists and clears the default text font across independent readers', () => {
    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    s.apply({ default_text_font: '  Example Sans  ' })
    const reader = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(reader.get().default_text_font).toBe('Example Sans')
    reader.apply({ language: 'en-US' })
    expect(s.get().default_text_font).toBe('Example Sans')
    reader.apply({ default_text_font: '  ' })
    expect(s.get().default_text_font).toBeUndefined()
    expect(JSON.parse(files.get(PATH)!)).not.toHaveProperty('default_text_font')
    expect(() => s.apply({ default_text_font: 42 } as never)).toThrow('must be a string')
  })

  it.each([undefined, null, 42, false, '', '   '])('uses the bundled default for invalid saved font %s', (font) => {
    expect(store({ [PATH]: JSON.stringify({ default_text_font: font }) }).get().default_text_font).toBeUndefined()
  })

  it('empty-track cleanup defaults on for old/invalid config and persists an explicit off choice', () => {
    expect(store().get().auto_delete_empty_tracks).toBe(true)
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().auto_delete_empty_tracks).toBe(true)
    expect(store({ [PATH]: '{ "auto_delete_empty_tracks": "false" }' }).get().auto_delete_empty_tracks).toBe(true)
    const { fs } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    s.apply({ auto_delete_empty_tracks: false })
    const reader = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(reader.get().auto_delete_empty_tracks).toBe(false)
    reader.apply({ display_mode: 'AllTracks' })
    expect(reader.get().auto_delete_empty_tracks).toBe(false)
    reader.apply({ auto_delete_empty_tracks: true })
    expect(s.get().auto_delete_empty_tracks).toBe(true)
  })

  it('defaults when no file', () => {
    expect(store().get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('apply persists then reads back (independent reader)', () => {
    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const after = s.apply({ display_mode: 'AllTracks', delta_window_us: 5_000_000, tail_snap_enabled: false, tail_snap_strength_px: 24 })
    expect(after.display_mode).toBe('AllTracks')
    expect(after.delta_window_us).toBe(5_000_000)
    expect(after.tail_snap_strength_px).toBe(24)
    const reader = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(reader.get()).toEqual(after)
    expect(files.has(PATH + '.tmp')).toBe(false) // tmp promoted, not left behind
  })

  it('missing fields inherit defaults', () => {
    const s = store({ [PATH]: '{ "display_mode": "AllTracks" }' })
    const got = s.get()
    expect(got.display_mode).toBe('AllTracks')
    expect(got.delta_window_us).toBe(10_000_000)
    expect(got.tail_snap_enabled).toBe(true)
    expect(got.tail_snap_strength_px).toBe(12)
    // The preview-snap pair must default too — see app-settings.ts for why.
    expect(got.preview_snap_enabled).toBe(true)
    expect(got.preview_snap_strength_px).toBe(12)
  })

  it('ignores the retired media drawer key without migrating or persisting it', () => {
    const { fs, files } = memFs({
      [PATH]: '{ "display_mode": "AllTracks", "media_pool_drawer_open": true }',
    })
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })

    expect(s.get()).toEqual({ ...APP_SETTINGS_DEFAULTS, display_mode: 'AllTracks' })
    s.apply({ tail_snap_enabled: false })

    const persisted = JSON.parse(files.get(PATH)!) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('media_pool_drawer_open')
  })

  it('corrupt file falls back to defaults (no throw)', () => {
    const s = store({ [PATH]: '{ not valid json at all' })
    expect(s.get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('delta_window clamps to [1s, 5min]', () => {
    expect(store().apply({ delta_window_us: 0 }).delta_window_us).toBe(1_000_000)
    expect(store().apply({ delta_window_us: 10 * 60 * 1_000_000 }).delta_window_us).toBe(300_000_000)
  })

  it('tail_snap_strength clamps to [2, 80]', () => {
    expect(store().apply({ tail_snap_strength_px: 0 }).tail_snap_strength_px).toBe(2)
    expect(store().apply({ tail_snap_strength_px: 200 }).tail_snap_strength_px).toBe(80)
  })

  it('preview_snap_strength clamps to [2, 80], independently of the timeline pair', () => {
    expect(store().apply({ preview_snap_strength_px: 0 }).preview_snap_strength_px).toBe(2)
    expect(store().apply({ preview_snap_strength_px: 200 }).preview_snap_strength_px).toBe(80)
    // The two domains have their own dials: turning one off leaves the other be.
    const after = store().apply({ preview_snap_enabled: false })
    expect(after.preview_snap_enabled).toBe(false)
    expect(after.tail_snap_enabled).toBe(true)
  })

  it('prebake_motifs / preview_effects_enabled round-trip', () => {
    expect(store().get().prebake_motifs).toBe(false)
    expect(store().apply({ prebake_motifs: true }).prebake_motifs).toBe(true)
    expect(store().get().preview_effects_enabled).toBe(true)
    expect(store().apply({ preview_effects_enabled: false }).preview_effects_enabled).toBe(false)
  })

  it('decode_engine defaults to auto, round-trips, and ignores unrecognized on-disk values', () => {
    expect(store().get().decode_engine).toBe('auto')
    expect(store().apply({ decode_engine: 'ffmpeg' }).decode_engine).toBe('ffmpeg')
    expect(store().apply({ decode_engine: 'webcodecs' }).decode_engine).toBe('webcodecs')
    // A pre-existing app_settings.json holding the field's old shape (a
    // boolean, or any other unrecognized value) falls back to the default.
    const s = store({ [PATH]: '{ "decode_engine": true }' })
    expect(s.get().decode_engine).toBe('auto')
  })

  it("migrates a persisted decode_engine 'native' to 'ffmpeg'", () => {
    const s = store({ [PATH]: '{ "decode_engine": "native" }' })
    expect(s.get().decode_engine).toBe('ffmpeg')
  })

  it("accepts 'ffmpeg' | 'webcodecs' | 'auto' and defaults other on-disk values to auto", () => {
    expect(store({ [PATH]: '{ "decode_engine": "ffmpeg" }' }).get().decode_engine).toBe('ffmpeg')
    expect(store({ [PATH]: '{ "decode_engine": "webcodecs" }' }).get().decode_engine).toBe('webcodecs')
    expect(store({ [PATH]: '{ "decode_engine": "auto" }' }).get().decode_engine).toBe('auto')
    expect(store({ [PATH]: '{ "decode_engine": "bogus" }' }).get().decode_engine).toBe('auto')
  })

  it('playback_resolution defaults to full on a file written before the field existed', () => {
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().playback_resolution).toBe('full')
    expect(store().get().playback_resolution).toBe('full')
    expect(store().apply({ playback_resolution: 'half' }).playback_resolution).toBe('half')
    expect(store().apply({ playback_resolution: 'quarter' }).playback_resolution).toBe('quarter')
    // Hand-edited / wrong-typed values degrade the same way.
    expect(store({ [PATH]: '{ "playback_resolution": "eighth" }' }).get().playback_resolution).toBe('full')
    expect(store({ [PATH]: '{ "playback_resolution": 2 }' }).get().playback_resolution).toBe('full')
  })

  it('media_pool_layout defaults to large on a file written before the field existed', () => {
    // Same additive-field trap as playback_resolution: an existing
    // app_settings.json has no key, and the renderer switches on the value —
    // undefined there would silently drop every layout class.
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().media_pool_layout).toBe('large')
    expect(store().get().media_pool_layout).toBe('large')
    expect(store().apply({ media_pool_layout: 'grid' }).media_pool_layout).toBe('grid')
    expect(store().apply({ media_pool_layout: 'list' }).media_pool_layout).toBe('list')
    // Hand-edited / wrong-typed values degrade the same way.
    expect(store({ [PATH]: '{ "media_pool_layout": "mosaic" }' }).get().media_pool_layout).toBe('large')
    expect(store({ [PATH]: '{ "media_pool_layout": 3 }' }).get().media_pool_layout).toBe('large')
  })

  it('timeline_wheel_axis defaults to horizontal on a file written before the field existed', () => {
    // Same additive-field trap once more, with a sharper failure: the renderer's
    // wheel handler switches on this value, so `undefined` would take neither
    // branch and the timeline would stop scrolling entirely.
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().timeline_wheel_axis).toBe('horizontal')
    expect(store().get().timeline_wheel_axis).toBe('horizontal')
    expect(store().apply({ timeline_wheel_axis: 'vertical' }).timeline_wheel_axis).toBe('vertical')
    // Hand-edited / wrong-typed values degrade the same way.
    expect(store({ [PATH]: '{ "timeline_wheel_axis": "diagonal" }' }).get().timeline_wheel_axis).toBe('horizontal')
    expect(store({ [PATH]: '{ "timeline_wheel_axis": 1 }' }).get().timeline_wheel_axis).toBe('horizontal')
  })

  it('timeline_follow_playhead defaults to ON on a file written before the field existed', () => {
    // The additive-boolean trap: an absent key must NOT read as false, or every
    // existing install silently loses the feature it never turned off.
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().timeline_follow_playhead).toBe(true)
    expect(store().get().timeline_follow_playhead).toBe(true)
    expect(store().apply({ timeline_follow_playhead: false }).timeline_follow_playhead).toBe(false)
    expect(store({ [PATH]: '{ "timeline_follow_playhead": false }' }).get().timeline_follow_playhead).toBe(false)
    // Hand-edited / wrong-typed values degrade to the default.
    expect(store({ [PATH]: '{ "timeline_follow_playhead": "yes" }' }).get().timeline_follow_playhead).toBe(true)
  })

  it('markers_visible defaults to ON on a file written before the field existed', () => {
    // Same additive-boolean trap as timeline_follow_playhead, and the reason
    // cross-restart persistence is asserted HERE rather than by relaunching the
    // app in e2e: an absent key must NOT read as false, or every existing
    // install opens with the marker layer silenced it never chose to silence.
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().markers_visible).toBe(true)
    expect(store().get().markers_visible).toBe(true)
    expect(store().apply({ markers_visible: false }).markers_visible).toBe(false)
    expect(store({ [PATH]: '{ "markers_visible": false }' }).get().markers_visible).toBe(false)
    // Hand-edited / wrong-typed values degrade to the default.
    expect(store({ [PATH]: '{ "markers_visible": "off" }' }).get().markers_visible).toBe(true)
    expect(store({ [PATH]: '{ "markers_visible": 0 }' }).get().markers_visible).toBe(true)
  })

  // The restart half of the same criterion: the flip has to survive the file,
  // not just the in-memory snapshot the patch returned.
  it('markers_visible survives a restart through the file', () => {
    const { fs } = memFs()
    createAppSettingsStore({ fs, path: PATH, dir: DIR }).apply({ markers_visible: false })
    const nextLaunch = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(nextLaunch.get().markers_visible).toBe(false)
    expect(nextLaunch.apply({ markers_visible: true }).markers_visible).toBe(true)
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().markers_visible).toBe(true)
  })

  // The mirror image of the boolean above: this one defaults OFF, so an
  // absent key reading as false is exactly right. What still has to hold is the
  // restart — a view toggle the user turned on is a preference, not a session
  // flag, and it never enters project history to be restored from.
  it('safe_area_guides_visible defaults to OFF and survives a restart', () => {
    expect(store().get().safe_area_guides_visible).toBe(false)
    expect(store({ [PATH]: '{ "display_mode": "AllTracks" }' }).get().safe_area_guides_visible).toBe(false)
    // Hand-edited / wrong-typed values degrade to the default.
    expect(store({ [PATH]: '{ "safe_area_guides_visible": "on" }' }).get().safe_area_guides_visible).toBe(false)

    const { fs } = memFs()
    createAppSettingsStore({ fs, path: PATH, dir: DIR }).apply({ safe_area_guides_visible: true })
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().safe_area_guides_visible).toBe(true)
  })

  it('data_root round-trips, and empty/missing/corrupt degrades to unset', () => {
    // No file → unset (resolver substitutes the default).
    expect(store().get().data_root).toBeUndefined()

    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    // Set + read back through an independent reader (persisted, not in-memory).
    expect(s.apply({ data_root: '/mnt/media/weft' }).data_root).toBe('/mnt/media/weft')
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().data_root).toBe('/mnt/media/weft')
    expect(JSON.parse(files.get(PATH)!).data_root).toBe('/mnt/media/weft')

    // Empty string clears it back to unset, and is not left on disk.
    expect(s.apply({ data_root: '' }).data_root).toBeUndefined()
    expect(JSON.parse(files.get(PATH)!)).not.toHaveProperty('data_root')

    // Wrong-typed / whitespace-only on-disk values degrade to unset (no throw).
    expect(store({ [PATH]: '{ "data_root": 123 }' }).get().data_root).toBeUndefined()
    expect(store({ [PATH]: '{ "data_root": "   " }' }).get().data_root).toBeUndefined()
  })

  it('language round-trips, and empty/missing/corrupt degrades to unset', () => {
    // No file → unset (the renderer auto-detects the OS language on first run).
    expect(store().get().language).toBeUndefined()

    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    // Set + read back through an independent (persisted) reader.
    expect(s.apply({ language: 'zh-CN' }).language).toBe('zh-CN')
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().language).toBe('zh-CN')
    expect(JSON.parse(files.get(PATH)!).language).toBe('zh-CN')

    // Empty string clears it back to unset, and is not left on disk.
    expect(s.apply({ language: '' }).language).toBeUndefined()
    expect(JSON.parse(files.get(PATH)!)).not.toHaveProperty('language')

    // Wrong-typed / whitespace-only on-disk values degrade to unset (no throw).
    expect(store({ [PATH]: '{ "language": 5 }' }).get().language).toBeUndefined()
    expect(store({ [PATH]: '{ "language": "   " }' }).get().language).toBeUndefined()
  })
})
