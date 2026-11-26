// The selected Motif layer's project Motif itself, as rows of the property
// panel's Motif section: its state against the library with the same actions
// the Motifs panel's row offers (motifs/motifRows.ts), and the folder its files
// are edited in. The project's Motif is the one being edited: every clip of it
// changes, with no approval (spec § Project Motifs, "Edited in place, no
// approval").
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { refusalText } from "../errors/tryMutate";
import { open as openPath } from "@/bridge/shell";
import { listMotifCatalog, updateProjectMotif, type MotifCatalog, type ProjectMotifRow } from "../ipc";
import { canSaveToLibrary, libraryTake } from "../motifs/motifRows";
import { useSaveToLibrary } from "../motifs/SaveToLibrary";
import { motifCatalogRevision, subscribeMotifCatalog } from "../render/motifs/catalog";
import { Field } from "./Field";

/// The property panel section holding a Motif layer's props and these rows;
/// "New Motif" opens it on the layer it places.
export const MOTIF_SECTION = "motif";

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

/// Project Motif `motifId`'s Library row and, when `files`, its Files row.
/// Why a Motif cannot render is said above these rows, by the section.
export function MotifPackageRows({ motifId, files }: { motifId: string; files: boolean }) {
  const catalog = useMotifCatalog();
  const row = catalog?.project.find((r) => r.id === motifId);
  if (!row) return null;
  return (
    <div className="prop-motif-package">
      <LibraryRow row={row} libraryName={(id) => catalog?.library.find((r) => r.id === id)?.motif.name} />
      {files ? <FilesRow path={row.path} /> : null}
    </div>
  );
}

/// The Motif's state against the library and what can be done with it.
/// Removal is not offered: the selected layer uses it, so it would be refused.
function LibraryRow({
  row,
  libraryName,
}: {
  row: ProjectMotifRow;
  libraryName: (id: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSaveToLibrary(libraryName);

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
    <Field label={t("property_panel.motif_library")} as="div">
      <div className="prop-motif-row-value">
        <div className="prop-motif-actions">
          <span className={`motif-card-status status-${state}`}>{t(`motif_picker.status.${state}`)}</span>
          {take && (
            <Button size="sm" disabled={busy} title={t(`motif_picker.${take}_hint`)} onClick={run(async () => {
              const { unfinished } = await updateProjectMotif(row.id);
              if (unfinished) setNotice(t("motif_picker.unfinished_moved", { path: unfinished }));
            })}>
              {t(`motif_picker.${take}_button`)}
            </Button>
          )}
          {canSaveToLibrary(row) && (
            <Button size="sm" disabled={busy} onClick={run(() => save.start(row.id))}>
              {t("motif_picker.save_button")}
            </Button>
          )}
        </div>
        {err && <p className="settings-error">{err}</p>}
        {notice && <p className="prop-hint" role="status">{notice}</p>}
        {save.dialog}
      </div>
    </Field>
  );
}

/// Where the Motif lives, to edit it with the user's own tools. Saving there is
/// all an edit takes: the project's `Motifs/` is watched, and each save that
/// leaves a valid package is one undo step (docs/motif-workspaces.md § Editing
/// in place). The folder opens rather than a file in it: a `.html` file's
/// default handler is a browser, not an editor.
function FilesRow({ path }: { path: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openFolder = () => {
    setErr(null);
    openPath(path).catch((e: unknown) => setErr(refusalText(e)));
  };
  const copyPath = () => {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, (e: unknown) => setErr(refusalText(e)));
  };

  return (
    <Field label={t("property_panel.motif_files")} hint={t("property_panel.motif_files_hint")} as="div">
      <div className="prop-motif-row-value">
        <code className="prop-motif-files-path" title={path}>{path}</code>
        <div className="prop-motif-actions">
          <Button size="sm" onClick={openFolder}>{t("property_panel.motif_files_open")}</Button>
          <Button size="sm" onClick={copyPath}>
            {copied ? t("property_panel.motif_files_copied") : t("property_panel.motif_files_copy")}
          </Button>
        </div>
        {err && <p className="settings-error">{err}</p>}
      </div>
    </Field>
  );
}
