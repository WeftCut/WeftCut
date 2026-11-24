import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@/bridge/dialog";
import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { refusalText } from "../errors/tryMutate";
import { formatBytes } from "../lib/formatBytes";
import { projectPackPlan, projectPortability, trashUntrackedMotifFolder, type PackPlan, type PortabilityReport } from "../ipc";
import { PortabilityReportList } from "../portability/PortabilityReportList";
import { requestSettings } from "../settings/settingsRequest";
import { PACK_EXTENSION } from "../../shared/projectPack";
import { runPack } from "./packJobs";

/// File > Pack project: the portability report with its actions, what the
/// pack will hold, then the file to write. The pack runs in the work pill once
/// a file is picked; this dialog closes.
export function PackDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<PortabilityReport | null>(null);
  const [plan, setPlan] = useState<PackPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(() => projectPortability().then(
    (next) => { if (alive.current) setReport(next); },
    (e: unknown) => { if (alive.current) setError(refusalText(e)); },
  ), []);
  useEffect(() => {
    alive.current = true;
    void reload();
    void projectPackPlan().then(
      (next) => { if (alive.current) setPlan(next); },
      (e: unknown) => { if (alive.current) setError(refusalText(e)); },
    );
    return () => { alive.current = false; };
  }, [reload]);

  const trash = async (name: string) => {
    setBusy(true);
    setError(null);
    try { await trashUntrackedMotifFolder(name); } catch (e) { if (alive.current) setError(refusalText(e)); }
    await reload();
    if (alive.current) setBusy(false);
  };

  const pack = async () => {
    if (!plan) return;
    setBusy(true);
    const archive = await saveDialog({
      title: t("pack.save_title"),
      defaultPath: plan.file_name,
      filters: [{ name: t("pack.filter"), extensions: [PACK_EXTENSION] }],
    });
    if (!alive.current) return;
    setBusy(false);
    if (typeof archive !== "string") return;
    onClose();
    void runPack(t, archive);
  };

  return (
    <AppDialog title={t("pack.title")} panelClassName="settings-panel portability-dialog" onClose={onClose}>
      <div className="settings-body">
        <div className="settings-card">
          {error && <p className="settings-error" role="alert">{error}</p>}
          {report
            ? <PortabilityReportList report={report} busy={busy} onTrashFolder={(name) => void trash(name)}
              onOpenFonts={() => { onClose(); requestSettings("project"); }} />
            : !error && <p className="settings-status">{t("portability.loading")}</p>}
          {plan && (
            <p className="settings-blurb">
              {t("pack.size", { count: plan.files, size: formatBytes(plan.bytes) })}
            </p>
          )}
          <p className="settings-status">{t("pack.licence")}</p>
        </div>
      </div>
      <footer className="new-project-actions pack-dialog-actions">
        <Button size="lg" onClick={onClose}>{t("pack.cancel")}</Button>
        <Button variant="default" size="lg" disabled={!plan || busy} onClick={() => void pack()}>{t("pack.pack")}</Button>
      </footer>
    </AppDialog>
  );
}
