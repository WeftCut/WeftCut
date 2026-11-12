import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PREVIEW_SNAP_STRENGTH_MAX_PX,
  PREVIEW_SNAP_STRENGTH_MIN_PX,
  TAIL_SNAP_STRENGTH_MAX_PX,
  TAIL_SNAP_STRENGTH_MIN_PX,
  type AppSettingsPatch,
} from "../../shared/app-settings";
import {
  GRID_DIVISIONS_MAX,
  GRID_DIVISIONS_MIN,
  type PreviewGridSettings,
} from "../../shared/preview-grid";
import { AppNumberField } from "../components/AppNumberField";
import { AppSlider } from "../components/AppSlider";
import { AppSwitch } from "../components/AppSwitch";
import {
  setAppSettings,
  usePreviewGrid,
  usePreviewSnapEnabled,
  usePreviewSnapStrengthPx,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "./appSettingsStore";

type ReportError = (message: string) => void;

async function save(patch: AppSettingsPatch, onError: ReportError): Promise<boolean> {
  onError("");
  try {
    await setAppSettings(patch);
    return true;
  } catch (error) {
    onError(String(error));
    return false;
  }
}

function SnapToggle({ label, hint, checked, onChange }: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle-row">
      <AppSwitch checked={checked} onCheckedChange={onChange} />
      <span>
        <span className="settings-toggle-label">{label}</span>
        {hint && <span className="settings-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

function SnapNumber({ label, value, min, max, unit, disabled = false, slider, onSave }: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  slider?: boolean;
  onSave: (value: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = async (input: number) => {
    const next = Math.round(Math.min(max, Math.max(min, input)));
    setDraft(next);
    if (next !== value && !await onSave(next)) setDraft(value);
  };

  return (
    <div className="settings-slider-row">
      <span className="settings-slider-label">{label}</span>
      {slider && (
        <AppSlider
          min={min}
          max={max}
          value={draft}
          disabled={disabled}
          onValueChange={setDraft}
          onValueCommitted={(next) => void commit(next)}
          ariaLabel={label}
        />
      )}
      <AppNumberField
        value={draft}
        min={min}
        max={max}
        disabled={disabled}
        align="center"
        className="settings-input-narrow"
        ariaLabel={label}
        onValueChange={setDraft}
        onCommit={(next) => void commit(next)}
      />
      {unit && <span className="settings-slider-unit">{unit}</span>}
    </div>
  );
}

interface SnapSettingsProps {
  compact?: boolean;
  onError: ReportError;
}

export function TimelineSnapSettings({ compact, onError }: SnapSettingsProps) {
  const { t } = useTranslation();
  const enabled = useTailSnapEnabled();
  const strength = useTailSnapStrengthPx();

  return (
    <>
      <SnapToggle
        label={t("settings.tail_snap_enabled")}
        hint={compact ? undefined : t("settings.tail_snap_enabled_hint")}
        checked={enabled}
        onChange={(next) => void save({ tail_snap_enabled: next }, onError)}
      />
      <SnapNumber
        label={t("settings.tail_snap_strength")}
        value={strength}
        min={TAIL_SNAP_STRENGTH_MIN_PX}
        max={TAIL_SNAP_STRENGTH_MAX_PX}
        unit="px"
        disabled={!enabled}
        slider={!compact}
        onSave={(next) => save({ tail_snap_strength_px: next }, onError)}
      />
      {!compact && <p className="settings-toggle-hint">{t("settings.tail_snap_strength_hint")}</p>}
    </>
  );
}

export function CanvasSnapSettings({ compact, onError }: SnapSettingsProps) {
  const { t } = useTranslation();
  const enabled = usePreviewSnapEnabled();
  const strength = usePreviewSnapStrengthPx();
  const grid = usePreviewGrid();

  return (
    <>
      <SnapToggle
        label={t("settings.preview_snap_enabled")}
        hint={compact ? undefined : t("settings.preview_snap_enabled_hint")}
        checked={enabled}
        onChange={(next) => void save({ preview_snap_enabled: next }, onError)}
      />
      <SnapNumber
        label={t("settings.preview_snap_strength")}
        value={strength}
        min={PREVIEW_SNAP_STRENGTH_MIN_PX}
        max={PREVIEW_SNAP_STRENGTH_MAX_PX}
        unit="px"
        disabled={!enabled && !grid.snap}
        slider={!compact}
        onSave={(next) => save({ preview_snap_strength_px: next }, onError)}
      />
      <p className="settings-toggle-hint">
        {t(compact ? "quick_actions.canvas_snap_override" : "settings.preview_snap_strength_hint")}
      </p>
    </>
  );
}

export function PreviewGridControls({ onError }: { onError: ReportError }) {
  const { t } = useTranslation();
  const grid = usePreviewGrid();
  const saveGrid = (patch: Partial<PreviewGridSettings>) => save({ preview_grid: patch }, onError);

  return (
    <>
      <SnapToggle
        label={t("quick_actions.show_grid")}
        checked={grid.visible}
        onChange={(visible) => void saveGrid({ visible })}
      />
      <SnapToggle
        label={t("quick_actions.snap_to_grid")}
        checked={grid.snap}
        onChange={(snap) => void saveGrid({ snap })}
      />
      <SnapToggle
        label={t("quick_actions.grid_columns")}
        checked={grid.columns}
        onChange={(columns) => void saveGrid({ columns })}
      />
      <SnapNumber
        label={t("quick_actions.grid_column_divisions")}
        value={grid.column_divisions}
        min={GRID_DIVISIONS_MIN}
        max={GRID_DIVISIONS_MAX}
        disabled={!grid.columns}
        onSave={(column_divisions) => saveGrid({ column_divisions })}
      />
      <SnapToggle
        label={t("quick_actions.grid_rows")}
        checked={grid.rows}
        onChange={(rows) => void saveGrid({ rows })}
      />
      <SnapNumber
        label={t("quick_actions.grid_row_divisions")}
        value={grid.row_divisions}
        min={GRID_DIVISIONS_MIN}
        max={GRID_DIVISIONS_MAX}
        disabled={!grid.rows}
        onSave={(row_divisions) => saveGrid({ row_divisions })}
      />
    </>
  );
}
