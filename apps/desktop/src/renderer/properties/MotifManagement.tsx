// The selected Motif layer's project Motif itself, as rows of the property
// panel's Motif section: its version against the library with the same actions
// the Motifs panel's row offers (motifs/motifRows.ts), and the folder its
// source is edited in. The project's Motif is the one being edited: every clip of it
// changes, with no approval (spec § Project Motifs, "Edited in place, no
// approval").
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { refusalText } from "../errors/tryMutate";
import { open as openPath } from "@/bridge/shell";
import { listMotifCatalog, updateProjectMotif, type MotifCatalog, type ProjectMotifRow } from "../ipc";
import { canSaveToLibrary, libraryRowOf, libraryTake, versionGap, type VersionGap } from "../motifs/motifRows";
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

/// Project Motif `motifId`'s Version row and, when `files`, its Source row.
/// Why a Motif cannot render is said above these rows, by the section.
export function MotifPackageRows({ motifId, files }: { motifId: string; files: boolean }) {
  const catalog = useMotifCatalog();
  const row = catalog?.project.find((r) => r.id === motifId);
  if (!row) return null;
  return (
    <div className="prop-motif-package">
      <VersionRow
        row={row}
        gap={versionGap(row, libraryRowOf(row, catalog?.library ?? []))}
        libraryName={(id) => catalog?.library.find((r) => r.id === id)?.motif.name}
      />
      {files ? <SourceRow path={row.path} /> : null}
    </div>
  );
}

/// This project's copy against the library's version of its lineage, and what
/// can be done about it. Removal is not offered: the selected layer uses the
/// Motif, so it would be refused.
function VersionRow({
  row,
  gap,
  libraryName,
}: {
  row: ProjectMotifRow;
  /// How the two differ, said under the state when they do.
  gap: VersionGap | null;
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
    <Field label={t("property_panel.motif_version")} hint={t("property_panel.motif_version_hint")} as="div">
      <div className="prop-motif-version">
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
        {gap && <p className="prop-motif-version-gap">{t(`property_panel.motif_version_${gap.kind}`, gap)}</p>}
        {err && <p className="settings-error">{err}</p>}
        {notice && <p className="prop-hint" role="status">{notice}</p>}
        {save.dialog}
      </div>
    </Field>
  );
}

/// The Motif's source: the folder it lives in, to edit with the user's own tools. Saving there is
/// all an edit takes: the project's `Motifs/` is watched, and each save that
/// leaves a valid package is one undo step (docs/motif-workspaces.md § Editing
/// in place). The folder opens rather than a file in it: a `.html` file's
/// default handler is a browser, not an editor.
function SourceRow({ path }: { path: string }) {
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
    <Field label={t("property_panel.motif_source")} hint={t("property_panel.motif_source_hint")} as="div">
      <div className="prop-motif-source">
        <code className="prop-motif-source-path" title={path}>{path}</code>
        <div className="prop-motif-actions">
          <Button size="sm" onClick={openFolder}>{t("property_panel.motif_source_open")}</Button>
          <Button size="sm" onClick={copyPath}>
            {copied ? t("property_panel.motif_source_copied") : t("property_panel.motif_source_copy")}
          </Button>
        </div>
        {err && <p className="settings-error">{err}</p>}
      </div>
    </Field>
  );
}
