import { open as openDialog } from "@/bridge/dialog";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "../i18n";
import { setLocale } from "../settings/appSettingsStore";
import { useNativeMenu } from "../menu/nativeMenu";
import {
  useShortcuts,
  type HandlerMap,
  type OverrideMap,
} from "../shortcuts/useShortcuts";
import { wireDecodeComponent } from "../settings/decodeComponentStore";
import { SettingsPanel } from "../settings/SettingsPanel";
import { WindowControls } from "../components/WindowControls";
import { DiagnosticReport } from '../app/DiagnosticReport';
import { UpdateButton } from '../app/UpdateButton';
import {
  ChevronDownIcon,
  BugIcon,
  ChevronUpIcon,
  FileInputIcon,
  FolderOpenIcon,
  GlobeIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import {
  keybindingsGet,
  projectOpen,
  recentsList,
  recentsRemove,
  type KeybindingsMap,
  type RecentEntry,
} from "../ipc";
import { LogoPulsePaths } from "./LogoPulsePaths";
import {
  cleanIpcDetail,
  describeOpenError,
  isDeadRecentError,
} from "./openError";
import { AppIcon } from "@/components/AppIcon";
import { useTimelineImportFlow } from "./useTimelineImportFlow";
import { NewProjectForm } from "./NewProjectForm";

interface Props {
  /// Called once the user has successfully picked or created a workspace.
  /// The host (`main.tsx`) flips the rendered tree to `<App />`.
  onWorkspaceReady: () => void;
}

/// Top-level entry surface per workspace-redesign Q7. Every editor session
/// starts here; the user must pick Create / Open / Recent to advance into
/// the editor.
export function StartupScreen({ onWorkspaceReady }: Props) {
  const { t, i18n } = useTranslation();
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const timelineImport = useTimelineImportFlow({ fromStartup: true, onWorkspaceReady });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [keybindings, setKeybindings] = useState<KeybindingsMap>({});
  const [recentsExpanded, setRecentsExpanded] = useState(readRecentsExpanded);
  const toggleRecentsExpanded = useCallback(() => {
    const next = !recentsExpanded;
    setRecentsExpanded(next);
    writeRecentsExpanded(next);
  }, [recentsExpanded]);

  // Settings is the only catalogued action this screen can run — there is no
  // project yet to save or export — so it is the only one it dispatches and the
  // only one it projects into the macOS App menu (the editor projects File as
  // well). Both, because Cmd+, must work before any project exists: the
  // dispatcher serves every platform, the menu adds the Mac convention.
  // `keybindings` is a Record<string, string[]> from main; the cast narrows it
  // to the catalogue's ids, exactly as App.tsx does.
  const settingsHandlers = useMemo<HandlerMap>(
    () => ({ openSettings: () => setSettingsOpen(true) }),
    [],
  );
  const settingsOverrides = keybindings as OverrideMap;
  useShortcuts({ handlers: settingsHandlers, overrides: settingsOverrides });
  useNativeMenu({ handlers: settingsHandlers, overrides: settingsOverrides });

  // A first-launch user on a foreign locale needs a way to switch *before*
  // they can read any of the buttons. Mirrors the editor's header toggle.
  const cycleLocale = useCallback(() => {
    const current = i18n.language as Locale;
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next =
      SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? "en-US";
    // Persists to app_settings.json AND switches i18next (see setLocale).
    setLocale(next);
  }, [i18n]);

  const refreshRecents = useCallback(async () => {
    try {
      setRecents(await recentsList());
    } catch (e) {
      // Reading the list has no refusal vocabulary of its own — a failure here
      // is the store's fs or JSON, which stays English (see cleanIpcDetail).
      setError(t("startup.recents_load_failed", { detail: cleanIpcDetail(e) }));
    }
  }, [t]);

  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  // Effective bindings are needed before the Settings dialog is ever opened:
  // this screen dispatches Cmd+, itself and projects that chord into the macOS
  // App menu. Reading them only alongside the dialog (below) would show — and
  // on macOS bind — the catalogue default to a user who had rebound it.
  useEffect(() => {
    keybindingsGet()
      .then(setKeybindings)
      .catch(() => {});
  }, []);

  // App preferences are wired at the renderer root. Load dialog-only services
  // here and refresh shortcuts in case another window changed them.
  useEffect(() => {
    if (!settingsOpen) return;
    void wireDecodeComponent();
    keybindingsGet()
      .then(setKeybindings)
      .catch(() => {});
  }, [settingsOpen]);

  const runProtected = useCallback(
    async (
      action: () => Promise<void>,
      formatError?: (err: unknown) => string,
    ) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(formatError ? formatError(e) : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const openWorkspaceFolder = useCallback(async () => {
    const picked = await openDialog({
      title: t("startup.open_dialog_title"),
      directory: true,
      multiple: false,
    });
    if (typeof picked !== "string") return;
    await runProtected(
      async () => {
        await projectOpen(picked);
        onWorkspaceReady();
      },
      (e) => describeOpenError(e, picked, t),
    );
  }, [t, runProtected, onWorkspaceReady]);

  const openRecent = useCallback(
    async (entry: RecentEntry) => {
      await runProtected(
        async () => {
          try {
            await projectOpen(entry.path);
            onWorkspaceReady();
          } catch (e) {
            // Folder was moved/deleted (PROJECT_FOLDER_MISSING) or stopped
            // being a project (NOT_PROJECT_FOLDER). Either way the entry is
            // permanently dead — drop it so the list doesn't keep offering
            // it. Transient errors keep the entry for a retry.
            if (isDeadRecentError(e)) {
              await recentsRemove(entry.path).catch(() => {});
              await refreshRecents();
            }
            throw e;
          }
        },
        (e) => describeOpenError(e, entry.path, t),
      );
    },
    [t, runProtected, onWorkspaceReady, refreshRecents],
  );

  return (
    <div className="startup-screen">
      {/* Frameless window: the startup screen has no app header, so a
          slim strip along the top carries the drag region + caption
          buttons. */}
      <div className="startup-titlebar" data-drag-region>
        {/* Top-left app-level affordances: settings apply below-project
            scope, so they're reachable before a workspace exists. The
            locale toggle + caption buttons stay on the right. */}
        <div className="startup-titlebar-actions">
          <button
            type="button"
            className="startup-settings-toggle"
            onClick={() => setSettingsOpen(true)}
            title={t("settings.heading")}
            aria-label={t("settings.heading")}
          >
            <AppIcon icon={SettingsIcon} size="heading" strokeWidth={1.5} aria-hidden />
          </button>
          <button type="button" className="startup-report-toggle"
            onClick={() => setReportOpen(true)} title={t('help.report_issue')} aria-label={t('help.report_issue')}>
            <AppIcon icon={BugIcon} size="heading" strokeWidth={1.5} aria-hidden />
          </button>
          <UpdateButton />
        </div>
        <button
          type="button"
          className="startup-locale-toggle"
          onClick={cycleLocale}
          title={t("language.switch_label")}
          aria-label={t("language.switch_label")}
        >
          <AppIcon icon={GlobeIcon} className="globe-icon" size="title" aria-hidden />
          <span className="locale-toggle-label">
            {LOCALE_LABELS[(i18n.resolvedLanguage ?? "en-US") as Locale] ??
              "English"}
          </span>
        </button>
        <WindowControls />
      </div>
      <div className="startup-panel">
        <header className="startup-header">
          {/* Decorative: the <h1> already announces the product name, so the
              mark is aria-hidden to avoid a duplicate read-out. Served from
              renderer/public — the same SVG the window favicon uses. */}
          <span className="startup-logo-mark" aria-hidden="true">
            <img
              className="startup-logo"
              src="./icons/icon.svg"
              alt=""
              width={44}
              height={44}
            />
            <svg
              className="startup-logo-pulse-trace"
              viewBox="0 0 440 440"
              fill="none"
              focusable="false"
            >
              <defs>
                <clipPath id="startup-logo-w-clip">
                  <path d="M200.117 167.417L151.477 239.378C149.409 242.438 144.851 242.276 143.004 239.078L95.331 156.5C92.6515 151.859 87.6995 149 82.3404 149H10.0005C4.47764 149 0.000488281 153.477 0.000488281 159V183C0.000488281 188.523 4.47764 193 10.0005 193H57.3059C62.6835 193 67.6496 195.879 70.3222 200.545L124.679 295.455C127.352 300.121 132.318 303 137.696 303H154.024C159.011 303 163.672 300.522 166.461 296.387L220.001 217L273.541 296.387C276.329 300.522 280.99 303 285.977 303H302.306C307.683 303 312.649 300.121 315.322 295.455L369.679 200.545C372.352 195.879 377.318 193 382.696 193H430C435.523 193 440 188.523 440 183V159C440 153.477 435.523 149 430 149L357.661 149C352.302 149 347.35 151.859 344.671 156.5L296.997 239.078C295.151 242.276 290.593 242.438 288.525 239.378L239.885 167.417C230.368 153.337 209.634 153.337 200.117 167.417Z" />
                </clipPath>
              </defs>
              <g clipPath="url(#startup-logo-w-clip)">
                <LogoPulsePaths />
              </g>
            </svg>
          </span>
          <div className="startup-heading-text">
            <h1>{t("app.title")}</h1>
            <p className="startup-subtitle">{t("startup.subtitle")}</p>
          </div>
        </header>

        <div className="startup-actions">
          <button
            type="button"
            className="startup-action primary"
            onClick={() => setNewProjectOpen(true)}
            disabled={busy || timelineImport.busy}
          >
            <AppIcon icon={PlusIcon} size="display" strokeWidth={1.5} aria-hidden />
            <span className="startup-action-label">{t("startup.new_project")}</span>
          </button>
          <button
            type="button"
            className="startup-action"
            onClick={openWorkspaceFolder}
            disabled={busy || timelineImport.busy}
          >
            <AppIcon icon={FolderOpenIcon} size="display" strokeWidth={1.5} aria-hidden />
            <span className="startup-action-label">{t("startup.open_project")}</span>
          </button>
          <button
            type="button"
            className="startup-action"
            onClick={timelineImport.begin}
            disabled={busy || timelineImport.busy}
          >
            <AppIcon icon={FileInputIcon} size="display" strokeWidth={1.5} aria-hidden />
            <span className="startup-action-label">{t("startup.import_timeline")}</span>
          </button>
        </div>

        {error && <p className="startup-error">{error}</p>}

        <section className="startup-recent" style={RECENT_BODY_STYLE}>
          <div className="startup-recent-header">
            <h2>{t("startup.recent_heading")}</h2>
            {recents !== null && recents.length > COLLAPSED_RECENT_COUNT && (
              <button
                type="button"
                className="startup-recent-toggle"
                onClick={toggleRecentsExpanded}
                aria-expanded={recentsExpanded}
              >
                <span
                  className="startup-recent-toggle-chevron"
                  aria-hidden="true"
                >
                  {recentsExpanded ? (
                    <AppIcon icon={ChevronUpIcon} size="body" />
                  ) : (
                    <AppIcon icon={ChevronDownIcon} size="body" />
                  )}
                </span>
                {recentsExpanded
                  ? t("startup.recent_show_less")
                  : t("startup.recent_show_all", { count: recents.length })}
              </button>
            )}
          </div>
          {recents === null ? (
            <p className="startup-recent-empty">{t("startup.recent_loading")}</p>
          ) : recents.length === 0 ? (
            <p className="startup-recent-empty">{t("startup.recent_empty")}</p>
          ) : (
            <ul
              className="startup-recent-list"
              data-expanded={recentsExpanded || undefined}
            >
              {(recentsExpanded
                ? recents
                : recents.slice(0, COLLAPSED_RECENT_COUNT)
              ).map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="startup-recent-item"
                    onClick={() => openRecent(entry)}
                    disabled={busy}
                    title={entry.path}
                  >
                    <span className="startup-recent-name">{entry.name}</span>
                    <span className="startup-recent-meta">
                      {formatLastOpened(entry.last_opened, t)}
                    </span>
                    <span className="startup-recent-path">{entry.path}</span>
                  </button>
                  <button
                    type="button"
                    className="startup-recent-remove"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await recentsRemove(entry.path).catch(() => {});
                      await refreshRecents();
                    }}
                    title={t("startup.recent_remove_hint")}
                    aria-label={t("startup.recent_remove_hint")}
                  >
                    <AppIcon icon={XIcon} size="title" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {timelineImport.dialogs}
      {newProjectOpen && (
        <NewProjectForm
          onCancel={() => setNewProjectOpen(false)}
          onCreated={() => {
            setNewProjectOpen(false);
            onWorkspaceReady();
          }}
        />
      )}
      {settingsOpen && (
        // No composition props: there is no open project here, so the
        // project-scoped "Project" category hides itself (see SettingsPanel).
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          keybindings={keybindings}
          onKeybindingsChanged={setKeybindings}
        />
      )}
      {reportOpen && <DiagnosticReport onClose={() => setReportOpen(false)} />}
    </div>
  );
}

/// How many recents to show before the disclosure toggle appears. Main caps
/// the store at 10 (`main/recents.ts::MAX_RECENTS`), so the "expanded" view
/// reveals at most 7 additional entries.
const COLLAPSED_RECENT_COUNT = 3;

/// The recents body is this many rows tall (see `.startup-recent` in
/// startup.css), so CSS reads the count from here rather than keeping a twin.
const RECENT_BODY_STYLE = {
  "--startup-recent-visible-rows": COLLAPSED_RECENT_COUNT,
} as CSSProperties;

/// The recents disclosure is remembered for the window's session: it survives
/// the hop back from the editor and a renderer reload, and a new window or app
/// launch starts collapsed. Not an app setting.
const RECENTS_EXPANDED_KEY = "weftcut.startup.recentsExpanded";

function readRecentsExpanded(): boolean {
  return sessionStorage.getItem(RECENTS_EXPANDED_KEY) === "1";
}

function writeRecentsExpanded(expanded: boolean): void {
  sessionStorage.setItem(RECENTS_EXPANDED_KEY, expanded ? "1" : "0");
}

function formatLastOpened(iso: string, t: TFunction): string {
  const opened = new Date(iso);
  if (isNaN(opened.getTime())) return iso;
  const now = new Date();
  const diffMs = now.getTime() - opened.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return t("startup.time_just_now");
  if (diffMs < hour) {
    return t("startup.time_minutes_ago", {
      count: Math.floor(diffMs / minute),
    });
  }
  if (diffMs < day) {
    return t("startup.time_hours_ago", { count: Math.floor(diffMs / hour) });
  }
  if (diffMs < 7 * day) {
    return t("startup.time_days_ago", { count: Math.floor(diffMs / day) });
  }
  return opened.toLocaleDateString();
}
