import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  type DataRootCurrent,
  type DataRootProgress,
  type KeybindingsMap,
  type TimelineWheelAxis,
  DATA_ROOT_EVENTS,
  dataRootCurrent,
  dataRootDeleteOld,
  dataRootDismissCleanup,
  dataRootOpenFolder,
  dataRootPendingCleanup,
  dataRootPickAndMigrate,
  dataRootRelaunch,
  recentsGetReopenOnLaunch,
  recentsSetReopenOnLaunch,
} from "../ipc";
import { fitCompositionToLayersOf, setCompositionOf } from "../ipc/compositionScoped";
import { listen, type UnlistenFn } from "@/bridge/events";
import { fontListImported, pickAndImportFont } from "@/bridge/font";
import { formatTimecode, parseTimecode, wallClockAside } from "../frames";
import { refusalText } from "../errors/tryMutate";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { AppSlider } from "../components/AppSlider";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import { KeybindingPanel } from "./KeybindingPanel";
import { AgentSection } from "./AgentSection";
import { PreviewSection } from "./PreviewSection";
import { ModelSection } from "./ModelSection";
import { VlmSection } from "./VlmSection";
import {
  setAppSettings,
  usePrebakeMotifsEnabled,
  usePreviewSnapEnabled,
  usePreviewSnapStrengthPx,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
  useTimelineWheelAxis,
  useDefaultTextFont,
} from "./appSettingsStore";
import { setPreferProxies, useProxyPrefStore } from "../state/proxyPreferenceStore";
import {
  FPS_OPTIONS,
  RESOLUTION_PRESETS,
  canvasSizeError,
  fpsLabel,
  resolutionLabel,
} from "../startup/canvasPresets";
// Straight from the shared module the main process clamps against, so the
// slider's ends and the persisted range cannot drift apart.
import {
  PREVIEW_SNAP_STRENGTH_MAX_PX,
  PREVIEW_SNAP_STRENGTH_MIN_PX,
} from "../../shared/app-settings";

const TAIL_SNAP_MIN_PX = 2;
const TAIL_SNAP_MAX_PX = 80;

function clampTailSnapStrength(value: number): number {
  return Math.round(Math.min(TAIL_SNAP_MAX_PX, Math.max(TAIL_SNAP_MIN_PX, value)));
}

function clampPreviewSnapStrength(value: number): number {
  return Math.round(
    Math.min(PREVIEW_SNAP_STRENGTH_MAX_PX, Math.max(PREVIEW_SNAP_STRENGTH_MIN_PX, value)),
  );
}

/// The sidebar's tabs. Exported because App holds the selected one as state and
/// deep-links into it: a capability notice's recovery card and the describe
/// dialog's "no engine configured" button both name a category, and a narrower
/// type at that boundary would let one of them name a tab that does not exist.
export type SettingsCategory =
  | "general"
  | "project"
  | "keyboard"
  | "speech"
  | "vlm"
  | "agent";

/// Sidebar order. Every pane stays mounted (toggled via `hidden`) so
/// in-progress input and per-section fetches survive a tab switch.
const CATEGORIES: ReadonlyArray<{ id: SettingsCategory; labelKey: string }> = [
  { id: "general", labelKey: "settings.cat_general" },
  { id: "project", labelKey: "settings.cat_project" },
  { id: "keyboard", labelKey: "settings.cat_keyboard" },
  { id: "speech", labelKey: "settings.cat_speech" },
  // Next to Transcription, not folded into it: both configure a model that
  // reads the footage, and a user looking for one will look beside the other.
  { id: "vlm", labelKey: "settings.cat_vlm" },
  { id: "agent", labelKey: "settings.cat_agent" },
];

export interface CompositionState {
  /// The composition these fields describe — the OPEN one, which is also the
  /// one the form's `set_composition` / `fit_composition_to_layers` name.
  id: string;
  durationUs: number;
  durationPinned: boolean;
  /// Live `max(layer.t_end_us)` — the floor a pinned duration can't sit
  /// below. Pre-validation only; the actor-side overflow guard is the
  /// source of truth.
  layersMaxEndUs: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  /// `set_composition { fps }` would be rejected (spec R2-D1, history-scoped).
  /// Straight from the summary — never recomputed here, because the condition
  /// spans stored snapshots the renderer cannot see.
  fpsLocked: boolean;
}

interface Props {
  onClose: () => void;
  /// Category selected when the modal mounts. System-status actions use this
  /// to deep-link directly to the relevant recovery controls.
  initialCategory?: SettingsCategory;
  /// Shortcut overrides owned by App.tsx. Threaded through so the
  /// Keyboard section can render the current bindings and the
  /// dispatcher re-resolves the moment the user edits.
  keybindings: KeybindingsMap;
  onKeybindingsChanged: (next: KeybindingsMap) => void;
  /// Live state of the ROOT composition, for the Canvas and Duration
  /// sections. The root and not the focused composition: these are the film's
  /// own canvas and runtime, and a Group's are read-only everywhere else
  /// (`App.tsx` says why). `null` while the project summary is still loading.
  /// Omitted entirely (together with `onCompositionChanged`) when no project
  /// is open — e.g. on the startup screen.
  composition?: CompositionState | null;
  /// Refresh the parent project summary after Pin / Fit actions so the
  /// section's labels reflect the new state immediately. Its presence is
  /// the "a project is open" signal: the project category only renders
  /// when this is provided, so callers without a workspace (the startup
  /// screen) simply omit both composition props and the project-scoped
  /// tab drops out — no separate flag to keep in sync.
  onCompositionChanged?: () => Promise<void> | void;
}

export function SettingsPanel({
  onClose,
  initialCategory = "general",
  keybindings,
  onKeybindingsChanged,
  composition = null,
  onCompositionChanged,
}: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [reopenOnLaunch, setReopenOnLaunch] = useState<boolean | null>(null);
  // Project-scoped sections (composition pin, per-project toggles) talk to
  // workspace IPC, so the whole category unmounts — not just hides — when
  // there is no open project behind the panel.
  const showProjectCategory = onCompositionChanged !== undefined;
  const visibleCategories = showProjectCategory
    ? CATEGORIES
    : CATEGORIES.filter((c) => c.id !== "project");
  const [category, setCategory] = useState<SettingsCategory>(
    initialCategory === "project" && !showProjectCategory
      ? "general"
      : initialCategory,
  );
  const tabRefs = useRef<
    Partial<Record<SettingsCategory, HTMLButtonElement | null>>
  >({});

  /// Roving-tabindex keyboard nav for the vertical tablist (WAI-ARIA
  /// tabs pattern): arrows move + activate, Home/End jump to the ends.
  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order = visibleCategories.map((c) => c.id);
    const idx = order.indexOf(category);
    let next: SettingsCategory | undefined;
    if (e.key === "ArrowDown") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowUp")
      next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      setCategory(next);
      tabRefs.current[next]?.focus();
    }
  };

  useEffect(() => {
    recentsGetReopenOnLaunch()
      .then(setReopenOnLaunch)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <AppDialog
      title={t("settings.heading")}
      onClose={onClose}
      panelClassName="settings-panel settings-panel--nav"
    >
      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.heading")}
          onKeyDown={onNavKeyDown}
        >
          {visibleCategories.map((c) => (
            <button
              key={c.id}
              ref={(el) => {
                tabRefs.current[c.id] = el;
              }}
              type="button"
              role="tab"
              id={`settings-tab-${c.id}`}
              aria-selected={category === c.id}
              aria-controls={`settings-panel-${c.id}`}
              tabIndex={category === c.id ? 0 : -1}
              className={
                category === c.id
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => setCategory(c.id)}
            >
              {t(c.labelKey)}
            </button>
          ))}
        </div>

        <div className="settings-content">
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}

          <div
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            hidden={category !== "general"}
            className="settings-pane"
          >
            <section className="settings-section">
              <h3>{t("settings.startup_heading")}</h3>
              <label className="settings-toggle-row">
                <AppSwitch
                  checked={reopenOnLaunch === true}
                  disabled={reopenOnLaunch === null}
                  onCheckedChange={async (next) => {
                    setReopenOnLaunch(next);
                    try {
                      await recentsSetReopenOnLaunch(next);
                    } catch (err) {
                      setError(String(err));
                      setReopenOnLaunch(!next);
                    }
                  }}
                />
                <span>
                  <span className="settings-toggle-label">
                    {t("settings.reopen_on_launch")}
                  </span>
                  <span className="settings-toggle-hint">
                    {t("settings.reopen_on_launch_hint")}
                  </span>
                </span>
              </label>
            </section>

            <section className="settings-section">
              <h3>{t("settings.data_location_heading")}</h3>
              <p className="settings-blurb">
                {t("settings.data_location_blurb")}
              </p>
              <DataLocationSection onError={setError} />
            </section>

            <section className="settings-section">
              <h3>{t("settings.timeline_heading")}</h3>
              <TimelineWheelSection onError={setError} />
              <TimelineSnapSection onError={setError} />
            </section>

            <section className="settings-section">
              <h3>{t("settings.motifs_heading")}</h3>
              <PrebakeSection onError={setError} />
            </section>

            <section className="settings-section">
              <h3>{t("settings.fonts_heading", { defaultValue: "Custom fonts" })}</h3>
              <p className="settings-blurb">
                {t("settings.fonts_blurb", { defaultValue: "Import .ttf / .otf / .woff2 font files. Imported fonts are available in all projects and workspaces." })}
              </p>
              <FontsSection onError={setError} />
            </section>

            <section className="settings-section">
              <h3>{t("settings.preview_heading")}</h3>
              <PreviewSection onError={setError} />
              <PreviewSnapSection onError={setError} />
            </section>
          </div>

          {showProjectCategory && (
            <div
              role="tabpanel"
              id="settings-panel-project"
              aria-labelledby="settings-tab-project"
              hidden={category !== "project"}
              className="settings-pane"
            >
              <p className="settings-blurb">{t("settings.project_scope_blurb")}</p>
              <section className="settings-section">
                <h3>{t("settings.canvas_heading")}</h3>
                <p className="settings-blurb">{t("settings.canvas_blurb")}</p>
                <CanvasSection
                  composition={composition}
                  onChanged={onCompositionChanged}
                  onError={setError}
                />
              </section>

              <section className="settings-section">
                <h3>{t("settings.duration_heading")}</h3>
                <p className="settings-blurb">{t("settings.duration_blurb")}</p>
                <CompositionSection
                  composition={composition}
                  onChanged={onCompositionChanged}
                  onError={setError}
                />
              </section>

              <section className="settings-section">
                <h3>{t("settings.playback_heading")}</h3>
                <PreferProxiesToggle onError={setError} />
              </section>
            </div>
          )}

          <div
            role="tabpanel"
            id="settings-panel-keyboard"
            aria-labelledby="settings-tab-keyboard"
            hidden={category !== "keyboard"}
            className="settings-pane"
          >
            <section className="settings-section">
              <p className="settings-blurb">{t("settings.keybindings_blurb")}</p>
              <KeybindingPanel
                keybindings={keybindings}
                onChanged={onKeybindingsChanged}
                onError={setError}
              />
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-speech"
            aria-labelledby="settings-tab-speech"
            hidden={category !== "speech"}
            className="settings-pane"
          >
            <SpeechSection onError={setError} />
          </div>

          <div
            role="tabpanel"
            id="settings-panel-vlm"
            aria-labelledby="settings-tab-vlm"
            hidden={category !== "vlm"}
            className="settings-pane"
          >
            <VlmSection onError={setError} />
          </div>

          <div
            role="tabpanel"
            id="settings-panel-agent"
            aria-labelledby="settings-tab-agent"
            hidden={category !== "agent"}
            className="settings-pane"
          >
            <AgentSection />
          </div>
        </div>
      </div>
    </AppDialog>
  );
}

/// Which axis the bare wheel moves the timeline along, the preference Premiere
/// carries as `Timeline Mouse Scrolling`. A select rather than a switch:
/// neither value is "off", and the label has to name the axis to be readable.
/// Set absolutely, so there is no defined direction to cycle in.
function TimelineWheelSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const axis = useTimelineWheelAxis();

  return (
    <>
      <div className="settings-control-row">
        <span className="settings-toggle-label">
          {t("settings.timeline_wheel_axis")}
        </span>
        <AppSelect
          className="settings-select"
          value={axis}
          ariaLabel={t("settings.timeline_wheel_axis")}
          onValueChange={async (next) => {
            onError("");
            try {
              await setAppSettings({
                timeline_wheel_axis: next as TimelineWheelAxis,
              });
            } catch (err) {
              onError(String(err));
            }
          }}
          options={[
            {
              value: "horizontal",
              label: t("settings.timeline_wheel_axis_horizontal"),
            },
            {
              value: "vertical",
              label: t("settings.timeline_wheel_axis_vertical"),
            },
          ]}
        />
      </div>
      <p className="settings-toggle-hint">
        {t("settings.timeline_wheel_axis_hint")}
      </p>
    </>
  );
}

function TimelineSnapSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = useTailSnapEnabled();
  const strengthPx = useTailSnapStrengthPx();
  const [draftStrengthPx, setDraftStrengthPx] = useState(strengthPx);

  useEffect(() => {
    setDraftStrengthPx(strengthPx);
  }, [strengthPx]);

  const commitStrength = async (value: number) => {
    const next = clampTailSnapStrength(value);
    setDraftStrengthPx(next);
    onError("");
    try {
      await setAppSettings({ tail_snap_strength_px: next });
    } catch (e) {
      onError(String(e));
      setDraftStrengthPx(strengthPx);
    }
  };

  return (
    <>
      <label className="settings-toggle-row">
        <AppSwitch
          checked={enabled}
          onCheckedChange={async (next) => {
            onError("");
            try {
              await setAppSettings({ tail_snap_enabled: next });
            } catch (err) {
              onError(String(err));
            }
          }}
        />
        <span>
          <span className="settings-toggle-label">
            {t("settings.tail_snap_enabled")}
          </span>
          <span className="settings-toggle-hint">
            {t("settings.tail_snap_enabled_hint")}
          </span>
        </span>
      </label>
      <div className="settings-slider-row">
        <span className="settings-slider-label">
          {t("settings.tail_snap_strength")}
        </span>
        <AppSlider
          min={TAIL_SNAP_MIN_PX}
          max={TAIL_SNAP_MAX_PX}
          value={draftStrengthPx}
          disabled={!enabled}
          onValueChange={setDraftStrengthPx}
          onValueCommitted={(v) => void commitStrength(v)}
          ariaLabel={t("settings.tail_snap_strength")}
        />
        <AppNumberField value={draftStrengthPx} min={TAIL_SNAP_MIN_PX} max={TAIL_SNAP_MAX_PX}
          disabled={!enabled} align="center" className="settings-input-narrow"
          ariaLabel={t("settings.tail_snap_strength")}
          onValueChange={setDraftStrengthPx} onCommit={(v) => void commitStrength(v)} />
        <span className="settings-slider-unit">px</span>
      </div>
      <p className="settings-toggle-hint">
        {t("settings.tail_snap_strength_hint")}
      </p>
    </>
  );
}

/// The preview gizmo's snapping, deliberately its own pair rather than a reuse
/// of the timeline's: the target densities differ by an order of magnitude, so
/// one radius cannot be tuned for both. Same shape as `TimelineSnapSection`
/// otherwise — draft state on the slider, commit on release, roll back on error.
function PreviewSnapSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = usePreviewSnapEnabled();
  const strengthPx = usePreviewSnapStrengthPx();
  const [draftStrengthPx, setDraftStrengthPx] = useState(strengthPx);

  useEffect(() => {
    setDraftStrengthPx(strengthPx);
  }, [strengthPx]);

  const commitStrength = async (value: number) => {
    const next = clampPreviewSnapStrength(value);
    setDraftStrengthPx(next);
    onError("");
    try {
      await setAppSettings({ preview_snap_strength_px: next });
    } catch (e) {
      onError(String(e));
      setDraftStrengthPx(strengthPx);
    }
  };

  return (
    <>
      <label className="settings-toggle-row">
        <AppSwitch
          checked={enabled}
          onCheckedChange={async (next) => {
            onError("");
            try {
              await setAppSettings({ preview_snap_enabled: next });
            } catch (err) {
              onError(String(err));
            }
          }}
        />
        <span>
          <span className="settings-toggle-label">
            {t("settings.preview_snap_enabled")}
          </span>
          <span className="settings-toggle-hint">
            {t("settings.preview_snap_enabled_hint")}
          </span>
        </span>
      </label>
      <div className="settings-slider-row">
        <span className="settings-slider-label">
          {t("settings.preview_snap_strength")}
        </span>
        <AppSlider
          min={PREVIEW_SNAP_STRENGTH_MIN_PX}
          max={PREVIEW_SNAP_STRENGTH_MAX_PX}
          value={draftStrengthPx}
          disabled={!enabled}
          onValueChange={setDraftStrengthPx}
          onValueCommitted={(v) => void commitStrength(v)}
          ariaLabel={t("settings.preview_snap_strength")}
        />
        <AppNumberField value={draftStrengthPx} min={PREVIEW_SNAP_STRENGTH_MIN_PX}
          max={PREVIEW_SNAP_STRENGTH_MAX_PX}
          disabled={!enabled} align="center" className="settings-input-narrow"
          ariaLabel={t("settings.preview_snap_strength")}
          onValueChange={setDraftStrengthPx} onCommit={(v) => void commitStrength(v)} />
        <span className="settings-slider-unit">px</span>
      </div>
      <p className="settings-toggle-hint">
        {t("settings.preview_snap_strength_hint")}
      </p>
    </>
  );
}

/// Per-project toggle (`Project.settings.prefer_proxies`) — it travels with
/// the .vproj rather than the app settings. The value is already hydrated and
/// kept in sync by `proxyPreferenceStore` (PixiPreview reads it live per
/// `ensureClip`), so this reads the store directly instead of fetching on
/// mount, and writes through `setPreferProxies` instead of the generic
/// `updateProjectSettings` call.
function PreferProxiesToggle({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = useProxyPrefStore((s) => s.preferProxies);

  return (
    <label className="settings-toggle-row">
      <AppSwitch
        checked={enabled}
        onCheckedChange={async (next) => {
          onError("");
          try {
            await setPreferProxies(next);
          } catch (err) {
            onError(String(err));
          }
        }}
      />
      <span>
        <span className="settings-toggle-label">
          {t("settings.prefer_proxies")}
        </span>
        <span className="settings-toggle-hint">
          {t("settings.prefer_proxies_hint")}
        </span>
      </span>
    </label>
  );
}

function PrebakeSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const enabled = usePrebakeMotifsEnabled();
  return (
    <label className="settings-toggle-row">
      <AppSwitch
        checked={enabled}
        onCheckedChange={async (next) => {
          onError("");
          try {
            await setAppSettings({ prebake_motifs: next });
          } catch (err) {
            onError(String(err));
          }
        }}
      />
      <span>
        <span className="settings-toggle-label">{t("settings.prebake_motifs")}</span>
        <span className="settings-toggle-hint">{t("settings.prebake_motifs_hint")}</span>
      </span>
    </label>
  );
}

/// Migration lifecycle for the "Change…" action. `running` holds the latest
/// progress tick (null until the first arrives — ADOPT never emits one, so the
/// bar stays indeterminate through an instant adopt). `success`/`error` are
/// terminal: success offers the relaunch affordance, error shows the rollback
/// message (the resolver already reverted; `data_root` is unchanged).
type MigrateState =
  | { kind: "idle" }
  | { kind: "running"; progress: DataRootProgress | null }
  | { kind: "success"; mode: "adopt" | "copy"; newPath: string }
  | { kind: "error"; message: string };

/// "Data location" section — shows the effective data root, drives the
/// copy/adopt migration (Change…), opens the folder, and — after a relaunch onto
/// a new root — offers to delete the old copy. Exported for the component test.
export function DataLocationSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<DataRootCurrent | null>(null);
  const [migrate, setMigrate] = useState<MigrateState>({ kind: "idle" });
  /// The old copy the user may delete post-relaunch; null while nothing pends.
  const [pendingOld, setPendingOld] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /// The live progress subscription for the in-flight migration only. Held in a
  /// ref so the unmount cleanup can drop it even mid-copy.
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Per-section fetch-on-mount (the general pane stays mounted and toggles via
  // `hidden`, so this effect runs once). Also probes for a pending delete-old
  // marker left by a completed relaunch onto a new root.
  useEffect(() => {
    dataRootCurrent()
      .then(setCurrent)
      .catch((e) => onError(String(e)));
    dataRootPendingCleanup()
      .then((p) => {
        if (p) setPendingOld(p.oldPath);
      })
      .catch((e) => onError(String(e)));
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [onError]);

  const change = async () => {
    onError("");
    setMigrate({ kind: "running", progress: null });
    try {
      // Subscribe to copy progress for the duration of this migration only.
      // Delivered out-of-band on `evt:dataRoot:progress` (see DATA_ROOT_EVENTS);
      // ADOPT emits no copy ticks — just a final `done` — so the bar stays
      // indeterminate until totalFiles is counted (never, for adopt).
      unlistenRef.current = await listen<DataRootProgress>(
        DATA_ROOT_EVENTS.progress,
        (e) => {
          setMigrate((s) =>
            s.kind === "running"
              ? { kind: "running", progress: e.payload }
              : s,
          );
        },
      );
      const result = await dataRootPickAndMigrate();
      if (result.ok) {
        setMigrate({
          kind: "success",
          mode: result.mode,
          newPath: result.newPath,
        });
      } else if ("cancelled" in result) {
        // User dismissed the native picker — silently return to idle.
        setMigrate({ kind: "idle" });
      } else {
        setMigrate({ kind: "error", message: result.error });
      }
    } catch (e) {
      setMigrate({ kind: "error", message: String(e) });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const openFolder = async () => {
    onError("");
    try {
      await dataRootOpenFolder();
    } catch (e) {
      onError(String(e));
    }
  };

  const restart = async () => {
    onError("");
    try {
      await dataRootRelaunch();
    } catch (e) {
      setMigrate({ kind: "error", message: String(e) });
    }
  };

  const deleteOld = async () => {
    setDeleteBusy(true);
    onError("");
    try {
      await dataRootDeleteOld();
      setPendingOld(null);
    } catch (e) {
      onError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  /// Keep the old copy: dismiss the prompt AND clear the marker so it is a
  /// one-time offer (no re-prompt next launch). Resolves every non-destructive
  /// close path (the Keep button, Escape, backdrop, ✕). Non-destructive — the
  /// old folder stays on disk for the user to remove manually.
  const keepOld = () => {
    setPendingOld(null);
    void dataRootDismissCleanup().catch((e) => onError(String(e)));
  };

  const busy = migrate.kind === "running";
  const prog = migrate.kind === "running" ? migrate.progress : null;
  const percentKnown = prog !== null && prog.totalFiles > 0;
  const percent = percentKnown
    ? Math.round((prog.copiedFiles / prog.totalFiles) * 100)
    : 0;

  return (
    <>
      <div className="settings-key-row">
        <div className="settings-data-location">
          <div className="settings-key-header">
            <span className="settings-key-label">
              {t("settings.data_location_current_label")}
            </span>
            {current?.isFallback && (
              <span className="settings-badge settings-badge-off">
                {t("settings.data_location_fallback")}
              </span>
            )}
          </div>

          <p className="settings-data-path">{current ? current.path : "…"}</p>

          <div className="settings-key-input-row">
            <Button size="sm" onClick={() => void change()} disabled={busy}>
              {t("settings.data_location_change")}
            </Button>
            <Button
              size="sm"
              onClick={() => void openFolder()}
              disabled={busy || current === null}
            >
              {t("settings.data_location_open_folder")}
            </Button>
          </div>

          {migrate.kind === "running" && (
            <div className="settings-data-migrate" aria-live="polite">
              <p className="settings-toggle-hint">
                {prog
                  ? t(`settings.data_location_phase_${prog.phase}`)
                  : t("settings.data_location_working")}
                {percentKnown &&
                  ` — ${t("settings.data_location_progress_count", {
                    copied: prog.copiedFiles,
                    total: prog.totalFiles,
                  })}`}
              </p>
              <div
                className="progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(percentKnown ? { "aria-valuenow": percent } : {})}
              >
                <div
                  className="progress-fill"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}

          {migrate.kind === "success" && (
            <div className="settings-data-migrate">
              <p className="settings-test-ok">
                {migrate.mode === "adopt"
                  ? t("settings.data_location_success_adopt", {
                      path: migrate.newPath,
                    })
                  : t("settings.data_location_success_copy", {
                      path: migrate.newPath,
                    })}
              </p>
              <div className="settings-key-input-row">
                <Button size="sm" onClick={() => void restart()}>
                  {t("settings.data_location_restart")}
                </Button>
              </div>
            </div>
          )}

          {migrate.kind === "error" && (
            <p className="settings-test-err" role="alert">
              {t("settings.data_location_error", { message: migrate.message })}
            </p>
          )}
        </div>
      </div>

      {pendingOld !== null && (
        <AppDialog
          title={t("settings.data_location_cleanup_title")}
          onClose={keepOld}
          panelClassName="settings-panel"
        >
          <div className="settings-body">
            <div className="settings-card">
              <p className="settings-blurb">
                {t("settings.data_location_cleanup_body", { path: pendingOld })}
              </p>
              <div className="export-actions">
                {/* Non-destructive default: Keep is the primary, auto-focused
                    action and is what the dialog's Escape / backdrop / ✕ close
                    resolve to. Deletion is the clearly-labelled destructive
                    secondary and only ever runs on this explicit click. */}
                <Button
                  size="lg"
                  autoFocus
                  onClick={keepOld}
                  disabled={deleteBusy}
                >
                  {t("settings.data_location_cleanup_keep")}
                </Button>
                <Button
                  variant="destructive"
                  size="lg"
                  onClick={() => void deleteOld()}
                  disabled={deleteBusy}
                >
                  {deleteBusy
                    ? t("settings.data_location_cleanup_deleting")
                    : t("settings.data_location_cleanup_delete")}
                </Button>
              </div>
            </div>
          </div>
        </AppDialog>
      )}
    </>
  );
}

/// Canvas size + frame rate. Both are composition SETUP: neither records onto the
/// undo stack (the patch is applied to every history snapshot), which is why this
/// lives in its own section away from the duration control.
/// Exported for CanvasSection.test.tsx (same arrangement as DataLocationSection).
export function CanvasSection({
  composition,
  onChanged,
  onError,
}: {
  composition: CompositionState | null;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /// Draft is a PAIR, and there is an explicit Apply: committing each field on its
  /// own blur would walk through a bogus intermediate canvas (1920×1080 → 3840×2160
  /// via 3840×1080), and each intermediate really lands — evicting and rebuilding
  /// every image sprite and patching every snapshot for a size nobody asked for.
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null);
  /// Section-wide lock, engaged on every mount. Nothing here is undoable and the
  /// rate is effectively one-way, so an idle mis-click carries a cost no Ctrl-Z
  /// pays back — the switch is as much the warning as it is the guard. Deliberately
  /// NOT persisted: re-locking each time the dialog opens is the point.
  const [locked, setLocked] = useState(true);
  /// "Custom" is a MODE, not a size. Selecting it only reveals the fields; the
  /// patch still waits for Apply. Sticky until a preset is picked, so applying a
  /// size that happens to match a preset doesn't yank the fields away mid-edit.
  const [customMode, setCustomMode] = useState(false);

  // Re-seed from upstream whenever the canvas changes under us (a preset click,
  // another surface's patch). A live draft is left alone — that's the user typing.
  useEffect(() => {
    setDraft(null);
  }, [composition?.width, composition?.height]);

  // Re-locking must also drop any half-typed draft and leave custom mode, so
  // releasing the lock again never resumes an edit the user has walked away from.
  const relock = () => {
    setLocked(true);
    setDraft(null);
    setCustomMode(false);
  };

  const disabled = composition === null || busy || locked;
  const width = draft?.width ?? composition?.width ?? 0;
  const height = draft?.height ?? composition?.height ?? 0;
  const dirty =
    composition !== null && (width !== composition.width || height !== composition.height);

  /// Run on every keystroke so feedback arrives while typing. The rule itself is
  /// shared with the New Project dialog; only the wording is resolved here.
  const sizeError = ((): string | null => {
    if (composition === null || !dirty) return null;
    const err = canvasSizeError(width, height);
    return err === null ? null : t(err.key, err.params ?? {});
  })();

  const patch = async (fields: Record<string, unknown>) => {
    if (composition === null || busy) return;
    setBusy(true);
    onError("");
    try {
      await setCompositionOf(composition.id, fields);
      await onChanged();
      setDraft(null);
    } catch (e) {
      // The refusal line in the panel's own error slot — notably
      // FpsLockedByContent when the timeline (or its history) holds layers.
      onError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  /// A size off the preset ladder forces custom mode: the ladder can't represent
  /// it, so the fields are the only honest readout (and a project can arrive here
  /// with any size an MCP caller set).
  const matchesPreset =
    composition !== null &&
    RESOLUTION_PRESETS.some((p) => p.width === composition.width && p.height === composition.height);
  const isCustom = composition !== null && (customMode || !matchesPreset);
  const presetValue =
    composition === null ? "" : isCustom ? "custom" : `${composition.width}x${composition.height}`;

  const fpsValue = composition === null ? "" : `${composition.fpsNum}/${composition.fpsDen}`;
  /// A project can carry a rate this list doesn't offer (an MCP `set_composition`
  /// takes any rational). Surface it rather than rendering a blank trigger.
  const fpsOptions = [
    ...(composition !== null && !FPS_OPTIONS.some((f) => f.num === composition.fpsNum && f.den === composition.fpsDen)
      ? [{ num: composition.fpsNum, den: composition.fpsDen }]
      : []),
    ...FPS_OPTIONS,
  ];

  return (
    <>
      <label className="settings-toggle-row">
        <AppSwitch
          checked={locked}
          disabled={composition === null || busy}
          onCheckedChange={(next) => {
            if (next) relock();
            else setLocked(false);
          }}
        />
        <span>
          <span className="settings-toggle-label">{t("settings.canvas_lock")}</span>
          <span className="settings-toggle-hint">{t("settings.canvas_lock_hint")}</span>
        </span>
      </label>

      <div className="settings-control-row">
        <span className="settings-toggle-label">{t("settings.canvas_resolution")}</span>
        <AppSelect
          className="settings-select"
          value={presetValue}
          disabled={disabled}
          ariaLabel={t("settings.canvas_resolution")}
          onValueChange={(v) => {
            // "Custom" only switches the editor on — no patch until Apply. Picking a
            // preset is the one path that leaves custom mode.
            if (v === "custom") {
              setCustomMode(true);
              return;
            }
            setCustomMode(false);
            const [w, h] = v.split("x").map(Number);
            void patch({ width: w, height: h });
          }}
          options={[
            ...RESOLUTION_PRESETS.map((p) => ({
              value: `${p.width}x${p.height}`,
              label: resolutionLabel(p),
            })),
            { value: "custom", label: t("settings.canvas_resolution_custom") },
          ]}
        />
      </div>

      {isCustom && (
        <>
          <div className="settings-control-row">
            <span className="settings-toggle-label">{t("settings.canvas_custom_size")}</span>
            <div className="settings-size-fields">
              {/* Deliberately NO min/max on the fields: Base UI clamps the value it
                  reports while leaving the typed text alone, so a typed 9000 would
                  read 9000 and Apply 7680. One authority (the validator below), one
                  visible message. `step` only drives the +/- steppers — it does not
                  snap typed input, so the even rule needs the validator too. */}
              <AppNumberField
                value={width}
                disabled={disabled}
                step={2}
                align="center"
                ariaLabel={t("settings.canvas_width")}
                onValueChange={(v) => setDraft({ width: v, height })}
              />
              <span aria-hidden="true">×</span>
              <AppNumberField
                value={height}
                disabled={disabled}
                step={2}
                align="center"
                ariaLabel={t("settings.canvas_height")}
                onValueChange={(v) => setDraft({ width, height: v })}
              />
              <Button
                variant="secondary"
                disabled={disabled || !dirty || sizeError !== null}
                onClick={() => void patch({ width, height })}
              >
                {t("settings.canvas_apply")}
              </Button>
            </div>
          </div>
          {sizeError !== null && (
            <p className="settings-error" role="alert">
              {sizeError}
            </p>
          )}
        </>
      )}

      <div className="settings-control-row">
        <span className="settings-toggle-label">{t("settings.canvas_fps")}</span>
        <AppSelect
          className="settings-select"
          value={fpsValue}
          disabled={disabled || (composition?.fpsLocked ?? false)}
          ariaLabel={t("settings.canvas_fps")}
          onValueChange={(v) => {
            const [num, den] = v.split("/").map(Number);
            void patch({ fps: { num, den } });
          }}
          options={fpsOptions.map((f) => ({
            value: `${f.num}/${f.den}`,
            label: fpsLabel(f, t),
          }))}
        />
      </div>
      {/* One unconditional statement of the rule rather than a locked/unlocked
          pair: it reads the same either way, and the disabled control already
          says which side of it this project is on. */}
      <p className="settings-toggle-hint">{t("settings.canvas_fps_hint")}</p>
    </>
  );
}

function CompositionSection({
  composition,
  onChanged,
  onError,
}: {
  composition: CompositionState | null;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /// Local edit buffer for the timecode input while the user is typing.
  /// `null` means "not editing — display the canonical formatted value".
  const [draft, setDraft] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset draft + local error whenever the upstream composition snapshot
  // changes (e.g., the user committed, or a layer edit elsewhere refit
  // the duration). Compare on the `durationUs` + pin flag to avoid
  // resetting while the user is mid-keystroke against the same value.
  useEffect(() => {
    setDraft(null);
    setLocalError(null);
  }, [composition?.durationUs, composition?.durationPinned]);

  const pinned = composition?.durationPinned ?? false;
  const disabled = composition === null || busy;
  const displayValue =
    composition === null
      ? ""
      : formatTimecode(composition.durationUs, composition.fpsNum, composition.fpsDen);
  const floorDisplay =
    composition === null
      ? ""
      : formatTimecode(composition.layersMaxEndUs, composition.fpsNum, composition.fpsDen);
  // Both readouts here are DURATIONS, so at 23.976/29.97/59.94 their NDF digits
  // under-report real time by ~0.1% and the wall-clock figure says so. Null at
  // integer rates — the two figures would be identical (spec R2-D3).
  const durationWallClock =
    composition === null
      ? null
      : wallClockAside(composition.durationUs, composition.fpsNum, composition.fpsDen);
  const floorWallClock =
    composition === null
      ? null
      : wallClockAside(composition.layersMaxEndUs, composition.fpsNum, composition.fpsDen);

  /// Pure validator — runs on every keystroke so the user sees feedback
  /// while typing rather than only on commit. Returns the localized
  /// error string or null when the draft is valid.
  const validateDraft = (value: string): string | null => {
    if (!composition) return null;
    const parsed = parseTimecode(value, composition.fpsNum, composition.fpsDen);
    if (parsed === null) return t("settings.composition_duration_invalid");
    if (parsed < composition.layersMaxEndUs) {
      return t("settings.composition_duration_below_floor", {
        floor: floorDisplay,
      });
    }
    return null;
  };

  const togglePin = async (next: boolean) => {
    if (!composition || busy) return;
    setBusy(true);
    onError("");
    setLocalError(null);
    try {
      if (next) {
        // Pin at the current auto-fitted value — the user can edit the
        // input afterward to change it.
        await setCompositionOf(composition.id, { duration_us: composition.durationUs });
      } else {
        await fitCompositionToLayersOf(composition.id);
      }
      await onChanged();
    } catch (e) {
      onError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!composition || busy || draft === null) return;
    // Live validation already populated localError on every keystroke;
    // if it's set, refuse to commit. The IPC layer would reject below-
    // floor values anyway (overflow guard), but bailing early keeps the
    // history clean.
    if (localError !== null) return;
    const parsed = parseTimecode(draft, composition.fpsNum, composition.fpsDen);
    if (parsed === null) return;
    if (parsed === composition.durationUs) {
      // No-op commit — just clear the draft state.
      setDraft(null);
      return;
    }
    setBusy(true);
    onError("");
    try {
      await setCompositionOf(composition.id, { duration_us: parsed });
      await onChanged();
      setDraft(null);
    } catch (e) {
      onError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-pin-row">
        <label className="settings-pin-checkbox">
          <AppSwitch
            checked={pinned}
            disabled={disabled}
            onCheckedChange={(next) => {
              void togglePin(next);
            }}
          />
          <span className="settings-toggle-label">
            {t("settings.pin_composition_duration")}
          </span>
        </label>
        <AppInput id="composition-duration" value={draft ?? displayValue} disabled={disabled || !pinned}
          spellCheck={false} mono align="center" invalid={!!localError} className="settings-input"
          ariaLabel={t("settings.composition_duration_label")}
          onValueChange={(v) => { setDraft(v); setLocalError(validateDraft(v)); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              // Consume: this Escape reverts the draft only; without
              // stopPropagation the Settings dialog would close too.
              e.stopPropagation();
              setDraft(null);
              setLocalError(null);
            }
          }}
          onBlur={() => { if (draft !== null) void commit(); }}
          aria-invalid={localError !== null}
          aria-describedby={
            localError ? "composition-duration-error" : "composition-duration-hint"
          } />
      </div>
      {localError ? (
        <p
          id="composition-duration-error"
          className="settings-error"
          role="alert"
        >
          {localError}
        </p>
      ) : (
        <p
          id="composition-duration-hint"
          className="settings-toggle-hint"
        >
          {t("settings.pin_composition_duration_hint", { floor: floorDisplay })}
        </p>
      )}
      {durationWallClock !== null && (
        <p className="settings-toggle-hint">
          {t("settings.duration_wall_clock", {
            tc: displayValue,
            wall: durationWallClock,
          })}
          {floorWallClock !== null
            ? ` ${t("settings.content_end_wall_clock", { tc: floorDisplay, wall: floorWallClock })}`
            : ""}
        </p>
      )}
    </>
  );
}

function SpeechSection({ onError }: { onError: (msg: string) => void }) {
  return <ModelSection family="speech" onError={onError} />;
}

const FONT_FAMILIES = [
  "Noto Sans SC",
  "Liberation Sans",
  "Arial",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Tahoma",
];

/// Manage app-wide imported fonts: import new ones, remove existing ones.
/// Lives in General settings so users discover it independently of the
/// text-layer inspector. Each import copies the file to <userData>/fonts/
/// and registers it in document.fonts for the current session.
function FontsSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const [fonts, setFonts] = useState<{ family: string; filename: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const defaultTextFont = useDefaultTextFont();

  const refresh = useCallback(async () => {
    try {
      const list = await fontListImported();
      setFonts(list);
    } catch (err) {
      onError(String(err));
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleImport = async () => {
    setImporting(true);
    onError("");
    try {
      const result = await pickAndImportFont(
        t("settings.import_font_title", { defaultValue: "Import font file" })
      );
      if (result) {
        await refresh();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        disabled={importing}
        onClick={() => void handleImport()}
        style={{ marginBottom: "10px" }}
      >
        {importing
          ? t("settings.importing_font", { defaultValue: "Importing…" })
          : t("settings.import_font_button", { defaultValue: "Import font file…" })}
      </Button>

      {fonts.length === 0 ? (
        <p className="settings-toggle-hint">
          {t("settings.fonts_empty", { defaultValue: "No custom fonts imported yet." })}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
          {fonts.map((f) => (
            <li key={f.filename} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ flex: 1, fontSize: "13px" }}>{f.family}</span>
              <span className="settings-toggle-hint" style={{ fontSize: "11px" }}>{f.filename}</span>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: "24px" }}>
        <h4 style={{ fontSize: "12px", fontWeight: 500, marginBottom: "8px" }}>
          {t("settings.default_text_font", { defaultValue: "Default Text Font" })}
        </h4>
        <label className="settings-toggle-row" style={{ alignItems: "center" }}>
          <span>
            <span className="settings-toggle-label">
              {t("settings.default_text_font_label", { defaultValue: "Font Family" })}
            </span>
            <span className="settings-toggle-hint">
              {t("settings.default_text_font_hint", { defaultValue: "The default font for new text layers." })}
            </span>
          </span>
          <AppSelect
            value={defaultTextFont ?? ""}
            onValueChange={async (next) => {
              try {
                await setAppSettings({ default_text_font: next });
              } catch (err) {
                onError(String(err));
              }
            }}
            options={[
              { value: "", label: t("settings.default_text_font_none", { defaultValue: "App Default" }) },
              ...fonts.map((f) => ({ value: f.family, label: f.family })),
              ...FONT_FAMILIES.map((f) => ({ value: f, label: f })),
            ]}
          />
        </label>
      </div>
    </div>
  );
}
