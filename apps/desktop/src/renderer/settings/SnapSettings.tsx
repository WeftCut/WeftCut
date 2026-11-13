import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PREVIEW_SNAP_STRENGTH_MAX_PX,
  PREVIEW_SNAP_STRENGTH_MIN_PX,
  TAIL_SNAP_STRENGTH_MAX_PX,
  TAIL_SNAP_STRENGTH_MIN_PX,
  type AppSettingsPatch,
} from "../../shared/app-settings";
import { GRID_OPACITY_MIN_VISIBLE } from "../../shared/preview-grid";
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
        disabled={!enabled}
        slider={!compact}
        onSave={(next) => save({ preview_snap_strength_px: next }, onError)}
      />
    </>
  );
}

export function GridOpacitySettings({ onError }: { onError: ReportError }) {
  const { t } = useTranslation();
  const opacity = usePreviewGrid().opacity;
  // The slider never reaches 0% from a visible grid; the toolbar's eye is
  // the deliberate hide action. Its 0% state remains representable here.
  const minimum = opacity === 0 ? 0 : GRID_OPACITY_MIN_VISIBLE;
  return (
    <SnapNumber
      label={t("quick_actions.grid_opacity")}
      value={opacity}
      min={minimum}
      max={100}
      unit="%"
      slider
      onSave={(next) => save({ preview_grid: { opacity: Math.max(GRID_OPACITY_MIN_VISIBLE, next) } }, onError)}
    />
  );
}
