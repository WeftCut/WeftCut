/** Personal recipes are app preferences. Projects retain copied parameter values. */
export interface PauseValues {
  thresholdDb: number;
  minMs: number;
  padMs: number;
}

export interface PausePreset extends PauseValues {
  id: string;
  name: string;
}

export type PausePresetChange =
  | { kind: "create"; preset: PausePreset }
  | { kind: "update"; id: string; values: PauseValues }
  | { kind: "rename"; id: string; name: string }
  | { kind: "delete"; id: string };

export const DEFAULT_PAUSE_VALUES: PauseValues = { thresholdDb: -34, minMs: 500, padMs: 100 };
export const PAUSE_PRESET_NAME_LIMIT = 80;

export function validPauseValues(value: PauseValues): boolean {
  return Number.isInteger(value.thresholdDb) && value.thresholdDb >= -60 && value.thresholdDb <= -20
    && Number.isSafeInteger(value.minMs) && value.minMs >= 50
    && Number.isSafeInteger(value.padMs) && value.padMs >= 0 && value.padMs * 2 < value.minMs;
}

export function samePauseValues(a: PauseValues, b: PauseValues): boolean {
  return a.thresholdDb === b.thresholdDb && a.minMs === b.minMs && a.padMs === b.padMs;
}

export function pausePresetNameKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

/** Tolerant disk recovery; a damaged entry must not discard other preferences. */
export function readPausePresets(input: unknown): PausePreset[] {
  if (!Array.isArray(input)) return [];
  const result: PausePreset[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim()
      || typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > PAUSE_PRESET_NAME_LIMIT
      || !validPauseValues(item)) continue;
    if (result.some(p => p.id === item.id || pausePresetNameKey(p.name) === pausePresetNameKey(item.name))) continue;
    result.push({ id: item.id, name: item.name.trim(), thresholdDb: item.thresholdDb, minMs: item.minMs, padMs: item.padMs });
  }
  return result;
}

/** Apply against main's latest snapshot, so independent windows cannot lose unrelated recipes. */
export function changePausePresets(current: PausePreset[], change: PausePresetChange): PausePreset[] {
  if (!change || !["create", "update", "rename", "delete"].includes(change.kind)) throw new Error("Invalid pause preset change");
  if (change.kind === "delete") return current.filter(p => p.id !== change.id);
  if (change.kind === "create") {
    const clean = readPausePresets([change.preset]);
    if (clean.length !== 1) throw new Error("Invalid pause preset");
    if (current.some(p => p.id === clean[0]!.id || pausePresetNameKey(p.name) === pausePresetNameKey(clean[0]!.name))) {
      throw new Error("A pause preset with this name already exists");
    }
    return [...current, clean[0]!];
  }
  const preset = current.find(p => p.id === change.id);
  if (!preset) throw new Error("Pause preset no longer exists");
  if (change.kind === "update") {
    if (!change.values || !validPauseValues(change.values)) throw new Error("Invalid pause preset parameters");
    const { thresholdDb, minMs, padMs } = change.values;
    return current.map(p => p.id === change.id ? { ...p, thresholdDb, minMs, padMs } : p);
  }
  if (typeof change.name !== "string" || !change.name.trim() || change.name.trim().length > PAUSE_PRESET_NAME_LIMIT) {
    throw new Error("Invalid pause preset name");
  }
  if (current.some(p => p.id !== change.id && pausePresetNameKey(p.name) === pausePresetNameKey(change.name))) {
    throw new Error("A pause preset with this name already exists");
  }
  return current.map(p => p.id === change.id ? { ...p, name: change.name.trim() } : p);
}
