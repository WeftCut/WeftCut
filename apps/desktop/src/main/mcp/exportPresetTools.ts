import { randomUUID } from 'node:crypto';
import type { TsActorHost } from '../state/ts-actor-host';
import type { AppSettings, AppSettingsPatch } from '../../shared/app-settings';
import { changeExportPresets, defaultExportPreset, exportPresetLibrary, patchExportPresetValues,
  DEFAULT_EXPORT_PRESET_ID, EXPORT_PRESET_NAME_LIMIT, type ExportPreset } from '../../shared/export-presets';
import { exportWire } from '../../shared/exportJob';
import { ExportValidationError } from '../../shared/exportValidation';
import { ExportJobError } from '../exportJobs';
import { exportPresetSettingsSchema } from './exportTools';

const builtinNames: Record<string, string> = { match: 'Match project', hd: '720p HD Landscape', fullhd: '1080p Full HD Landscape', uhd: '4K UHD Landscape' };
const record = (p: ExportPreset, defaultId: string) => ({ id: p.id, name: p.id.startsWith('builtin:') ? builtinNames[p.name] : p.name,
  version: p.version, read_only: p.id.startsWith('builtin:'), is_default: p.id === defaultId,
  settings: p.values, ...(p.bitrateByFrameRate ? { bitrate_by_frame_rate: p.bitrateByFrameRate } : {}) });

/** Uses the same atomic store and renderer notifications as the UI. No project mutation. */
export async function runExportPresetTool(host: TsActorHost, name: string, args: Record<string, unknown>): Promise<unknown> {
  const prefs = await host.handleInvoke('app_settings_get', {}) as AppSettings;
  const library = exportPresetLibrary(prefs);
  const defaultId = defaultExportPreset(prefs).id;
  const find = (id: unknown): ExportPreset => {
    if (typeof id !== 'string' || !id.trim()) throw new ExportValidationError('preset_id must be a nonempty string');
    const preset = library.find(p => p.id === id);
    if (!preset) throw new ExportJobError('preset_not_found', `Unknown export preset ${id}; list_export_presets lists the ids`);
    return preset;
  };
  if (name === 'list_export_presets') return { ...exportWire({ presets: library.map(p => record(p, defaultId)),
    default_preset_id: defaultId, name_limit: EXPORT_PRESET_NAME_LIMIT }, true) as object, settings_schema: exportPresetSettingsSchema() };
  const parseName = (): string => {
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > EXPORT_PRESET_NAME_LIMIT)
      throw new ExportValidationError(`name must contain 1–${EXPORT_PRESET_NAME_LIMIT} characters`);
    return args.name.trim();
  };
  const patchValues = (p: ExportPreset) => {
    const checkKeys = (v: unknown): void => {
      if (v && typeof v === 'object') for (const [key, value] of Object.entries(v)) {
        if (/[A-Z]/.test(key)) throw new ExportValidationError('MCP preset settings must use snake_case');
        checkKeys(value);
      }
    };
    checkKeys(args.settings);
    return patchExportPresetValues(p.values, exportWire(args.settings, false));
  };
  let patch: AppSettingsPatch;
  let id: string;
  if (name === 'create_export_preset') {
    const base = find(args.base_preset_id === undefined ? DEFAULT_EXPORT_PRESET_ID : args.base_preset_id);
    const preset: ExportPreset = { id: randomUUID(), name: parseName(), version: 1,
      values: args.settings === undefined ? structuredClone(base.values) : patchValues(base) };
    id = preset.id;
    patch = { export_preset_change: { kind: 'create', preset } };
  } else {
    const p = find(args.preset_id);
    id = p.id;
    if (name === 'set_default_export_preset') patch = { default_export_preset_id: id };
    else {
      if (id.startsWith('builtin:')) throw new ExportValidationError('Built-in export presets are read-only; create a personal copy');
      if (name === 'update_export_preset') patch = { export_preset_change: { kind: 'update', id, values: patchValues(p) } };
      else if (name === 'rename_export_preset') patch = { export_preset_change: { kind: 'rename', id, name: parseName() } };
      else patch = { export_preset_change: { kind: 'delete', id } };
    }
  }
  // Shared validation provides the same duplicate-name and compatibility rules as UI writes.
  if (patch.export_preset_change) {
    try { changeExportPresets(prefs.export_presets ?? [], patch.export_preset_change); }
    catch (error) { throw new ExportValidationError(error instanceof Error ? error.message : String(error)); }
  }
  const saved = await host.handleInvoke('app_settings_set', { patch }) as AppSettings;
  const nextDefault = defaultExportPreset(saved).id;
  const preset = exportPresetLibrary(saved).find(p => p.id === id);
  return exportWire({ default_preset_id: nextDefault,
    ...(name === 'delete_export_preset' ? { deleted_preset_id: id } : { preset: record(preset!, nextDefault) }) }, true);
}
