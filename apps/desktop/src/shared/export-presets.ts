import { DEFAULT_EXPORT_SETTINGS, mergeSettings, resolveOutputDims, type CompDims, type ExportSettings } from './exportSettings';
import { resolveExportRequest, ExportValidationError } from './exportValidation';

/** Portable output intent. Machine engine choices and destinations are never recipes. */
export type ExportPresetValues = Omit<ExportSettings, 'encoderEngine' | 'decodeEngine' | 'hwAccel'>;
export interface ExportPreset {
  id: string;
  name: string;
  version: 1;
  values: ExportPresetValues;
  /** Built-ins alone can seed a rate from the project's actual frame rate. */
  bitrateByFrameRate?: { standard: number; high: number };
}
export type ExportPresetChange =
  | { kind: 'create'; preset: ExportPreset }
  /** A rename, a settings change, or both, as one validated write. */
  | { kind: 'update'; id: string; name?: string; values?: ExportPresetValues }
  | { kind: 'delete'; id: string };
export interface ExportPresetPreferences {
  export_presets?: ExportPreset[];
  default_export_preset_id?: string;
}
export const EXPORT_PRESET_NAME_LIMIT = 40;
export const DEFAULT_EXPORT_PRESET_ID = 'builtin:match';

/** Whitelist from the current settings schema; never copy path/range or future runtime metadata. */
export function exportPresetValues(settings: ExportSettings): ExportPresetValues {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_EXPORT_SETTINGS) as (keyof ExportSettings)[]) {
    if (key !== 'encoderEngine' && key !== 'decodeEngine' && key !== 'hwAccel') result[key] = settings[key];
  }
  return { ...result, audio: { ...settings.audio, include: settings.includeAudio } } as ExportPresetValues;
}

const base = exportPresetValues(mergeSettings(null));
export const BUILTIN_EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: DEFAULT_EXPORT_PRESET_ID, name: 'match', version: 1, values: base },
  ...([
    ['hd', 720, 5_000_000, 7_500_000, 128_000],
    ['fullhd', 1080, 8_000_000, 12_000_000, 192_000],
    ['uhd', 2160, 40_000_000, 60_000_000, 320_000],
  ] as const).map(([name, height, standard, high, audioRate]): ExportPreset => ({
    id: `builtin:${name}`, name, version: 1,
    values: { ...base, resolutionHeight: height, quality: 'custom', customBitrate: standard,
      audio: { ...base.audio, sampleRate: 48_000, channels: 2, bitrate: audioRate } },
    bitrateByFrameRate: { standard, high },
  })),
];

export const exportPresetNameKey = (name: string): string => name.trim().normalize('NFKC').toLowerCase();
export function exportPresetLibrary(prefs: ExportPresetPreferences): readonly ExportPreset[] {
  return [...BUILTIN_EXPORT_PRESETS, ...(prefs.export_presets ?? [])];
}
export function defaultExportPreset(prefs: ExportPresetPreferences): ExportPreset {
  return exportPresetLibrary(prefs).find(p => p.id === prefs.default_export_preset_id) ?? BUILTIN_EXPORT_PRESETS[0]!;
}

/** Copy into the project, respecting its existing downscale-only contract. No orientation conversion. */
export function applyExportPreset(preset: ExportPreset, comp: CompDims, current = mergeSettings(null)): ExportSettings {
  const settings = { ...current, ...structuredClone(preset.values) };
  if (settings.resolutionHeight != null && settings.resolutionHeight > comp.height) settings.resolutionHeight = null;
  const compFps = comp.fps_num / comp.fps_den;
  if (settings.fps != null && settings.fps > compFps) settings.fps = null;
  if (preset.bitrateByFrameRate) {
    const nominalHeight = preset.values.resolutionHeight!;
    const dims = resolveOutputDims(comp, settings);
    const scale = Math.min(1, dims.width * dims.height / (nominalHeight * nominalHeight * 16 / 9));
    settings.customBitrate = Math.max(1, Math.round((settings.fps ?? compFps) >= 48
      ? preset.bitrateByFrameRate.high * scale : preset.bitrateByFrameRate.standard * scale));
  }
  return settings;
}

export function initialExportSettings(saved: Partial<ExportSettings> | null, prefs: ExportPresetPreferences, comp: CompDims): ExportSettings {
  return saved == null ? applyExportPreset(defaultExportPreset(prefs), comp) : mergeSettings(saved);
}

export function sameExportPresetValues(a: ExportPresetValues, b: ExportPresetValues): boolean {
  const aa = exportPresetValues({ ...DEFAULT_EXPORT_SETTINGS, ...a });
  const bb = exportPresetValues({ ...DEFAULT_EXPORT_SETTINGS, ...b });
  return (Object.keys(aa) as (keyof ExportPresetValues)[]).every(key => key === 'audio'
    ? (Object.keys(aa.audio) as (keyof ExportSettings['audio'])[]).every(k => aa.audio[k] === bb.audio[k])
    : aa[key] === bb[key]);
}

/** Validate output intent without depending on an open project or local hardware. */
export function validateExportPresetValues(input: unknown): ExportPresetValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid export preset');
  const values = input as ExportPresetValues;
  const keys = Object.keys(base);
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !(key in input))) throw new Error('Invalid export preset fields');
  const height = values.resolutionHeight ?? 1080;
  const fps = values.fps ?? 30;
  // The request validator checks field types/combinations as well as bitrate constraints.
  const result = resolveExportRequest(null, values, {
    width: Math.max(2, Math.round(height * 16 / 9)), height, fps_num: fps, fps_den: 1, duration_us: 1_000_000,
  }, undefined, true);
  return exportPresetValues(result.settings);
}

/** Patch portable fields without a project; omitted fields retain the recipe's values. */
export function patchExportPresetValues(baseValues: ExportPresetValues, patch: unknown): ExportPresetValues {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ExportValidationError('Preset settings must be an object');
  if (Object.keys(patch).some(key => !Object.hasOwn(base, key))) throw new ExportValidationError('Preset settings may contain only portable output fields; engines, paths and ranges are excluded');
  const next = { ...baseValues, ...patch };
  const height = next.resolutionHeight ?? 1080;
  const fps = next.fps ?? 30;
  return exportPresetValues(resolveExportRequest(baseValues, patch, {
    width: Math.max(2, Math.round(height * 16 / 9)), height, fps_num: fps, fps_den: 1, duration_us: 1_000_000,
  }, undefined, true).settings);
}

function readOne(input: unknown): ExportPreset {
  const p = input as ExportPreset;
  if (!p || p.version !== 1 || typeof p.id !== 'string' || !p.id.trim() || p.id.startsWith('builtin:')
    || typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > EXPORT_PRESET_NAME_LIMIT) throw new Error('Invalid export preset');
  return { id: p.id, name: p.name.trim(), version: 1, values: validateExportPresetValues(p.values) };
}
export function readExportPresets(input: unknown): ExportPreset[] {
  if (!Array.isArray(input)) return [];
  const result: ExportPreset[] = [];
  for (const item of input) {
    try {
      const p = readOne(item);
      if (!result.some(other => other.id === p.id || exportPresetNameKey(other.name) === exportPresetNameKey(p.name))) result.push(p);
    } catch { /* Recover other entries independently of corrupt or future-version recipes. */ }
  }
  return result;
}
export function changeExportPresets(current: ExportPreset[], change: ExportPresetChange): ExportPreset[] {
  if (!change || !['create', 'update', 'delete'].includes(change.kind)
    || (change.kind === 'update' && change.name === undefined && change.values === undefined)) throw new Error('Invalid export preset change');
  if (change.kind !== 'create' && (typeof change.id !== 'string' || change.id.startsWith('builtin:'))) throw new Error('Built-in export presets are read-only');
  if (change.kind === 'delete') return current.filter(p => p.id !== change.id);
  let next: ExportPreset;
  if (change.kind === 'create') next = readOne(change.preset);
  else {
    const old = current.find(p => p.id === change.id);
    if (!old) throw new Error('Export preset no longer exists');
    next = readOne({ ...old, ...(change.name !== undefined ? { name: change.name } : {}), ...(change.values !== undefined ? { values: change.values } : {}) });
  }
  if (current.some(p => (change.kind === 'create' || p.id !== next.id)
    && (p.id === next.id || exportPresetNameKey(p.name) === exportPresetNameKey(next.name)))) throw new Error('An export preset with this name already exists');
  return change.kind === 'create' ? [...current, next] : current.map(p => p.id === next.id ? next : p);
}
