export interface PreviewGridSettings {
  visible: boolean;
  snap: boolean;
  mode: "equal" | "independent";
  /** Same format-relative count on both axes in equal mode. */
  divisions: number;
  /** Per-axis counts retained while switching back to equal mode. */
  column_divisions: number;
  row_divisions: number;
  /** Independent-mode switches; equal mode always draws both axes. */
  columns: boolean;
  rows: boolean;
}

export const GRID_DIVISIONS_MIN = 1;
export const GRID_DIVISIONS_MAX = 32;

export const DEFAULT_PREVIEW_GRID: PreviewGridSettings = {
  visible: false,
  snap: false,
  mode: "equal",
  divisions: 3,
  column_divisions: 3,
  row_divisions: 3,
  columns: true,
  rows: true,
};

export function readPreviewGridSettings(raw: unknown): PreviewGridSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREVIEW_GRID };
  // Old prototypes stored either a shared divisions count, independent counts
  // without a mode, or pixel gaps. Preserve their resolution-independent
  // counts; pixel distances cannot be converted without a composition format.
  const grid = raw as Partial<PreviewGridSettings>;
  const d = DEFAULT_PREVIEW_GRID;
  const boundedInt = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(GRID_DIVISIONS_MAX, Math.max(GRID_DIVISIONS_MIN, value)))
      : fallback;
  const columnDivisions = boundedInt(grid.column_divisions ?? grid.divisions, d.column_divisions);
  const rowDivisions = boundedInt(grid.row_divisions ?? grid.divisions, d.row_divisions);
  const inferredMode = columnDivisions !== rowDivisions ? "independent" : "equal";

  return {
    visible: typeof grid.visible === "boolean" ? grid.visible : d.visible,
    snap: typeof grid.snap === "boolean" ? grid.snap : d.snap,
    mode: grid.mode === "equal" || grid.mode === "independent" ? grid.mode : inferredMode,
    divisions: boundedInt(grid.divisions ?? grid.column_divisions ?? grid.row_divisions, d.divisions),
    column_divisions: columnDivisions,
    row_divisions: rowDivisions,
    columns: typeof grid.columns === "boolean" ? grid.columns : d.columns,
    rows: typeof grid.rows === "boolean" ? grid.rows : d.rows,
  };
}
