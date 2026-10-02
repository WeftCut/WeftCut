import { convertFileSrc, invoke } from "@/bridge/ipc";
import { listen } from "@/bridge/events";
import { SecondaryWindow, getCurrentWindow, ProgressBarStatus } from "@/bridge/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@/bridge/notification";
import { reveal as revealInShell } from "@/bridge/shell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createExportLogMirror } from "./exportLog";
import { runExportPipeline } from "./runExportPipeline";
import { type ExportSettings } from "../render/exportSettings";
import { type ProxyState } from "../panels/mediaReadiness";
import { type ProbeState } from "../render/exportReadiness";
import { type ExportState } from "../panels/ExportPanel";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { rootCompositionOf } from "../state/projectStore";
import { projectSummary } from "../ipc";
import { createExportJobController } from "./exportJobController";

/// Owns the export lifecycle: the export panel/dialog state, the window
/// close-guard, taskbar-progress + native-notification mirrors, and the
/// three-stage export pipeline itself. The refs in `deps` still live in
/// App (other consumers read them there); the hook takes them as inputs.
export function useExportFlow(deps: {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
}): {
  exportState: ExportState | null;
  setExportState: React.Dispatch<React.SetStateAction<ExportState | null>>;
  exportDialogOpen: boolean;
  setExportDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeConfirmOpen: boolean;
  setCloseConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runExportWithSettings: (settings: ExportSettings, path: string,
    range?: { startUs: number; endUs: number }) => Promise<void>;
  openRenderPlayPopup: (path: string) => Promise<void>;
  revealExportedFile: (path: string) => void;
} {
  const { t } = useTranslation();
  const { previewRef, proxyStateRef, decodeProbeMemo } = deps;

  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // Close-guard: the window ✕ (or any close request) during a running
  // export pops a confirm instead of silently killing the export. The ref
  // mirrors export-busy so the close-requested listener (registered once)
  // reads fresh state.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const exportBusyRef = useRef(false);

  // Close-guard wiring. "Busy" = an export that closing would kill;
  // complete/error states are dismissable and don't block the window.
  useEffect(() => {
    exportBusyRef.current =
      exportState !== null &&
      exportState.kind !== "complete" &&
      exportState.kind !== "error";
  }, [exportState]);
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      if (exportBusyRef.current) {
        event.preventDefault();
        setCloseConfirmOpen(true);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Taskbar progress mirrors the export lifecycle (ITaskbarList3 on
  // Windows, via Electron): indeterminate pulse while starting/preparing,
  // percent while encoding, error-red on failure, cleared on dismiss or
  // completion. Best-effort — a failed call never blocks the export.
  useEffect(() => {
    const win = getCurrentWindow();
    const set = (bar: Parameters<typeof win.setProgressBar>[0]) =>
      void win.setProgressBar(bar).catch(() => {});
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
        .catch(() => {});
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
            body: t("export.notify_failed_body", { detail: state.detail }),
          });
        }
      } catch {
        // Notifications are a courtesy; never let them surface as errors.
      }
    })();
  }, [exportState, t]);

  const translateRef = useRef(t);
  translateRef.current = t;
  // Subscribe before advertising readiness: both UI and MCP use main admission.
  const controller = useMemo(() => createExportJobController({
    invoke,
    listen,
    run: (request, signal, onState) => runExportPipeline(
      request.settings, request.output_path, request.range,
      { previewRef, proxyStateRef, decodeProbeMemo, signal,
        t: (key, vars) => translateRef.current(key, vars ?? {}), onState,
        ...(request.agent ? {} : { confirmFallback: (message: string) => window.confirm(message) }) },
    ),
    onBegin: (request) => exportLog.begin({ output: request.output_path, codec: request.settings.codec }),
    onState: setExportState,
  }), [previewRef, proxyStateRef, decodeProbeMemo, exportLog]);
  useEffect(() => {
    void controller.mount().catch((error: unknown) => {
      setExportState({ kind: "error", detail: error instanceof Error ? error.message : String(error) });
    });
    return () => { void controller.dispose(); };
  }, [controller]);

  const runExportWithSettings = useCallback(async (
    settings: ExportSettings, path: string,
    range?: { startUs: number; endUs: number },
  ) => {
    try {
      await controller.ready;
      const summary = await projectSummary();
      if (!summary) throw new Error("No project loaded.");
      await controller.start({
        settings,
        output_path: path,
        range: range ?? { startUs: 0, endUs: rootCompositionOf(summary).duration_us },
        agent: false,
        allow_experimental_10bit: true,
      });
    } catch (error) {
      setExportState({ kind: "error", detail: error instanceof Error ? error.message : String(error) });
    }
  }, [controller]);

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
    closeConfirmOpen,
    setCloseConfirmOpen,
    runExportWithSettings,
    openRenderPlayPopup,
    revealExportedFile,
  };
}
