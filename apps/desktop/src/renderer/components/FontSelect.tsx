import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_CAPTION_FONT_FAMILY, BUNDLED_FONT_FAMILIES } from "../../shared/fonts";
import { AppSelect } from "./AppSelect";
import { getSystemFontFamilies } from "./fontFamilies";

export function FontSelect({ value, onValueChange, ariaLabel, defaultValue = DEFAULT_CAPTION_FONT_FAMILY }: {
  value: string;
  onValueChange: (family: string) => void;
  ariaLabel: string;
  /** Settings uses the empty value to clear the preference. */
  defaultValue?: string;
}) {
  const { t } = useTranslation();
  const [families, setFamilies] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus("loading");
    getSystemFontFamilies().then((names) => {
      if (active) { setFamilies(names); setStatus("ready"); }
    }).catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [attempt]);

  const names = new Map<string, string>();
  for (const family of [...BUNDLED_FONT_FAMILIES, ...families]) {
    if (!names.has(family.toLowerCase())) names.set(family.toLowerCase(), family);
  }
  // Preserve fonts from other machines, and CSS fallback chains from projects.
  // Loading or an unavailable font must never silently rewrite the selection.
  if (value && value !== defaultValue) names.set(value.toLowerCase(), value);
  const options = [
    { value: defaultValue, label: t("fonts.app_default") },
    ...[...names.values()].filter((name) => name !== defaultValue)
      .sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name })),
  ];
  return <div className="font-select">
    <AppSelect value={value} onValueChange={onValueChange} options={options} ariaLabel={ariaLabel} popupClassName="font-select-popup" />
    {status === "loading" && <small role="status">{t("fonts.loading")}</small>}
    {status === "error" && <small role="alert">
      {t("fonts.load_failed")} <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t("fonts.retry")}</button>
    </small>}
  </div>;
}
