export interface PreviewGridSettings {
  visible: boolean;
  snap: boolean;
  /** Format-relative subdivisions; 1 leaves no interior lines on that axis. */
  column_divisions: number;
  row_divisions: number;
}

export const GRID_DIVISIONS_MIN = 1;
export const GRID_DIVISIONS_MAX = 32;

export const DEFAULT_PREVIEW_GRID: PreviewGridSettings = {
  visible: false,
  snap: false,
  column_divisions: 3,
  row_divisions: 3,
};

/** Validate the current persisted settings shape. */
export function readPreviewGridSettings(raw: unknown): PreviewGridSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREVIEW_GRID };
  const grid = raw as Partial<PreviewGridSettings>;
  const d = DEFAULT_PREVIEW_GRID;
  const boundedInt = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(GRID_DIVISIONS_MAX, Math.max(GRID_DIVISIONS_MIN, value)))
      : fallback;

  return {
    visible: typeof grid.visible === "boolean" ? grid.visible : d.visible,
    snap: typeof grid.snap === "boolean" ? grid.snap : d.snap,
    column_divisions: boundedInt(grid.column_divisions, d.column_divisions),
    row_divisions: boundedInt(grid.row_divisions, d.row_divisions),
  };
}
