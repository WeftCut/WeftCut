import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppDialog } from "../components/AppDialog";
import { refusalText } from "../errors/tryMutate";
import { projectPortability, trashUntrackedMotifFolder, type PortabilityReport } from "../ipc";
import { requestSettings } from "../settings/settingsRequest";
import { PortabilityReportList } from "./PortabilityReportList";

/// File > Check portability: the open project's report, read on open and
/// again after each action.
export function PortabilityDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<PortabilityReport | null>(null);
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
    return () => { alive.current = false; };
  }, [reload]);

  const trash = async (name: string) => {
    setBusy(true);
    setError(null);
    try { await trashUntrackedMotifFolder(name); } catch (e) { if (alive.current) setError(refusalText(e)); }
    await reload();
    if (alive.current) setBusy(false);
  };

  return (
    <AppDialog title={t("portability.title")} panelClassName="settings-panel portability-dialog" onClose={onClose}>
      <div className="settings-body">
        <div className="settings-card">
          {error && <p className="settings-error" role="alert">{error}</p>}
          {report
            ? <PortabilityReportList report={report} busy={busy} onTrashFolder={(name) => void trash(name)}
              onOpenFonts={() => { onClose(); requestSettings("project"); }} />
            : !error && <p className="settings-status">{t("portability.loading")}</p>}
        </div>
      </div>
    </AppDialog>
  );
}
