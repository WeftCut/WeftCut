import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInputIcon, PlusIcon } from "lucide-react";
import { MotifCard } from './MotifCard';
import { MotifProposalList, useMotifProposals } from './MotifProposalCard';
import { listen } from "@/bridge/events";
import { open as openDialog, save as saveDialog } from "@/bridge/dialog";
import { formatTimecode } from "../frames";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import {
  importMotif,
  exportMotif,
  deleteMotif,
  listMotifs,
  MOTIFS_CHANGED_EVENT,
  writeMotifDraft,
  type MotifSummary,
  type TrackSummary,
} from "../ipc";
import { addMotifIn } from "../ipc/compositionScoped";
import { trackDisplayName } from "../lib/trackName";
import { MotifPropField } from "../properties/MotifPropFields";
import { defaultPropsFor, MotifPreview, useDebounced } from "./MotifPreview";
import { setUserMotifs, type MotifManifest } from "../render/motifs/catalog";
import { newDraftSource } from "../render/motifs/newDraftSource";
import { AppIcon } from "@/components/AppIcon";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Fired after "New Motif" auto-places the fresh draft at the playhead.
  /// The App selects the layer and reveals its (role-null, AB-hidden)
  /// auto-created overlay track, landing the user straight in the property
  /// panel's source editor — the draft's real editing home (docs/motifs.md
  /// canvas-context editing).
  onDraftPlaced: (layerId: string) => void;
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
  onDraftPlaced,
  compositionId,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  compWidth,
  compHeight,
}: Props) {
  const { t } = useTranslation();
  const [motifs, setMotifs] = useState<MotifSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<MotifSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // An agent's proposed publications, each a card the user approves or
  // rejects here (ADR 0046). They sit above the catalog, where the status
  // bar's notice sends the user.
  const proposals = useMotifProposals();

  const aliveRef = useRef(true);
  const reloadGeneration = useRef(0);
  const reload = () => {
    const generation = ++reloadGeneration.current;
    return listMotifs().then(
      (list) => {
        if (!aliveRef.current || generation !== reloadGeneration.current) return;
        setMotifs(list);
        // Refresh the runtime frame-math catalog from the SAME fetch the picker
        // shows, so every Motif the picker can add also resolves in the
        // compositor/export. Startup seeds that catalog and a `motifs:changed`
        // listener keeps it fresh (both in `startup/initializeRenderer.ts`);
        // this covers a boot sync that failed or an event that was missed.
        setUserMotifs(list as MotifManifest[]);
        setSelectedId((prev) => list.some(m => m.id === prev) ? prev : list[0]?.id ?? null);
      },
      (e) => {
        if (aliveRef.current && generation === reloadGeneration.current) setError(String(e));
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

  const selected = useMemo(
    () => motifs?.find((tpl) => tpl.id === selectedId) ?? null,
    [motifs, selectedId],
  );

  const videoTracks = useMemo(
    () => tracks.filter((tr) => tr.kind === "Video"),
    [tracks],
  );

  // Catalog search. Matches the id too: it's off the card (tooltip-only),
  // but agents quote ids in logs/chats and pasting one here should work.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "" || motifs === null) return motifs;
    return motifs.filter(
      (tpl) =>
        tpl.name.toLowerCase().includes(q) || tpl.id.toLowerCase().includes(q),
    );
  }, [motifs, query]);

  const createDraft = async () => {
    try {
      const name = untitledName(motifs ?? [], t("motif_picker.untitled_name"));
      const { manifest, html } = newDraftSource(name);
      const draftId = await writeMotifDraft(manifest, html);
      // Keeps the picker useful if the auto-place below fails: the draft's
      // card is already selected and the error shows in place.
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
      // Straight into the editing surface: place the draft at the playhead
      // (default props/duration, fresh overlay track), hand the new layer to
      // the App for select + reveal, and close the picker.
      const layerId = await addMotifIn({
        compositionId,
        motifId: draftId,
        tStartUs: currentTimeUs,
      });
      await onAdded();
      onDraftPlaced(layerId);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const importFile = async () => {
    try {
      setError(null);
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Motif ZIP", extensions: ["zip"] }],
      });
      if (typeof path !== "string") return; // cancelled / multiple
      const draftId = await importMotif(path);
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
    } catch (e) {
      setError(String(e));
    }
  };

  const exportItem = async (id: string) => {
    try {
      setError(null);
      const path = await saveDialog({
        title: t("motif_picker.export_button"),
        defaultPath: `${id}.zip`,
        filters: [{ name: "Motif ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      await exportMotif(id, path);
    } catch (e) {
      setError(String(e));
    }
  };

  const removeItem = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteMotif(deleting.id);
      await reload();
      setDeleting(null);
    } catch (e) { setDeleteError(String(e)); }
    finally { setDeleteBusy(false); }
  };

  return (
    <AppDialog
      title={t("motif_picker.heading")}
      onClose={onClose}
      panelClassName="motif-picker"
    >
        {error && <p className="settings-error">{error}</p>}
        {proposals && <MotifProposalList proposals={proposals} />}

        {motifs === null || filtered === null ? (
          <p className="settings-status">{t("motif_picker.loading")}</p>
        ) : (
          <div className="motif-picker-body">
            <div className="motif-picker-catalog">
              {/* Media-pool-style management bar: search claims the free
                  width, the catalog actions (new draft / import) sit at the
                  trailing edge. Fixed sibling above the scrolling list. */}
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
                  onClick={() => void createDraft()}
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
                {filtered.length === 0 && (
                  <p className="settings-status">
                    {motifs.length === 0
                      ? t("motif_picker.empty")
                      : t("motif_picker.no_matches", { query: query.trim() })}
                  </p>
                )}
                {filtered.map((tpl) => (
                  <MotifCard
                    key={tpl.id}
                    motif={tpl}
                    selected={tpl.id === selectedId}
                    fpsNum={fpsNum} fpsDen={fpsDen}
                    onSelect={() => setSelectedId(tpl.id)}
                    onExport={() => void exportItem(tpl.id)}
                    onDelete={() => { setDeleteError(null); setDeleting(tpl); }}
                  />
                ))}
              </div>
            </div>

            <div className="motif-picker-form">
              {selected ? (
                <MotifForm
                  key={selected.id}
                  motif={selected}
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
                        tStartUs,
                        props,
                        trackId,
                      });
                      await onAdded();
                      onClose();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                />
              ) : (
                <p className="settings-status">{t("motif_picker.empty")}</p>
              )}
            </div>
          </div>
        )}
        {deleting && (
          <AppDialog
            title={t("motif_picker.delete_button")}
            panelClassName="settings-panel motif-delete-dialog"
            onClose={deleteBusy ? undefined : () => setDeleting(null)}
          >
            <div className="settings-body">
              <div className="settings-card">
                <p className="settings-blurb">
                  {t("motif_picker.delete_confirm", { name: deleting.name })}
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

/// Default name for a one-click draft: the localized base, or "base N" when
/// taken. Names aren't a uniqueness key anywhere (drafts get fresh ids), so
/// this is purely to keep the catalog legible until the user renames the
/// draft in its manifest island (the source editor they land in).
function untitledName(existing: MotifSummary[], base: string): string {
  const names = new Set(existing.map((m) => m.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

function MotifForm({
  motif,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  compWidth,
  compHeight,
  onSubmit,
}: {
  motif: MotifSummary;
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
        motif={motif}
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
