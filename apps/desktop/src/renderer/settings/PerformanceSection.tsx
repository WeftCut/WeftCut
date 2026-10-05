import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { ChevronDownIcon } from "lucide-react";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import {
  PERFORMANCE_DEFAULTS, PERFORMANCE_FIELDS,
  type PerformanceKey, type PerformanceSettings,
} from "../../shared/performance-settings";
import {
  PERFORMANCE_PRESETS, PERFORMANCE_TIERS, performancePresetOf, performanceGroupTierOf,
  performanceGroupPatch, isPerformanceTier, type PerformanceGroup,
} from "../../shared/performance-presets";
import { setAppSettings, useAppSettingsStore } from "./appSettingsStore";

const GROUPS = [
  { title: "performance.preview_heading", fields: ["preview_gpu_sessions", "preview_gpu_pixel_area", "preview_gpu_pool_slots", "frame_ring_mib"] },
  { title: "performance.motif_heading", fields: ["motif_cache_mib", "motif_gpu_mib", "motif_gpu_sessions"] },
  { title: "performance.timeline_heading", fields: ["filmstrip_cache_mib", "waveform_cache_mib"] },
] as const;

type Save = (patch: Partial<PerformanceSettings> | null) => Promise<PerformanceSettings | null>;

export function PerformanceSection({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const settings = useAppSettingsStore(s => s.settings.performance ?? PERFORMANCE_DEFAULTS);
  const loaded = useAppSettingsStore(s => s.loaded);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const advancedId = useId();
  const preset = performancePresetOf(settings);
  const disabled = !loaded || saving;

  const save: Save = async patch => {
    setSaving(true);
    onError("");
    try {
      const after = await setAppSettings({ performance: patch });
      return after.performance ?? PERFORMANCE_DEFAULTS;
    } catch (error) {
      onError(String(error));
      return null;
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p className="settings-blurb">{t("performance.description")}</p>
      <section className="settings-section">
        <div className="settings-performance-heading">
          <h3>{t("performance.simple_heading")}</h3>
          <span className="settings-toggle-hint" aria-live="polite" data-testid="performance-preset-status">
            {t("performance.current", { name: t(`performance.${preset}`) })}
          </span>
        </div>
        <RadioGroup className="settings-radio-cards" value={preset}
          aria-label={t("performance.preset_label")}
          onValueChange={next => { if (isPerformanceTier(next)) void save(PERFORMANCE_PRESETS[next]); }}>
          {PERFORMANCE_TIERS.map(tier => (
            <Radio.Root key={tier} value={tier} disabled={disabled} className="settings-radio-card">
              <span className="settings-radio-card-dot" aria-hidden="true">
                <Radio.Indicator className="settings-radio-card-indicator" />
              </span>
              <span className="settings-radio-card-text">
                <span className="settings-radio-card-title">{t(`performance.${tier}`)}</span>
                <span className="settings-radio-card-desc">{t(`performance.${tier}_hint`)}</span>
              </span>
            </Radio.Root>
          ))}
        </RadioGroup>
        <p className="settings-toggle-hint">{t("performance.preset_hint")}</p>
      </section>
      <section className="settings-section">
        <h3>{t("performance.adjust_heading")}</h3>
        {(["cache", "parallel"] as const).map(group => (
          <PerformanceGroupControl key={group} group={group} settings={settings} disabled={disabled} save={save} />
        ))}
      </section>
      <section className="settings-section">
        <Button variant="ghost" className="settings-performance-disclosure"
          aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(open => !open)}>
          <ChevronDownIcon size={14} aria-hidden="true" />
          {t("performance.advanced_heading")}
        </Button>
        <p className="settings-toggle-hint">{t("performance.advanced_hint")}</p>
      </section>
      <div id={advancedId} hidden={!advanced}>
        {GROUPS.map(group => (
          <section className="settings-section" key={group.title}>
            <h3>{t(group.title)}</h3>
            {group.fields.map(field => (
              <PerformanceField key={field} field={field} value={settings[field]}
                disabled={disabled} save={save} />
            ))}
          </section>
        ))}
      </div>
      <section className="settings-section">
        <p className="settings-toggle-hint">{t("performance.activation")}</p>
        <div className="settings-control-row">
          <Button variant="secondary" disabled={disabled} onClick={() => void save(null)}>
            {t("performance.reset")}
          </Button>
        </div>
      </section>
    </>
  );
}

function PerformanceGroupControl({ group, settings, disabled, save }: {
  group: PerformanceGroup;
  settings: PerformanceSettings;
  disabled: boolean;
  save: Save;
}) {
  const { t } = useTranslation();
  const tier = performanceGroupTierOf(settings, group);
  return (
    <div className="settings-control-row settings-performance-row">
      <div className="settings-performance-copy">
        <span className="settings-toggle-label">{t(`performance.${group}_label`)}</span>
        <p className="settings-toggle-hint">{t(`performance.${group}_hint`)}</p>
      </div>
      <AppSelect className="settings-performance-tier" value={tier} disabled={disabled}
        ariaLabel={t(`performance.${group}_label`)}
        options={[
          ...(tier === "custom" ? [{ value: "custom", label: t("performance.custom"), disabled: true }] : []),
          ...PERFORMANCE_TIERS.map(value => ({ value, label: t(`performance.${value}`) })),
        ]}
        onValueChange={next => { if (isPerformanceTier(next)) void save(performanceGroupPatch(group, next)); }} />
    </div>
  );
}

function PerformanceField({ field, value, disabled, save }: {
  field: PerformanceKey;
  value: number;
  disabled: boolean;
  save: Save;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const spec = PERFORMANCE_FIELDS[field];
  // Display megapixels while retaining the exact integer-pixel wire value.
  const scale = field === "preview_gpu_pixel_area" ? 1_000_000 : 1;
  const [draft, setDraft] = useState(value / scale);
  useEffect(() => { setDraft(value / scale); }, [value, scale]);
  const unit = spec.unit === "MiB" ? "MiB"
    : field === "preview_gpu_pixel_area" ? t("performance.unit_megapixels")
    : field === "preview_gpu_pool_slots" ? t("performance.unit_frames")
    : field === "motif_gpu_sessions" ? t("performance.unit_groups")
    : t("performance.unit_videos");

  const commit = async (displayValue: number) => {
    const next = Math.round(displayValue * scale);
    if (next === value) return;
    const after = await save({ [field]: next });
    setDraft((after?.[field] ?? value) / scale);
  };

  return (
    <div className="settings-control-row settings-performance-row">
      <div className="settings-performance-copy">
        <span className="settings-toggle-label">{t(`performance.${field}`)}</span>
        <p className="settings-toggle-hint" id={hintId}>{t(`performance.${field}_hint`)}</p>
      </div>
      <div className="settings-performance-value">
        <AppNumberField
          value={draft} min={spec.min / scale} max={spec.max / scale}
          step={scale === 1 ? 1 : 0.1}
          format={{ maximumFractionDigits: scale === 1 ? 0 : 6 }}
          className="settings-input" align="center"
          ariaLabel={t(`performance.${field}`)} ariaDescribedBy={hintId}
          disabled={disabled} onValueChange={setDraft}
          onCommit={v => void commit(v)}
        />
        <span className="settings-slider-unit">{unit}</span>
      </div>
    </div>
  );
}
