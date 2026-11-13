/** Preview-only application preference, never persisted in a project. */
export interface PreviewGridSettings {
  visible: boolean;
  /** Percent opacity of the overlay; 0 hides paint but does not disable snapping. */
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
  const opacity = clamp(grid.opacity, 0, 100, d.opacity);
  return {
    visible: typeof grid.visible === "boolean" ? grid.visible : d.visible,
    // Preserve the eye's deliberate hidden state. Any positive opacity must
    // be legible, including values restored from previously saved settings.
    opacity: opacity === 0 ? 0 : Math.max(GRID_OPACITY_MIN_VISIBLE, opacity),
    column_divisions: clamp(grid.column_divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.column_divisions),
    row_divisions: clamp(grid.row_divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.row_divisions),
    columns: typeof grid.columns === "boolean" ? grid.columns : d.columns,
    rows: typeof grid.rows === "boolean" ? grid.rows : d.rows,
  };
}
