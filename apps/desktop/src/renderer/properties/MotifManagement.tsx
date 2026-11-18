// The selected Motif layer's project Motif, managed from the property panel:
// its state against the library with the same actions the Motifs panel's row
// offers (motifs/motifRows.ts), and its source, edited in place. The project's
// Motif is the one being edited: every clip of it changes, with no approval
// (spec § Project Motifs, "Edited in place, no approval").
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { refusalText } from "../errors/tryMutate";
import {
  getMotifSource,
  listMotifCatalog,
  updateMotifSource,
  updateProjectMotif,
  type MotifCatalog,
} from "../ipc";
import { MotifProblem } from "../motifs/MotifProblem";
import { canSaveToLibrary, libraryTake } from "../motifs/motifRows";
import { useSaveToLibrary } from "../motifs/SaveToLibrary";
import { motifCatalogRevision, subscribeMotifCatalog } from "../render/motifs/catalog";

/// The panel's catalog, pulled again whenever the render catalog changes
/// (every `motifs:changed` lands there first). Null until the first answer.
function useMotifCatalog(): MotifCatalog | null {
  const revision = useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  const [catalog, setCatalog] = useState<MotifCatalog | null>(null);
  useEffect(() => {
    let alive = true;
    listMotifCatalog().then((c) => { if (alive) setCatalog(c); }, () => {});
    return () => { alive = false; };
  }, [revision]);
  return catalog;
}

/// Project Motif `motifId`'s state and what can be done with it. Removal is
/// not offered here: the selected layer uses it, so it would be refused.
export function MotifManagementRow({ motifId }: { motifId: string }) {
  const { t } = useTranslation();
  const catalog = useMotifCatalog();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSaveToLibrary((id) => catalog?.library.find((r) => r.id === id)?.motif.name);
  const row = catalog?.project.find((r) => r.id === motifId);
  if (!row) return null;

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setErr(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const state = row.status === "ok" ? row.state : row.status;
  const take = libraryTake(row);
  return (
    <div className="prop-motif-lifecycle">
      <span className={`motif-card-status status-${state}`}>{t(`motif_picker.status.${state}`)}</span>
      {take && (
        <Button size="sm" disabled={busy} title={t(`motif_picker.${take}_hint`)} onClick={run(async () => {
          const { unfinished } = await updateProjectMotif(motifId);
          if (unfinished) setNotice(t("motif_picker.unfinished_moved", { path: unfinished }));
        })}>
          {t(`motif_picker.${take}_button`)}
        </Button>
      )}
      {canSaveToLibrary(row) && (
        <Button size="sm" disabled={busy} onClick={run(() => save.start(motifId))}>
          {t("motif_picker.save_button")}
        </Button>
      )}
      {row.status !== "ok" && <MotifProblem id={row.id} status={row.status} diagnostic={row.diagnostic} />}
      {err && <p className="settings-error">{err}</p>}
      {notice && <p className="prop-hint" role="status">{notice}</p>}
      {save.dialog}
    </div>
  );
}

/// In-app source editor for the selected layer's project Motif. See
/// docs/motifs.md. Deliberately minimal: a plain textarea of the Motif's full
/// composed source (manifest island + body). "Apply" writes it through
/// `updateMotifSource`, refused when the folder changed since it was read;
/// `motifs:changed` → the catalog resyncs (new content_hash) → the canvas
/// preview re-captures.
export function MotifSourcePanel({ motifId }: { motifId: string }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(null);
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the textarea from the project folder whenever the Motif changes.
  useEffect(() => {
    let alive = true;
    setErr(null);
    setSource(null);
    getMotifSource(motifId)
      .then((s) => { if (alive) { setSource(s.html); setRevision(s.revision); } })
      .catch((e) => { if (alive) setErr(refusalText(e)); });
    return () => { alive = false; };
  }, [motifId]);

  const apply = async () => {
    if (source == null) return;
    setBusy(true);
    setErr(null);
    try {
      setRevision(await updateMotifSource(motifId, source, revision));
    } catch (e) {
      setErr(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prop-motif-source">
      <p className="prop-hint">{t("property_panel.motif_source_hint")}</p>
      <textarea
        className="prop-motif-source-text"
        aria-label={t("property_panel.motif_source")}
        spellCheck={false}
        value={source ?? ""}
        disabled={source == null || busy}
        onChange={(e) => setSource(e.target.value)}
      />
      <Button size="sm" disabled={busy || source == null} onClick={apply}>
        {busy ? t("property_panel.motif_source_applying") : t("property_panel.motif_source_apply")}
      </Button>
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
