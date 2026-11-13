import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Columns3, Eye, EyeOff, Rows3 } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { AppNumberField } from "../components/AppNumberField";
import { DEFAULT_PREVIEW_GRID, GRID_DIVISIONS_MAX, GRID_DIVISIONS_MIN } from "../../shared/preview-grid";
import { setAppSettings, usePreviewGrid } from "../settings/appSettingsStore";

/** Inline grid counts: part of working on the canvas, not a Quick Actions popover.
 * Each control remains accessible while the grid is on. */
function GridCount({ value, field, label }: {
  value: number;
  field: "column_divisions" | "row_divisions";
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const bounded = (next: number) =>
    Math.min(GRID_DIVISIONS_MAX, Math.max(GRID_DIVISIONS_MIN, Math.round(next)));
  const commit = (next: number) => {
    const count = bounded(next);
    if (count !== value) void setAppSettings({ preview_grid: { [field]: count } });
  };
  return (
    <AppNumberField
      className="preview-grid-count"
      value={draft}
      min={GRID_DIVISIONS_MIN}
      max={GRID_DIVISIONS_MAX}
      align="center"
      ariaLabel={label}
      onFocus={() => { editing.current = true; }}
      onBlur={() => { editing.current = false; }}
      onValueChange={(next) => setDraft(bounded(next))}
      onCommit={commit}
    />
  );
}

export function PreviewGridToolbar() {
  const { t } = useTranslation();
  const grid = usePreviewGrid();
  // The eye mutes the drawing, not the grid itself: at 0% the same
  // subdivisions remain eligible snap targets. Remember a user's preferred
  // nonzero opacity so toggling the eye never destroys their Settings value.
  const lastVisibleOpacity = useRef(DEFAULT_PREVIEW_GRID.opacity);
  useEffect(() => {
    if (grid.opacity > 0) lastVisibleOpacity.current = grid.opacity;
  }, [grid.opacity]);
  if (!grid.visible) return null;
  const toggle = (field: "columns" | "rows") => {
    void setAppSettings({ preview_grid: { [field]: !grid[field] } });
  };
  const columnsLabel = t("quick_actions.grid_column_divisions");
  const rowsLabel = t("quick_actions.grid_row_divisions");
  return (
    <div
      className="preview-grid-toolbar"
      role="group"
      aria-label={t("quick_actions.snapping_grid")}
      data-testid="preview-grid-toolbar"
      onKeyDown={(event) => {
        // The number field owns Enter and Escape's commit/cancel logic.
        // Stop transport shortcuts, but let the field finish processing before
        // moving focus (blurring during keydown can commit the uncancelled text).
        if (event.target instanceof HTMLInputElement) event.stopPropagation();
      }}
      onKeyUp={(event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Escape") {
          event.currentTarget.closest(".preview")?.querySelector<HTMLElement>(".preview-video")?.focus();
        }
      }}
    >
      <div className="preview-grid-axis">
        <GridCount value={grid.column_divisions} field="column_divisions" label={columnsLabel} />
        <button type="button" className="preview-grid-axis-toggle"
          aria-label={t("quick_actions.grid_columns")}
          aria-pressed={grid.columns}
          title={t("quick_actions.grid_columns")}
          data-testid="grid-columns-visible"
          onClick={() => toggle("columns")}
        >
          <AppIcon icon={Columns3} size="caption" aria-hidden />
        </button>
      </div>
      <span className="preview-grid-times" aria-hidden>×</span>
      <div className="preview-grid-axis">
        <GridCount value={grid.row_divisions} field="row_divisions" label={rowsLabel} />
        <button type="button" className="preview-grid-axis-toggle"
          aria-label={t("quick_actions.grid_rows")}
          aria-pressed={grid.rows}
          title={t("quick_actions.grid_rows")}
          data-testid="grid-rows-visible"
          onClick={() => toggle("rows")}
        >
          <AppIcon icon={Rows3} size="caption" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        className="preview-grid-axis-toggle preview-grid-eye-toggle"
        aria-label={t(grid.opacity > 0 ? "quick_actions.grid_mute" : "quick_actions.grid_unmute")}
        aria-pressed={grid.opacity > 0}
        title={t(grid.opacity > 0 ? "quick_actions.grid_mute" : "quick_actions.grid_unmute")}
        data-testid="grid-opacity-eye"
        onClick={() => void setAppSettings({
          preview_grid: { opacity: grid.opacity > 0 ? 0 : lastVisibleOpacity.current },
        })}
      >
        <AppIcon icon={grid.opacity > 0 ? Eye : EyeOff} size="caption" aria-hidden />
      </button>
    </div>
  );
}
