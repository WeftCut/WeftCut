export interface PreviewGridSettings {
  visible: boolean;
  snap: boolean;
  /** Format-relative subdivisions, independent for each axis. */
  column_divisions: number;
  row_divisions: number;
  /** Whether to show/snap to each axis's interior lines. */
  columns: boolean;
  rows: boolean;
}

export const GRID_DIVISIONS_MIN = 1;
export const GRID_DIVISIONS_MAX = 32;

export const DEFAULT_PREVIEW_GRID: PreviewGridSettings = {
  visible: false,
  snap: false,
  column_divisions: 8,
  row_divisions: 8,
  columns: true,
  rows: true,
};

export function readPreviewGridSettings(raw: unknown): PreviewGridSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREVIEW_GRID };
  // Legacy builds saved one shared divisions value for both axes, or
  // resolution-dependent pixel gaps. Preserve shared subdivisions when present;
  // pixel gaps cannot be translated without a project format (this is app state).
  const grid = raw as Partial<PreviewGridSettings> & { divisions?: number };
  const d = DEFAULT_PREVIEW_GRID;
  const boundedInt = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(GRID_DIVISIONS_MAX, Math.max(GRID_DIVISIONS_MIN, value)))
      : fallback;

  return {
    visible: typeof grid.visible === "boolean" ? grid.visible : d.visible,
    snap: typeof grid.snap === "boolean" ? grid.snap : d.snap,
    column_divisions: boundedInt(grid.column_divisions ?? grid.divisions, d.column_divisions),
    row_divisions: boundedInt(grid.row_divisions ?? grid.divisions, d.row_divisions),
    columns: typeof grid.columns === "boolean" ? grid.columns : d.columns,
    rows: typeof grid.rows === "boolean" ? grid.rows : d.rows,
  };
}
