import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { GRID_OPACITY_MAX, GRID_OPACITY_MIN } from "../../shared/preview-grid";
import { AppNumberField } from "../components/AppNumberField";
import { AppSlider } from "../components/AppSlider";
import { setAppSettings, usePreviewGridOpacity } from "./appSettingsStore";

const clampOpacity = (value: number) =>
  Math.round(Math.min(GRID_OPACITY_MAX, Math.max(GRID_OPACITY_MIN, value)));

/// How strongly the preview grid is drawn. The same shape as the snap strength
/// rows above it: draft state on the slider, commit on release, roll back on
/// error.
export function GridOpacitySection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const opacity = usePreviewGridOpacity();
  const [draft, setDraft] = useState(opacity);

  useEffect(() => {
    setDraft(opacity);
  }, [opacity]);

  const commit = async (value: number) => {
    const next = clampOpacity(value);
    setDraft(next);
    onError("");
    try {
      await setAppSettings({ preview_grid: { opacity: next } });
    } catch (e) {
      onError(String(e));
      setDraft(opacity);
    }
  };

  const label = t("settings.grid_opacity");
  return (
    <div className="settings-slider-row">
      <span className="settings-slider-label">{label}</span>
      <AppSlider
        min={GRID_OPACITY_MIN}
        max={GRID_OPACITY_MAX}
        value={draft}
        onValueChange={setDraft}
        onValueCommitted={(v) => void commit(v)}
        ariaLabel={label}
      />
      <AppNumberField value={draft} min={GRID_OPACITY_MIN} max={GRID_OPACITY_MAX}
        align="center" className="settings-input-narrow" ariaLabel={label}
        onValueChange={setDraft} onCommit={(v) => void commit(v)} />
      <span className="settings-slider-unit">%</span>
    </div>
  );
}
