import { CANVAS_MAX } from "./newProject";

export interface PreviewGridSettings {
  visible: boolean;
  snap: boolean;
  mode: "equal" | "pixels";
  divisions: number;
  column_gap_px: number;
  row_gap_px: number;
  columns: boolean;
  rows: boolean;
}

export const GRID_DIVISIONS_MIN = 2;
export const GRID_DIVISIONS_MAX = 32;
export const GRID_GAP_MIN_PX = 1;
export const GRID_GAP_MAX_PX = CANVAS_MAX;

export const DEFAULT_PREVIEW_GRID: PreviewGridSettings = {
  visible: false,
  snap: false,
  mode: "equal",
  divisions: 8,
  column_gap_px: 100,
  row_gap_px: 100,
  columns: true,
  rows: true,
};

export function readPreviewGridSettings(raw: unknown): PreviewGridSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREVIEW_GRID };
  const grid = raw as Partial<PreviewGridSettings>;
  const d = DEFAULT_PREVIEW_GRID;
  const boundedInt = (value: number | undefined, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(max, Math.max(min, value)))
      : fallback;

  return {
    visible: typeof grid.visible === "boolean" ? grid.visible : d.visible,
    snap: typeof grid.snap === "boolean" ? grid.snap : d.snap,
    mode: grid.mode === "pixels" ? "pixels" : d.mode,
    divisions: boundedInt(grid.divisions, GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX, d.divisions),
    column_gap_px: boundedInt(grid.column_gap_px, GRID_GAP_MIN_PX, GRID_GAP_MAX_PX, d.column_gap_px),
    row_gap_px: boundedInt(grid.row_gap_px, GRID_GAP_MIN_PX, GRID_GAP_MAX_PX, d.row_gap_px),
    columns: typeof grid.columns === "boolean" ? grid.columns : d.columns,
    rows: typeof grid.rows === "boolean" ? grid.rows : d.rows,
  };
}
