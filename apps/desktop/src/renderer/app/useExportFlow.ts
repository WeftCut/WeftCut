import { convertFileSrc, invoke } from "@/bridge/ipc";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@/bridge/notification";
import { reveal as revealInShell } from "@/bridge/shell";
import { getCurrentWindow, ProgressBarStatus, SecondaryWindow } from "@/bridge/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isResourceCapacityError } from "../../shared/resource-policy";
import { isFfmpegStallError } from "../../shared/ffmpeg-stall";
import { type ExportState } from "../panels/ExportPanel";
import { type ProxyState } from "../panels/mediaReadiness";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import {
  type ProbeState
} from "../render/exportReadiness";
import {
  type ExportSettings
} from "../render/exportSettings";
import { createExportJobController } from "./exportJobController";
import { createExportLogMirror } from "./exportLog";

/// UI adapter for the shared application job: panel/dialog state, taskbar
/// progress, notifications and export logs. Main owns exit protection; the
/// controller owns renderer readiness and delegates work to exportRunner.
export function useExportFlow(deps: {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
}): {
  exportState: ExportState | null;
  setExportState: React.Dispatch<React.SetStateAction<ExportState | null>>;
  exportDialogOpen: boolean;
  setExportDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runExportWithSettings: (settings: ExportSettings, path: string,
    range?: { startUs: number; endUs: number }, overwrite?: boolean) => Promise<void>;
  openRenderPlayPopup: (path: string) => Promise<void>;
  revealExportedFile: (path: string) => void;
} {
  const { t } = useTranslation();

  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // No close guard here: main's own `close` / `before-quit` handlers ask
  // before an active export (including one waiting to retry its save) is
  // discarded (`confirmQuit` in main/index.ts) — the one place every way of
  // quitting passes through.

  // Taskbar progress mirrors the export lifecycle (ITaskbarList3 on
  // Windows, via Electron): indeterminate pulse while starting/preparing,
  // percent while encoding, error-red on failure, cleared on dismiss or
  // completion. Best-effort — a failed call never blocks the export.
  useEffect(() => {
    const win = getCurrentWindow();
    const set = (bar: Parameters<typeof win.setProgressBar>[0]) =>
      void win.setProgressBar(bar).catch(() => { });
    if (exportState === null || exportState.kind === "complete") {
      set({ status: ProgressBarStatus.None });
      return;
    }
    switch (exportState.kind) {
      case "starting":
      case "preparing":
        set({ status: ProgressBarStatus.Indeterminate });
        break;
      case "progress":
        set({
          status: ProgressBarStatus.Normal,
          progress: Math.round(exportState.progress.progress * 100),
        });
        break;
      case "finalizing":
        // Full but not done. Indeterminate would be more literally true (the
        // tail has no sub-progress) but reads as a regression on the taskbar —
        // a bar that just filled must not start pulsing again.
        set({ status: ProgressBarStatus.Normal, progress: 100 });
        break;
      case "error":
        set({ status: ProgressBarStatus.Error, progress: 100 });
        break;
    }
  }, [exportState]);
  // Clear any leftover taskbar state if the editor unmounts (project
  // closed) while a progress bar is showing.
  useEffect(() => {
    return () => {
      void getCurrentWindow()
        .setProgressBar({ status: ProgressBarStatus.None })
        .catch(() => { });
    };
  }, []);

  // LogBus mirror — the third lifecycle observer next to the taskbar and
  // notification effects. Row shapes and the reason it watches state instead
  // of instrumenting the pipeline: exportLog.ts.
  const exportLog = useMemo(() => createExportLogMirror(), []);
  useEffect(() => {
    exportLog.observe(exportState);
  }, [exportLog, exportState]);

  // Native toast when an export reaches a terminal state while the window
  // is unfocused — the in-app panel and taskbar progress are invisible to
  // a user working in another app. Terminal states are set exactly once
  // per export, so this fires at most once each. Best-effort.
  useEffect(() => {
    if (
      !exportState ||
      (exportState.kind !== "complete" && exportState.kind !== "error")
    ) {
      return;
    }
    const state = exportState;
    void (async () => {
      try {
        if (await getCurrentWindow().isFocused()) return;
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (!granted) return;
        if (state.kind === "complete") {
          sendNotification({
            title: t("export.notify_done_title"),
            body: t("export.notify_done_body", {
              path: state.payload.outputPath,
            }),
          });
        } else {
          sendNotification({
            title: t("export.notify_failed_title"),
            body: isResourceCapacityError(state.detail)
              ? t("export.resource_unavailable")
              : isFfmpegStallError(state.detail)
                ? t("export.encoder_stalled")
                : t("export.notify_failed_body", { detail: state.detail }),
          });
        }
      } catch {
        // Notifications are a courtesy; never let them surface as errors.
      }
    })();
  }, [exportState, t]);


  const controllerRef = useRef<ReturnType<typeof createExportJobController> | null>(null);
  const translationRef = useRef(t);
  translationRef.current = t;
  useEffect(() => {
    const translate = ((...args: Parameters<typeof t>) => translationRef.current(...args)) as typeof t;
    const controller = createExportJobController({
      ...deps, t: translate, onState: setExportState, onBegin: request => {
        setExportDialogOpen(false);
        exportLog.begin({ output: request.output_path, codec: request.settings.codec });
      }
});
    controllerRef.current = controller;
    void controller.mount().catch(error => setExportState({ kind: 'error', detail: String(error) }));
    return () => { controllerRef.current = null; void controller.dispose(); };
  }, [deps.previewRef, deps.proxyStateRef, deps.decodeProbeMemo, exportLog]);
  const runExportWithSettings = useCallback(async (settings: ExportSettings, path: string, range?: { startUs: number; endUs: number }, overwrite = false) => {
    try {
      const job = await invoke<import('../../shared/exportJob').ExportJob>('export_job_start', { settings, output_path: path, ...(range ? { range } : {}), on_conflict: overwrite ? 'overwrite' : 'fail' });
      if (job.state === 'failed') setExportState({ kind: 'error', detail: job.error?.message ?? 'Export failed' });
      else if (!['completed', 'cancelled', 'awaiting_retry'].includes(job.state)) await controllerRef.current?.waitUntilSettled(job.job_id);
    } catch (e) { setExportState({ kind: 'error', detail: e instanceof Error ? e.message : String(e) }); }
  }, []);

  // E2E-only: mirror the export phase onto window so a WebDriver diagnostic can
  // see where a hung export is stuck (null → starting → preparing → progress →
  // finalizing → complete/error), and to feed driveExport's stall probe: every
  // phase here carries something that CHANGES while the pipeline is alive.
  // Stripped from prod (static VITE_WEFTCUT_E2E check).
  useEffect(() => {
    if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
    (window as unknown as { __weftcutExportState?: unknown }).__weftcutExportState =
      exportState;
  }, [exportState]);

  // Render & Play: open an Electron window pointing at the
  // exported MP4 via the weftcut-media:// protocol. The popup HTML lives at
  // /render-play.html (vite copies from public/); URL hash carries
  // the asset URL + display path + the localized window title (the page is
  // static HTML with no i18next, so it takes the title from us rather than
  // hard-coding English). Each invocation gets a unique
  // label so multiple plays can coexist (and so the capability
  // pattern `render-play-*` matches every variant).
  const openRenderPlayPopup = useCallback(
    async (path: string) => {
      const src = convertFileSrc(path);
      const label = `render-play-${Date.now()}`;
      const title = t("export.render_play_title");
      const url =
        `/render-play.html#src=${encodeURIComponent(src)}` +
        `&path=${encodeURIComponent(path)}` +
        `&title=${encodeURIComponent(title)}`;
      try {
        // Window load failures surface in the main-process console (win:* IPC is
        // fire-and-forget; the secondary-window lifecycle isn't bridged back).
        new SecondaryWindow(label, {
          url,
          title,
          width: 960,
          height: 600,
          resizable: true,
        });
      } catch (e) {
        console.error("[weftcut/render-play] failed to open popup:", e);
      }
    },
    [t],
  );

  // Reveal the exported file in the OS file manager. A failure (the file was
  // moved after the export finished, no file manager on the box) is logged,
  // not surfaced: the dialog already prints the full path, which is the
  // fallback the user needs.
  const revealExportedFile = useCallback((path: string) => {
    void revealInShell(path).catch((e: unknown) => {
      console.error("[weftcut/export] failed to reveal exported file:", e);
    });
  }, []);

  return {
    exportState,
    setExportState,
    exportDialogOpen,
    setExportDialogOpen,
    runExportWithSettings,
    openRenderPlayPopup,
    revealExportedFile,
  };
}
