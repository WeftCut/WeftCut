import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { listMotifVersions, restoreMotifVersion, type MotifSummary, type MotifVersion } from "../ipc";

/// An installed Motif's saved versions, newest first (ADR 0172). The newest is
/// the current one; restoring an older one saves it again as the newest.
export function MotifVersionHistory({ motif, onClose }: { motif: MotifSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<MotifVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = () => listMotifVersions(motif.id).then(
    list => { if (alive.current) setVersions(list); },
    e => { if (alive.current) setError(String(e)); },
  );
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
    // reload closes over the id only, which keys this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motif.id]);

  const restore = async (version: number) => {
    setBusy(true);
    setError(null);
    try {
      await restoreMotifVersion(motif.id, version);
      await reload();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <AppDialog title={t("motif_picker.history_title", { name: motif.name })}
      panelClassName="settings-panel motif-history-dialog" onClose={busy ? undefined : onClose}>
      <div className="settings-body">
        <div className="settings-card">
          {error && <p className="settings-error" role="alert">{error}</p>}
          {versions === null
            ? !error && <p className="settings-status">{t("motif_picker.history_loading")}</p>
            : <ul className="motif-history-list">
              {versions.map((v, i) => (
                <li key={v.version} className="motif-history-row">
                  <span className="motif-history-version">{t("motif_picker.history_version", { version: v.version })}</span>
                  <span className="motif-history-date">{new Date(v.saved_at).toLocaleString()}</span>
                  {i === 0
                    ? <span className="motif-history-current">{t("motif_picker.history_current")}</span>
                    : <Button size="sm" disabled={busy} onClick={() => void restore(v.version)}
                      aria-label={t("motif_picker.history_restore_version", { version: v.version })}>
                      {t("motif_picker.history_restore")}
                    </Button>}
                </li>
              ))}
            </ul>}
        </div>
      </div>
    </AppDialog>
  );
}
