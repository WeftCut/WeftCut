import { describe, expect, it } from 'vitest';
import { BUILTIN_EXPORT_PRESETS, applyExportPreset, changeExportPresets, exportPresetValues, initialExportSettings, readExportPresets } from './export-presets';
import { mergeSettings } from './exportSettings';
import { resolveExportRequest } from './exportValidation';

const comp = { width: 1920, height: 1080, fps_num: 30000, fps_den: 1001 };
const fullhd = BUILTIN_EXPORT_PRESETS.find(p => p.name === 'fullhd')!;
const custom = () => ({ id: 'personal', name: 'Delivery', version: 1 as const, values: exportPresetValues(mergeSettings({ quality: 'custom', customBitrate: 9_000_000 })) });

describe('portable export presets', () => {
  it('preserves fractional project rates and adapts built-in rates only at application', () => {
    const normal = applyExportPreset(fullhd, comp);
    expect(normal).toMatchObject({ resolutionHeight: 1080, fps: null, customBitrate: 8_000_000 });
    const high = applyExportPreset(fullhd, { ...comp, fps_num: 60000 });
    expect(high.customBitrate).toBe(12_000_000);
    const request = resolveExportRequest(null, normal, { ...comp, duration_us: 1_000_000 });
    expect(request.fps).toEqual({ num: 30000, den: 1001 });
  });
  it('keeps lower-resolution projects valid without upscaling or changing aspect', () => {
    const small = { ...comp, width: 1280, height: 720 };
    const applied = applyExportPreset(BUILTIN_EXPORT_PRESETS[3]!, small);
    expect(applied.resolutionHeight).toBeNull();
    expect(resolveExportRequest(null, applied, { ...small, duration_us: 1_000_000 }).dimensions).toEqual({ width: 1280, height: 720 });
    const portrait = { ...comp, width: 1080, height: 1920 };
    expect(resolveExportRequest(null, applyExportPreset(fullhd, portrait), { ...portrait, duration_us: 1_000_000 }).dimensions).toEqual({ width: 608, height: 1080 });
  });
  it('applies defaults only to unsaved projects and never retains engine or output-path metadata', () => {
    const p = custom();
    const prefs = { export_presets: [p], default_export_preset_id: p.id };
    expect(initialExportSettings(null, prefs, comp).customBitrate).toBe(9_000_000);
    expect(initialExportSettings({ codec: 'hevc' }, prefs, comp)).toMatchObject({ codec: 'hevc', quality: 'medium' });
    const current = { ...mergeSettings(null), encoderEngine: 'native' as const, decodeEngine: 'ffmpeg' as const, hwAccel: 'software' as const, outputPath: 'private' };
    expect(exportPresetValues(current)).not.toHaveProperty('outputPath');
    expect(exportPresetValues(current)).not.toHaveProperty('encoderEngine');
    expect(applyExportPreset(p, comp, current)).toMatchObject({ encoderEngine: 'native', decodeEngine: 'ffmpeg', hwAccel: 'software' });
  });
  it('copies nested values and keeps existing project snapshots independent of library edits', () => {
    const p = custom();
    const snapshot = applyExportPreset(p, comp);
    const next = changeExportPresets([p], { kind: 'update', id: p.id, values: { ...p.values, audio: { ...p.values.audio, bitrate: 320_000 } } });
    expect(snapshot.audio.bitrate).toBe(192_000);
    expect(next[0]!.values.audio.bitrate).toBe(320_000);
    snapshot.audio.bitrate = 128_000;
    expect(p.values.audio.bitrate).toBe(192_000);
    expect(changeExportPresets(next, { kind: 'delete', id: p.id })).toEqual([]);
    expect(snapshot.customBitrate).toBe(9_000_000);
  });
  it('recovers corrupt entries individually and rejects duplicate names, incompatible settings and built-in edits', () => {
    const p = custom();
    expect(readExportPresets([null, { ...p, version: 2 }, p, p, { ...p, id: 'bad', values: { ...p.values, container: 'invalid' } }])).toEqual([p]);
    expect(() => changeExportPresets([p], { kind: 'create', preset: { ...p, id: 'other', name: ' DELIVERY ' } })).toThrow();
    expect(() => changeExportPresets([], { kind: 'delete', id: fullhd.id })).toThrow();
    expect(() => changeExportPresets([p], { kind: 'update', id: p.id, values: { ...p.values, maxBitrate: 1 } })).toThrow();
    expect(() => changeExportPresets([p], { kind: 'update', id: p.id })).toThrow('Invalid export preset change');
  });
  it('one update renames and changes values together, or either alone', () => {
    const p = custom();
    const both = changeExportPresets([p], { kind: 'update', id: p.id, name: ' Final ', values: { ...p.values, customBitrate: 7_000_000 } });
    expect(both[0]).toMatchObject({ name: 'Final', values: { customBitrate: 7_000_000 } });
    expect(changeExportPresets(both, { kind: 'update', id: p.id, name: 'Only name' })[0]).toMatchObject({ name: 'Only name', values: { customBitrate: 7_000_000 } });
  });
});
