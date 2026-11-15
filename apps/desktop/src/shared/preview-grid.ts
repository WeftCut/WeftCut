/** The preview's alignment grid: an app preference, never project data. */
export interface PreviewGridSettings {
  /** The Grid toggle. Owns both drawing and snapping: an enabled grid is a
   *  snap target whenever canvas snapping is on. */
  enabled: boolean;
  /** The toolbar eye. Stops drawing only; an enabled grid still snaps. */
  hidden: boolean;
  /** Line opacity in percent while drawn. Hiding is `hidden`'s job, so this
   *  never reaches 0 and the eye always restores the user's own value. */
  opacity: number;
  column_divisions: number;
  row_divisions: number;
  /** Per-axis switches: an axis that is off neither draws nor snaps. */
  columns: boolean;
  rows: boolean;
}

/** Below this the lines are easy to miss on real footage, which is the
 *  near-invisible grid that still snaps the eye exists to make explicit. */
export const GRID_OPACITY_MIN = 10;
export const GRID_OPACITY_MAX = 100;

export const GRID_DIVISIONS_MIN = 1;
export const GRID_DIVISIONS_MAX = 64;

export const DEFAULT_PREVIEW_GRID: PreviewGridSettings = {
  enabled: false,
  hidden: false,
  opacity: 70,
  column_divisions: 3,
  row_divisions: 3,
  columns: true,
  rows: true,
};

export function readPreviewGridSettings(raw: unknown): PreviewGridSettings {
  const d = DEFAULT_PREVIEW_GRID;
  if (!raw || typeof raw !== "object") return { ...d };
  const grid = raw as Partial<Record<keyof PreviewGridSettings, unknown>>;
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  const int = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(max, Math.max(min, value)))
      : fallback;
  return {
    enabled: bool(grid.enabled, d.enabled),
    hidden: bool(grid.hidden, d.hidden),
    opacity: int(grid.opacity, GRID_OPACITY_MIN, GRID_OPACITY_MAX, d.opacity),
    column_divisions: int(grid.column_divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.column_divisions),
    row_divisions: int(grid.row_divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.row_divisions),
    columns: bool(grid.columns, d.columns),
    rows: bool(grid.rows, d.rows),
  };
}
