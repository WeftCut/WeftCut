import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { reveal as revealInShell } from "@/bridge/shell";
import { AppSelect } from "../components/AppSelect";
import { formatBytes } from "../lib/formatBytes";
import {
  onProjectFontsChanged,
  projectFontsAllow,
  projectFontsExclude,
  projectFontsView,
  type ProjectFontsView,
} from "../ipc";

/// Settings > Project > Fonts (ADR 0176): what the project has copied into
/// `Fonts/` and the families it never copies. Not an undoable edit, like
/// Canvas. Mounted only while a project is open.
export function ProjectFontsSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ProjectFontsView | null>(null);
  // Fetches race the changed event: only the newest answer lands.
  const latest = useRef(0);

  const apply = useCallback(async (request: () => Promise<ProjectFontsView | null>) => {
    const seq = ++latest.current;
    try {
      const next = await request();
      if (seq === latest.current) setView(next);
    } catch (err) {
      onError(String(err));
    }
  }, [onError]);

  useEffect(() => {
    void apply(projectFontsView);
    return onProjectFontsChanged(() => void apply(projectFontsView));
  }, [apply]);

  const copied = view?.copied ?? [];
  const bytes = copied.reduce((sum, family) => sum + family.bytes, 0);
  // A family not installed here stays in the record but is not offered:
  // Allow copying would have nothing to copy from.
  const excluded = (view?.excluded ?? []).filter((family) => family.installed);

  return (
    <section className="settings-section" data-testid="project-fonts">
      <h3>{t("settings.fonts_heading")}</h3>
      <p className="settings-blurb">{t("settings.fonts_blurb")}</p>
      <p className="settings-warn">{t("settings.fonts_licence")}</p>

      <div className="settings-control-row">
        <span className="settings-toggle-label">
          {copied.length > 0
            ? t("settings.fonts_copied", { count: copied.length, size: formatBytes(bytes) })
            : t("settings.fonts_none")}
        </span>
        <Button
          size="sm"
          disabled={view === null || copied.length === 0}
          onClick={() => {
            if (view) void revealInShell(view.dir).catch((err: unknown) => onError(String(err)));
          }}
        >
          {t("settings.fonts_show")}
        </Button>
      </div>

      {excluded.length > 0 && (
        <div role="group" aria-label={t("settings.fonts_excluded")}>
          <span className="settings-toggle-label">{t("settings.fonts_excluded")}</span>
          {excluded.map(({ family }) => (
            <div key={family} className="settings-control-row">
              <span className="settings-font-family">{family}</span>
              <Button size="sm" onClick={() => void apply(() => projectFontsAllow(family))}>
                {t("settings.fonts_allow")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="settings-control-row">
        <span className="settings-toggle-label">{t("settings.fonts_add_exclusion")}</span>
        {/* A picker that acts on choice: it never holds a selection, so the
            trigger always reads the placeholder. */}
        <AppSelect
          value=""
          className="settings-select"
          ariaLabel={t("settings.fonts_add_exclusion")}
          placeholder={t("settings.fonts_add_placeholder")}
          disabled={copied.length === 0}
          options={copied.map((family) => ({
            value: family.family,
            label: t("settings.fonts_option", {
              family: family.family,
              files: family.files,
              count: family.files,
              size: formatBytes(family.bytes),
            }),
          }))}
          onValueChange={(family) => {
            if (family) void apply(() => projectFontsExclude(family));
          }}
        />
      </div>
    </section>
  );
}
