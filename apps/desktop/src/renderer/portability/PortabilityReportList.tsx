// The portability check's report as rows (`PortabilityReport`, main
// `state/portability.ts`): what the project folder does not carry, by group,
// and the folders under `Motifs/` a copy leaves behind. Shown by the check
// dialog (`PortabilityDialog.tsx`); the hosting dialog owns the fetch and the
// actions.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { PortabilityReport } from "../ipc";

interface Props {
  report: PortabilityReport;
  /// An action is in flight: row actions wait.
  busy: boolean;
  onTrashFolder: (name: string) => void;
  /// Settings > Project > Fonts, where exclusions are managed.
  onOpenFonts: () => void;
}

export function PortabilityReportList({ report, busy, onTrashFolder, onOpenFonts }: Props) {
  const { t } = useTranslation();
  const { media, motifs, fonts, style } = report;
  return (
    <div className="portability-report">
      <p className="settings-blurb">{t(report.portable ? "portability.portable" : "portability.lead")}</p>
      <Group title={t("portability.media_outside")} rows={media.outside.map((m) => (
        <Row key={m.media_id} name={m.label} detail={m.path} />
      ))} />
      <Group title={t("portability.media_missing")} rows={media.missing.map((m) => (
        <Row key={m.media_id} name={m.label} detail={m.path} />
      ))} />
      <Group title={t("portability.motifs_missing")} rows={motifs.missing.map((m) => (
        <Row key={m.motif_id} name={m.motif_id} />
      ))} />
      {/* The package error names files and manifest fields: shown as written. */}
      <Group title={t("portability.motifs_invalid")} rows={motifs.invalid.map((m) => (
        <Row key={m.motif_id} name={m.motif_id} detail={m.diagnostic} />
      ))} />
      <Group title={t("portability.fonts_excluded")}
        action={<Button variant="secondary" size="xs" onClick={onOpenFonts}>{t("portability.fonts_manage")}</Button>}
        rows={fonts.excluded.map((f) => (
          <Row key={f.family} name={f.family}
            tag={t(f.installed ? "portability.excluded" : "portability.excluded_not_installed")} />
        ))} />
      <Group title={t("portability.fonts_missing")} rows={fonts.missing.map((f) => {
        const face = [f.weight, f.italic ? t("portability.italic") : null].filter((part) => part !== null).join(" ");
        return <Row key={`${f.family}:${f.weight}:${f.italic}`} name={f.family} {...(face ? { detail: face } : {})} />;
      })} />
      <Group title={t("portability.style_outside")}
        rows={style.outside === null ? [] : [<Row key="style" name={style.outside} />]} />
      <Group title={t("portability.untracked")} hint={t("portability.untracked_hint")}
        rows={motifs.untracked.map((name) => (
          <Row key={name} name={`Motifs/${name}/`}
            action={
              <Button variant="secondary" size="xs" disabled={busy}
                aria-label={t("portability.trash_folder", { name })} onClick={() => onTrashFolder(name)}>
                {t("portability.trash")}
              </Button>
            } />
        ))} />
    </div>
  );
}

/** A titled group; nothing when it has no rows. */
function Group({ title, hint, action, rows }: { title: string; hint?: string; action?: ReactNode; rows: ReactNode[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="portability-group" aria-label={title}>
      <div className="portability-group-head">
        <h3>{title}</h3>
        {action}
      </div>
      {hint && <p className="settings-status">{hint}</p>}
      <ul className="portability-list">{rows}</ul>
    </section>
  );
}

function Row({ name, detail, tag, action }: { name: string; detail?: string; tag?: string; action?: ReactNode }) {
  return (
    <li className="portability-row">
      <span className="portability-row-text">
        <span className="portability-row-name">{name}</span>
        {detail && <span className="portability-row-detail">{detail}</span>}
      </span>
      {tag && <span className="portability-row-tag">{tag}</span>}
      {action}
    </li>
  );
}
