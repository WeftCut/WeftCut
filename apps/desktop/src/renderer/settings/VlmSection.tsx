import { ModelSection } from "./ModelSection";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsGetVlmBackends, settingsSetVlmDescribe, type VlmDescribeFocus } from "../ipc";
import { VLM_DESCRIBE_FPS_MAX, VLM_DESCRIBE_FPS_MIN, VLM_DESCRIBE_FPS_STEP } from "../../shared/vlm-config";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { onDescribeViewChanged } from "../search/searchIndexStore";

export function VlmSection({ onError }: { onError: (msg: string) => void }) {
  return <ModelSection family="vlm" onError={onError} advancedContent={<DescribeSettings onError={onError} />} />;
}

function DescribeSettings({ onError }: { onError(msg: string): void }) {
  const { t } = useTranslation();
  const [fps, setFps] = useState<number | null>(null);
  const [focus, setFocus] = useState<VlmDescribeFocus>("general");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const view = await settingsGetVlmBackends();
    setFps(view.describe_fps); setFocus(view.describe_focus);
  };
  useEffect(() => { void refresh().catch(e => onError(String(e))); }, []);
  const save = async (patch: { fps?: number; focus?: VlmDescribeFocus }) => {
    setBusy(true);
    try { await settingsSetVlmDescribe(patch); await refresh(); onDescribeViewChanged(); }
    catch (e) { onError(String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.vlm_sampling")}</span>
      <AppNumberField value={fps} min={VLM_DESCRIBE_FPS_MIN} max={VLM_DESCRIBE_FPS_MAX} step={VLM_DESCRIBE_FPS_STEP}
        disabled={busy} ariaLabel={t("settings.vlm_sampling")} onValueChange={setFps} onCommit={value => { void save({ fps: value }); }} />
    </div>
    <div className="settings-key-input-row"><span className="settings-slider-label">{t("settings.vlm_focus")}</span>
      <AppSelect value={focus} disabled={busy} ariaLabel={t("settings.vlm_focus")}
        options={[{ value: "general", label: t("settings.vlm_focus_general") }, { value: "shot-type", label: t("settings.vlm_focus_shot_type") }]}
        onValueChange={value => void save({ focus: value as VlmDescribeFocus })} />
    </div>
  </>;
}
