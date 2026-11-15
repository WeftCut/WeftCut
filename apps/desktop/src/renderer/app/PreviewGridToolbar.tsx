import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Columns3, Eye, EyeOff, Rows3 } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { AppNumberField } from "../components/AppNumberField";
import { GRID_DIVISIONS_MAX, GRID_DIVISIONS_MIN } from "../../shared/preview-grid";
import { setAppSettings, usePreviewGrid } from "../settings/appSettingsStore";

/** One axis's count. The draft survives a store echo while the field is
 *  focused, so a debounced commit never rewrites what is being typed. */
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
  if (!grid.enabled) return null;
  const toggle = (field: "columns" | "rows") => {
    void setAppSettings({ preview_grid: { [field]: !grid[field] } });
  };
  const columnsLabel = t("preview.grid_columns");
  const rowsLabel = t("preview.grid_rows");
  const eyeLabel = t(grid.hidden ? "preview.grid_show" : "preview.grid_hide");
  return (
    <div
      className="preview-grid-toolbar"
      role="group"
      aria-label={t("preview.grid_label")}
      data-testid="preview-grid-toolbar"
      onKeyUp={(event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        if (event.key !== "Enter" && event.key !== "Escape") return;
        // On keyup, not keydown: the field commits or discards on keydown, and
        // blurring first would commit the text Escape is about to discard.
        // The panel, not the canvas, is the focus region that owns the
        // preview's scoped shortcuts.
        event.currentTarget.closest<HTMLElement>('[data-focus-region="preview"]')?.focus();
      }}
    >
      <div className="preview-grid-axis">
        <GridCount value={grid.column_divisions} field="column_divisions" label={columnsLabel} />
        <button type="button" className="preview-grid-axis-toggle"
          aria-label={t("preview.grid_vertical_lines")}
          aria-pressed={grid.columns}
          title={t("preview.grid_vertical_lines")}
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
          aria-label={t("preview.grid_horizontal_lines")}
          aria-pressed={grid.rows}
          title={t("preview.grid_horizontal_lines")}
          data-testid="grid-rows-visible"
          onClick={() => toggle("rows")}
        >
          <AppIcon icon={Rows3} size="caption" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        className="preview-grid-axis-toggle preview-grid-eye-toggle"
        aria-label={eyeLabel}
        aria-pressed={!grid.hidden}
        title={eyeLabel}
        data-testid="grid-eye"
        onClick={() => void setAppSettings({ preview_grid: { hidden: !grid.hidden } })}
      >
        <AppIcon icon={grid.hidden ? EyeOff : Eye} size="caption" aria-hidden />
      </button>
    </div>
  );
}
