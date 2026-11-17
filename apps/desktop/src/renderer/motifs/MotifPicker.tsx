// The Motifs panel: the open project's Motifs and the library's, in two
// groups (spec § Project Motifs, "Panel"). Placing a library Motif copies it
// into the project in the same undo step; there is no separate "add to
// project". A project row says what it needs (an update, edits not in the
// library, a broken folder) and offers it; library rows keep placing, ZIP
// export, version history and the trash. An agent's proposals sit on top.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInputIcon, PlusIcon } from "lucide-react";
import { MotifCard } from './MotifCard';
import { MotifProposalList, useMotifProposals } from './MotifProposalCard';
import { MotifVersionHistory } from './MotifVersionHistory';
import { useSaveToLibrary } from './SaveToLibrary';
import { matchRows, previewMotif, rowKey, rowName, type MotifRow } from './motifRows';
import { listen } from "@/bridge/events";
import { open as openDialog, save as saveDialog } from "@/bridge/dialog";
import { formatTimecode } from "../frames";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import {
  createProjectMotif,
  deleteLibraryMotif,
  exportMotif,
  importMotif,
  listMotifCatalog,
  MOTIFS_CHANGED_EVENT,
  removeProjectMotif,
  updateProjectMotif,
  type LibraryMotifRow,
  type MotifCatalog,
  type MotifSummary,
  type TrackSummary,
} from "../ipc";
import { addMotifIn } from "../ipc/compositionScoped";
import { refusalText } from "../errors/tryMutate";
import { trackDisplayName } from "../lib/trackName";
import { MotifPropField } from "../properties/MotifPropFields";
import { defaultPropsFor, MotifPreview, useDebounced } from "./MotifPreview";
import { newMotifSource } from "../render/motifs/newMotifSource";
import { syncProjectMotifsFromBackend } from "../render/motifs/syncCatalog";
import { AppIcon } from "@/components/AppIcon";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Fired after "New Motif" auto-places the new project Motif at the
  /// playhead. The App selects the layer and reveals its (role-null,
  /// AB-hidden) auto-created overlay track, landing the user straight in the
  /// property panel's source editor (docs/motifs.md canvas-context editing).
  onNewPlaced: (layerId: string) => void;
  /// The composition the picker is adding to — the timeline that holds the
  /// keyboard, resolved by the App when the dialog opens. The picker's tracks,
  /// canvas and clock are all read off it, so the layer has to be committed to
  /// the same one (ADR 0053 decision 4).
  compositionId: string | null;
  /// Current playhead position in microseconds. Used as the default
  /// "insert at" time so the motif lands wherever the user is
  /// actively looking, matching AE/Premiere behavior.
  currentTimeUs: number;
  /// Project's current tracks. The picker filters to Video tracks for the
  /// target dropdown — motifs lower to PngSeq overlay nodes and would
  /// silently render nothing on an Audio/Subtitle lane.
  tracks: TrackSummary[];
  fpsNum: number;
  fpsDen: number;
  /// Composition canvas size in pixels. The form's large preview draws the
  /// canvas as its backdrop so the motif's true relative size and default
  /// placement (top-left at (0,0), natural pixels) are visible before adding.
  compWidth: number;
  compHeight: number;
}

/// `<select>` value for "auto track". Sent over IPC as `trackId: undefined`,
/// which makes the `add_motif` handler spawn a fresh unnamed track for the
/// layer — its name is derived from its position (`lib/trackName.ts`).
const AUTO_OVERLAY_SENTINEL = "__auto_overlay__";

export function MotifPicker({
  onClose,
  onAdded,
  onNewPlaced,
  compositionId,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  compWidth,
  compHeight,
}: Props) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<MotifCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<LibraryMotifRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [history, setHistory] = useState<LibraryMotifRow | null>(null);
  // An agent's proposed publications, each a card the user approves or
  // rejects here (ADR 0046). They sit above the catalog, where the status
  // bar's notice sends the user.
  const proposals = useMotifProposals();
  const save = useSaveToLibrary((id) => catalog?.library.find((r) => r.id === id)?.motif.name);

  const aliveRef = useRef(true);
  const reloadGeneration = useRef(0);
  const reload = () => {
    const generation = ++reloadGeneration.current;
    return listMotifCatalog().then(
      (next) => {
        if (!aliveRef.current || generation !== reloadGeneration.current) return;
        setCatalog(next);
        const rows: MotifRow[] = [...next.project, ...next.library];
        setSelectedKey((prev) => rows.some((r) => rowKey(r) === prev) ? prev
          : rowKey(rows.find((r) => r.motif) ?? rows[0] ?? { group: "library", id: "" }));
      },
      (e) => {
        if (aliveRef.current && generation === reloadGeneration.current) setError(refusalText(e));
      },
    );
  };
  useEffect(() => {
    aliveRef.current = true;
    reload();
    let un: (() => void) | undefined;
    let cleaned = false;
    void listen(MOTIFS_CHANGED_EVENT, reload).then((u) => {
      // If the effect already cleaned up before listen() resolved, unlisten now
      // (otherwise the listener leaks for the renderer's lifetime).
      if (cleaned) u();
      else un = u;
    });
    return () => {
      aliveRef.current = false;
      cleaned = true;
      un?.();
    };
    // reload is stable: it only closes over useState setters (referentially
    // stable) + aliveRef, so omitting it from deps is intentional and safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo<MotifRow | null>(
    () => catalog && [...catalog.project, ...catalog.library].find((r) => rowKey(r) === selectedKey) || null,
    [catalog, selectedKey],
  );

  const videoTracks = useMemo(
    () => tracks.filter((tr) => tr.kind === "Video"),
    [tracks],
  );

  const projectRows = useMemo(() => catalog && matchRows(catalog.project, query), [catalog, query]);
  const libraryRows = useMemo(() => catalog && matchRows(catalog.library, query), [catalog, query]);

  /// Runs a row action; its refusal shows in the panel's error line.
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); } catch (e) { setError(refusalText(e)); }
  };

  /// A placement lands a layer on a Motif the render catalog may not hold
  /// yet (a library copy): pull it before the App looks.
  const placed = async () => {
    await syncProjectMotifsFromBackend();
    await onAdded();
  };

  const createMotif = act(async () => {
    const name = untitledName(catalog ? [...catalog.project, ...catalog.library] : [], t("motif_picker.untitled_name"));
    const { manifest, html } = newMotifSource(name);
    const id = await createProjectMotif(manifest, html);
    // Keeps the picker useful if the auto-place below fails: the new card is
    // already selected and the error shows in place.
    setSelectedKey(rowKey({ group: "project", id }));
    // Straight into the editing surface: place it at the playhead (default
    // props/duration, fresh overlay track), hand the new layer to the App for
    // select + reveal, and close the picker.
    const layerId = await addMotifIn({ compositionId, motifId: id, tStartUs: currentTimeUs });
    await placed();
    onNewPlaced(layerId);
    onClose();
  });

  const importFile = act(async () => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Motif ZIP", extensions: ["zip"] }],
    });
    if (typeof path !== "string") return; // cancelled / multiple
    const id = await importMotif(path);
    setSelectedKey(rowKey({ group: "project", id })); // motifs:changed → reload() surfaces the card
  });

  const exportItem = (row: MotifRow) => act(async () => {
    const path = await saveDialog({
      title: t("motif_picker.export_button"),
      defaultPath: `${row.id}.zip`,
      filters: [{ name: "Motif ZIP", extensions: ["zip"] }],
    });
    if (!path) return;
    await exportMotif(row.id, path, row.group === "library" ? "library" : undefined);
  });

  const removeItem = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteLibraryMotif(deleting.id);
      await reload();
      setDeleting(null);
    } catch (e) { setDeleteError(refusalText(e)); }
    finally { setDeleteBusy(false); }
  };

  const card = (row: MotifRow) => (
    <MotifCard
      key={rowKey(row)}
      row={row}
      selected={rowKey(row) === selectedKey}
      fpsNum={fpsNum} fpsDen={fpsDen}
      onSelect={() => setSelectedKey(rowKey(row))}
      onExport={() => void exportItem(row)()}
      onHistory={() => row.group === "library" && setHistory(row)}
      onDelete={() => { if (row.group === "library") { setDeleteError(null); setDeleting(row); } }}
      onTakeLibrary={() => void act(() => updateProjectMotif(row.id))()}
      onSave={() => void act(() => save.start(row.id))()}
      onRemove={() => void act(() => removeProjectMotif(row.id))()}
    />
  );

  const empty = (all: readonly MotifRow[], none: string) => (
    <p className="settings-status">
      {all.length === 0 ? none : t("motif_picker.no_matches", { query: query.trim() })}
    </p>
  );

  return (
    <AppDialog
      title={t("motif_picker.heading")}
      onClose={onClose}
      panelClassName="motif-picker"
    >
        {error && <p className="settings-error" role="alert">{error}</p>}
        {proposals && <MotifProposalList proposals={proposals} />}

        {catalog === null || projectRows === null || libraryRows === null ? (
          <p className="settings-status">{t("motif_picker.loading")}</p>
        ) : (
          <div className="motif-picker-body">
            <div className="motif-picker-catalog">
              {/* Media-pool-style management bar: search claims the free
                  width, the catalog actions (new / import, both into the
                  project) sit at the trailing edge. Fixed sibling above the
                  scrolling list. */}
              <div className="motif-picker-bar">
                <AppInput
                  type="search"
                  clearable
                  clearAriaLabel={t("motif_picker.search_clear")}
                  placeholder={t("motif_picker.search_placeholder")}
                  ariaLabel={t("motif_picker.search_placeholder")}
                  value={query}
                  onValueChange={setQuery}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query !== "") {
                      // Consume: this Escape clears the search only; without
                      // stopPropagation the dialog would close too.
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t("motif_picker.new_button")}
                  aria-label={t("motif_picker.new_button")}
                  onClick={() => void createMotif()}
                >
                  <AppIcon icon={PlusIcon} size="title" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t("motif_picker.import_button")}
                  aria-label={t("motif_picker.import_button")}
                  onClick={() => void importFile()}
                >
                  <AppIcon icon={FolderInputIcon} size="title" aria-hidden />
                </Button>
              </div>
              <div className="motif-picker-list">
                <section aria-label={t("motif_picker.group_project")}>
                  <h3 className="motif-picker-group">{t("motif_picker.group_project")}</h3>
                  {projectRows.length === 0 && empty(catalog.project, t("motif_picker.project_empty"))}
                  {projectRows.map(card)}
                </section>
                <section aria-label={t("motif_picker.group_library")}>
                  <h3 className="motif-picker-group">{t("motif_picker.group_library")}</h3>
                  {libraryRows.length === 0 && empty(catalog.library, t("motif_picker.empty"))}
                  {libraryRows.map(card)}
                </section>
              </div>
            </div>

            <div className="motif-picker-form">
              {selected?.motif ? (
                <MotifForm
                  key={rowKey(selected)}
                  motif={selected.motif}
                  preview={previewMotif(selected)!}
                  fromLibrary={selected.group === "library"}
                  currentTimeUs={currentTimeUs}
                  tracks={videoTracks}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
                  compWidth={compWidth}
                  compHeight={compHeight}
                  onSubmit={async ({ tStartUs, props, trackId }) => {
                    setError(null);
                    try {
                      await addMotifIn({
                        compositionId,
                        motifId: selected.id,
                        ...(selected.group === "library" ? { fromLibrary: true } : {}),
                        tStartUs,
                        props,
                        trackId,
                      });
                      await placed();
                      onClose();
                    } catch (e) {
                      setError(refusalText(e));
                    }
                  }}
                />
              ) : selected?.group === "project" ? (
                <div className="motif-picker-unavailable">
                  <h3>{t("motif_picker.unavailable_title", { name: rowName(selected) })}</h3>
                  <p className="settings-error">{selected.diagnostic}</p>
                  <p className="settings-status">{t("motif_picker.unavailable_hint", { id: selected.id })}</p>
                </div>
              ) : (
                <p className="settings-status">{t("motif_picker.empty")}</p>
              )}
            </div>
          </div>
        )}
        {save.dialog}
        {history && <MotifVersionHistory motif={history.motif} onClose={() => setHistory(null)} />}
        {deleting && (
          <AppDialog
            title={t("motif_picker.delete_button")}
            panelClassName="settings-panel motif-delete-dialog"
            onClose={deleteBusy ? undefined : () => setDeleting(null)}
          >
            <div className="settings-body">
              <div className="settings-card">
                <p className="settings-blurb">
                  {t("motif_picker.delete_confirm", { name: deleting.motif.name })}
                </p>
                {deleteError && <p className="settings-error" role="alert">{deleteError}</p>}
                <div className="export-actions">
                  <Button size="lg" disabled={deleteBusy} onClick={() => setDeleting(null)}>
                    {t("motif_picker.cancel")}
                  </Button>
                  <Button variant="destructive" size="lg" disabled={deleteBusy} onClick={() => void removeItem()}>
                    {t("motif_picker.delete_button")}
                  </Button>
                </div>
              </div>
            </div>
          </AppDialog>
        )}
    </AppDialog>
  );
}

/// Default name for a new Motif: the localized base, or "base N" when taken.
/// Names are not a uniqueness key (the id is), so this only keeps the list
/// legible until the user renames it in its manifest island (the source
/// editor they land in).
function untitledName(existing: readonly MotifRow[], base: string): string {
  const names = new Set(existing.map(rowName));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

function MotifForm({
  motif,
  preview,
  fromLibrary,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  compWidth,
  compHeight,
  onSubmit,
}: {
  motif: MotifSummary;
  /// `motif` under the host its scope serves it from.
  preview: MotifSummary;
  /// Placing copies it into the project first.
  fromLibrary: boolean;
  currentTimeUs: number;
  tracks: TrackSummary[];
  fpsNum: number;
  fpsDen: number;
  compWidth: number;
  compHeight: number;
  onSubmit: (args: {
    tStartUs: number;
    props: Record<string, unknown>;
    // Explicit `| undefined` so the "auto track" sentinel (→ undefined) passes
    // straight through under `exactOptionalPropertyTypes`.
    trackId?: string | undefined;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [propValues, setPropValues] = useState<Record<string, unknown>>(() =>
    defaultPropsFor(motif),
  );
  const [insertAtUs, setInsertAtUs] = useState<number>(currentTimeUs);
  // Default to auto-create. The backend spawns a fresh track on every
  // auto insert so consecutive motifs never collide on the same track —
  // picking an existing overlay track as the default would walk straight
  // back into the overlap invariant.
  const [trackChoice, setTrackChoice] = useState<string>(AUTO_OVERLAY_SENTINEL);
  const [busy, setBusy] = useState(false);

  const setProp = (key: string, value: unknown) =>
    setPropValues((prev) => ({ ...prev, [key]: value }));

  // Re-mounting the preview iframe on every keystroke would reset the
  // motif's RAF-driven animations. Debounce until the user pauses typing.
  const debouncedProps = useDebounced(propValues, 300);

  const submit = async () => {
    setBusy(true);
    try {
      const tStartUs = Math.max(0, insertAtUs);
      const trackId =
        trackChoice === AUTO_OVERLAY_SENTINEL ? undefined : trackChoice;
      await onSubmit({ tStartUs, props: propValues, trackId });
    } finally {
      setBusy(false);
    }
  };

  const propKeys = Object.keys(motif.props_schema);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>
        {t("motif_picker.preview_heading")}
        <span className="motif-preview-canvas-size">
          {t("motif_picker.preview_canvas_size", {
            w: compWidth,
            h: compHeight,
          })}
        </span>
      </h3>
      <MotifPreview
        motif={preview}
        props={debouncedProps}
        maxWidth={480}
        large
        canvas={[compWidth, compHeight]}
        fpsNum={fpsNum}
        fpsDen={fpsDen}
      />

      <h3>{t("motif_picker.props_heading")}</h3>
      {propKeys.length === 0 ? (
        <p className="settings-status">{t("motif_picker.no_props")}</p>
      ) : (
        propKeys.map((key) => (
          <MotifPropField
            key={key}
            propKey={key}
            spec={motif.props_schema[key]!}
            value={propValues[key]}
            commit={{ mode: "buffer", onChange: (v) => setProp(key, v) }}
          />
        ))
      )}

      <h3>{t("motif_picker.timing_heading")}</h3>
      <div className="motif-picker-field">
        <span>{t("motif_picker.insert_at")}</span>
        <AppTimecodeField
          valueUs={insertAtUs}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          ariaLabel={t("motif_picker.insert_at")}
          onCommit={setInsertAtUs}
        />
      </div>
      <div className="motif-picker-field">
        <span>{t("motif_picker.track_label")}</span>
        <AppSelect
          value={trackChoice}
          onValueChange={setTrackChoice}
          ariaLabel={t("motif_picker.track_label")}
          options={[
            {
              value: AUTO_OVERLAY_SENTINEL,
              label: t("motif_picker.track_overlay_auto"),
            },
            ...tracks.map((tr) => ({
              value: tr.id,
              label: trackDisplayName(tr, tracks, t),
            })),
          ]}
        />
      </div>
      <p className="motif-picker-hint">
        {t("motif_picker.duration_hint", {
          value: formatTimecode(Math.round(motif.default_duration_s * 1_000_000), fpsNum, fpsDen),
        })}
      </p>
      {fromLibrary && <p className="motif-picker-hint">{t("motif_picker.place_copy_hint")}</p>}

      <div className="motif-picker-actions">
        <Button type="submit" variant="default" size="lg" disabled={busy}>
          {busy
            ? t("motif_picker.adding")
            : t("motif_picker.add")}
        </Button>
      </div>
    </form>
  );
}
