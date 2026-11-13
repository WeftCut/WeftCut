/** Preview-only application preference, never persisted in a project. */
export interface PreviewGridSettings {
  visible: boolean;
  /** Opacity of visible grid lines, constrained to 10–100%. */
  opacity: number;
  column_divisions: number;
  row_divisions: number;
  /** Show vertical and horizontal interior lines independently. */
  columns: boolean;
  rows: boolean;
}

export const GRID_OPACITY_MIN_VISIBLE = 10;

export const GRID_DIVISIONS_MIN = 1;
export const GRID_DIVISIONS_MAX = 64;

export const DEFAULT_PREVIEW_GRID: PreviewGridSettings = {
  visible: false,
  opacity: 70,
  column_divisions: 3,
  row_divisions: 3,
  columns: true,
  rows: true,
};

export function readPreviewGridSettings(raw: unknown): PreviewGridSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREVIEW_GRID };
  const grid = raw as Partial<PreviewGridSettings>;
  const d = DEFAULT_PREVIEW_GRID;
  const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(max, Math.max(min, value)))
      : fallback;
  return {
    visible: typeof grid.visible === "boolean" ? grid.visible : d.visible,
    opacity: clamp(grid.opacity, GRID_OPACITY_MIN_VISIBLE, 100, d.opacity),
    column_divisions: clamp(grid.column_divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.column_divisions),
    row_divisions: clamp(grid.row_divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.row_divisions),
    columns: typeof grid.columns === "boolean" ? grid.columns : d.columns,
    rows: typeof grid.rows === "boolean" ? grid.rows : d.rows,
  };
}
