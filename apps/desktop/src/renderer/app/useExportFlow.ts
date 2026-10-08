import { prepareExportResourcePlans } from '../render/exportResourcePlan';
import { convertFileSrc } from "@/bridge/ipc";
import { listen } from "@/bridge/events";
import { join, tempDir } from "@/bridge/path";
import { SecondaryWindow, getCurrentWindow, ProgressBarStatus } from "@/bridge/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@/bridge/notification";
import { remove, writeFile } from "@/bridge/fs";
import { reveal as revealInShell } from "@/bridge/shell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createExportFinalization } from "../render/exportFinalization";
import { admitExportResources } from "../render/resourceClient";
import { createExportLogMirror } from "./exportLog";
import {
  ensureExportAudioConform,
  ensureExportAudioFx,
  ensureFullProxy,
  exportProjectAudioOnly,
  muxExport,
  MEDIA_JOB_EVENTS,
  type MediaJobEvent,
  projectSummary,
  type MediaSummary,
  type ProjectSummary,
} from "../ipc";
import { type ProxyState } from "../panels/mediaReadiness";
import { classifyWebcodecsDecodability } from "../render/decoder/probeSourceDecodable";
import { hasVisibleContent, referencedVideoMediaIds } from "../render/activeVideoLayers";
import {
  type ExportSettings,
  type WebCodecsCodecId,
  codecString,
  bufferSizeApplies,
  compositeBitDepth,
  computeBitrate,
  defaultCrf,
  encoderHwHint,
  gopFrames,
  isIntermediateCodec,
  maxBitrateApplies,
  resolveOutputDims,
} from "../render/exportSettings";
import { approxFrameDurUs } from "../frames";
import {
  exportVideoSinkStart,
  exportVideoSinkFinish,
  exportVideoSinkCancel,
  exportVideoSinkWrite,
} from "../ipc";
import { smokeEncode } from "../render/exportCodecProbe";
import { needsEncoderProbe, resolveEncodeTarget } from "../render/encodeTarget";
import {
  type ExportDecodeRouting,
  proxyWaitScope,
  resolveExportDecodeRouting,
} from "../render/exportDecodeRouting";
import { useDecodeComponentStore } from "../settings/decodeComponentStore";
import {
  prepareExportMedia,
  runAudioFxGate,
  waitForProxies,
  createConformTracker,
  ExportCancelled,
  ExportProxyFailed,
  type AudioFxGateOutcome,
  type ProbeState,
} from "../render/exportReadiness";
import { getAudioEffect } from "../../shared/audioEffects/catalog";
import { type ExportState } from "../panels/ExportPanel";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { rootCompositionOf, useProjectStore } from "../state/projectStore";
import { resolveDecode } from "../render/decodeRoute";
import { isResourceCapacityError } from "../../shared/resource-policy";

/// The status-bar detail for an exception out of a readiness gate. A proxy or
/// conform failure names its media through `prepareDetail`; any other
/// exception — a napi deserialization error, an IPC fault — is reported as
/// itself, because dressing it as a media failure with an empty label hides
/// the cause behind "Couldn't prepare  for export".
function gateFailureDetail(e: unknown, prepareDetail: (mediaId: string) => string): string {
  if (e instanceof ExportProxyFailed) return prepareDetail(e.mediaId);
  return e instanceof Error ? e.message : String(e);
}

/// The name an export error gives one layer: its own label, else the source it
/// was cut from, else the id. `lib/layerName.ts`'s ladder minus the rungs no
/// Audio layer reaches — and minus the `t` a module-level helper cannot have,
/// which is why a kind name is never reached here.
///
/// Walks the compositions rather than `forEachLayer`: a layer can be muted or
/// sit on a disabled track and still have a failed bake to report, and the walk
/// skips exactly those.
function audioLayerLabel(summary: ProjectSummary | null, layerId: string): string {
  for (const comp of Object.values(summary?.compositions ?? {})) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.id !== layerId) continue;
        const own = layer.label?.trim();
        if (own) return own;
        return layer.params.kind === "Audio" ? layer.params.media_label : layerId;
      }
    }
  }
  return layerId;
}

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
  const runningRef = useRef(false);
  const pendingFinalization = useRef<ReturnType<typeof createExportFinalization> | null>(null);
  useEffect(() => () => { void pendingFinalization.current?.discard(); }, []);
  // Close-guard: the window ✕ (or any close request) during a running
  // export pops a confirm instead of silently killing the export. The ref
  // mirrors export-busy so the close-requested listener (registered once)
  // reads fresh state.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const exportBusyRef = useRef(false);

  // Close-guard wiring. "Busy" = an export that closing would kill;
  // Completed exports and non-retryable failures do not block the window.
  useEffect(() => {
    exportBusyRef.current =
      exportState !== null &&
      exportState.kind !== "complete" &&
      (exportState.kind !== "error" || !!exportState.onRetry);
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
            body: isResourceCapacityError(state.detail)
              ? t("export.resource_unavailable")
              : t("export.notify_failed_body", { detail: state.detail }),
          });
        }
      } catch {
        // Notifications are a courtesy; never let them surface as errors.
      }
    })();
  }, [exportState, t]);

  // The audio-effect gate, wired once for both export paths (audio-only and
  // full). Everything translated is bound here; the decisions are
  // `runAudioFxGate`'s. `proj` is the summary the export ran its other gates
  // against, so a layer renamed mid-export is still named as the export saw it.
  const audioFxGate = useCallback(
    (
      proj: ProjectSummary | null,
      range: { startUs: number | null; endUs: number | null },
    ): Promise<AudioFxGateOutcome> =>
      runAudioFxGate({
        listen,
        ensure: (r) => ensureExportAudioFx(r),
        range,
        layerName: (id) => audioLayerLabel(proj, id),
        effectName: (kind) => {
          if (kind === null) return null;
          const descriptor = getAudioEffect(kind);
          return descriptor ? t(descriptor.nameI18nKey) : kind;
        },
        failureDetail: ({ effect, layer, message }) =>
          effect === null
            ? t("export.failed_audio_fx_chain", { layer, message })
            : t("export.failed_audio_fx", { effect, layer, message }),
        onWaiting: (labels) => {
          const ctrl = new AbortController();
          setExportState({
            kind: "preparing",
            labels,
            onCancel: () => ctrl.abort(),
          });
          return ctrl.signal;
        },
      }),
    [t],
  );

  // Pixi/WebCodecs export. Three-stage pipeline:
  //
  //   1. Suspend preview, prepare audio and reserve the final mux, then drive
  //      the Worker. Under the native sink the Worker streams raw packed
  //      frames to export_video_sink_write and ffmpeg writes tempVideoPath;
  //      under WebCodecs it streams video-only fMP4 chunks to tempVideoPath.
  //   2. Flush the video encoder and release production resources.
  //   3. Rust stream-copy mux writes the user-chosen path; failures retain both
  //      encoded files and the finalization reservation for an explicit retry.
  //
  // The Worker emits progress on every encoded frame; that maps to
  // the encode phase of ExportPanel. Sink-flush, audio and mux each name
  // themselves as a `finalizing` step — they should be sub-2-second for a
  // typical project, but they are the phases with no sub-progress of their
  // own, so the step is the only liveness signal anything downstream has.
  //
  // Temp files are retained only for a completed encode awaiting mux. Success,
  // explicit discard or closing the editor cleans them; this is a session-local
  // retry, not restart recovery. The close guard includes pending retries.
  const runExportWithSettings = useCallback(
    async (settings: ExportSettings, path: string, range?: { startUs: number; endUs: number }) => {
    // A double click or stale command cannot replace an unfinished export.
    if (runningRef.current || pendingFinalization.current) return;
    runningRef.current = true;
    let cleanup: (() => Promise<void>) | undefined;
    let retained = false;
    const exportController = new AbortController();
    const onCancel = () => exportController.abort();
    // Name the run for the log mirror before any state can transition.
    exportLog.begin({ output: path, codec: settings.codec });
    // Idle preview decoders retain leases. Yield before preparation/encoder
    // admission, and stay suspended through finish, cancellation and mux.
    let restorePreview: (() => void) | undefined;
    try {
    restorePreview = previewRef.current?.suspendForExport();
    // ---- No-material guard -----------------------------------------------
    // A video export with nothing visible to render would emit pure black —
    // reject it as "no video material" instead. (Audio emptiness is judged
    // below via export_project_audio_only's `produced` flag, since a clip's
    // audio stream isn't visible from the project summary.)
    if (settings.includeVideo) {
      // Read the project from Rust, not the event-driven store: the store summary
      // can lag a just-added layer (its autofit `duration_us` arrives a tick
      // later), so a stale `duration_us` of 0 windows the export to [0,0] and
      // false-rejects a present layer. Same hazard the audio-only path below
      // already guards against by reading fresh from Rust.
      const proj = await projectSummary().catch(() => useProjectStore.getState().summary);
      if (proj) {
        const sUs = range?.startUs ?? 0;
        // Export renders the ROOT, whatever composition is open (compositionAnchorStore.ts).
        const eUs = range?.endUs ?? rootCompositionOf(proj).duration_us;
        if (!hasVisibleContent(proj, sUs, eUs)) {
          setExportState({ kind: "error", detail: t("export.no_video_material") });
          return;
        }
      }
    }

    // ---- Audio-only export: skip every video stage -----------------------
    // No decode/proxy gate, motif bake, encode, sink, or mux — just conform the
    // audible layers and write the audio file straight to `path` (.m4a/.mka by
    // the dialog's extension). Video-only is NOT handled here: it keeps the full
    // video pipeline and simply omits the audio mux (settings.audio.include is
    // false), which the existing code below already does.
    if (settings.includeAudio && !settings.includeVideo) {
      const store = useProjectStore.getState();
      // Read the project from Rust directly, not the event-driven store — the
      // stale-`duration_us` hazard the no-material guard above spells out;
      // here it windows the export to [0,0] → empty plan → a false
      // "no audio material".
      const proj = await projectSummary().catch(() => store.summary);
      if (!proj) {
        setExportState({ kind: "error", detail: "No project loaded." });
        return;
      }
      const startUs = range?.startUs ?? 0;
      const endUs = range?.endUs ?? rootCompositionOf(proj).duration_us;
      setExportState({ kind: "starting" });
      const tracker = createConformTracker(listen);
      try {
        await tracker.ready; // listeners first — a fast job must not slip by
        const conformWaiting = await ensureExportAudioConform({ startUs, endUs });
        if (conformWaiting.length > 0) {
          const ctrl = new AbortController();
          setExportState({
            kind: "preparing",
            labels: conformWaiting.map(
              (id) => store.mediaById.get(id)?.label ?? id,
            ),
            onCancel: () => ctrl.abort(),
          });
          await tracker.waitFor(conformWaiting, ctrl.signal);
        }
      } catch (e) {
        if (e instanceof ExportCancelled) {
          setExportState(null);
          return;
        }
        setExportState({
          kind: "error",
          detail: gateFailureDetail(e, (id) =>
            t("export.failed_prepare", { labels: store.mediaById.get(id)?.label ?? id }),
          ),
        });
        return;
      } finally {
        tracker.dispose();
      }
      // The mixer reads a baked sibling wherever a chain is desired, so the
      // conform gate above is only half the audio wait.
      const fx = await audioFxGate(proj, { startUs, endUs });
      if (fx.kind === "cancelled") {
        setExportState(null);
        return;
      }
      if (fx.kind === "error") {
        setExportState({ kind: "error", detail: fx.detail });
        return;
      }
      try {
        setExportState({ kind: "starting" });
        const produced = await exportProjectAudioOnly(
          path,
          {
            codec: settings.audio.codec,
            bitrate: settings.audio.bitrate,
            sampleRate: settings.audio.sampleRate,
            channels: settings.audio.channels,
          },
          { startUs, endUs },
        );
        if (!produced) {
          // No audio layers in range → Rust wrote nothing. Surface it rather
          // than reporting a "complete" export with no file on disk.
          setExportState({
            kind: "error",
            detail: t("export.no_audio_material"),
          });
          return;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] audio-only export failed:", e);
        setExportState({ kind: "error", detail: `Audio export failed: ${msg}` });
        return;
      }
      setExportState({
        kind: "complete",
        payload: { outputPath: path, durationUs: endUs - startUs },
      });
      return;
    }

    // ---- Export-readiness gate -------------------------------------------
    // Confirm every video source the export will decode is ready. Undecodable
    // DirectExport sources are route-corrected here; sources whose proxy is
    // still encoding put the panel into "preparing" and auto-start when ready.
    let decodeRouting: ExportDecodeRouting | null = null;
    {
      const store = useProjectStore.getState();
      const proj = store.summary; // block-scoped; avoids shadowing the later `summary` local
      if (!proj) {
        setExportState({ kind: "error", detail: "No project loaded." });
        return;
      }
      const startUs = range?.startUs ?? 0;
      const endUs = range?.endUs ?? rootCompositionOf(proj).duration_us;
      const referencedIds = referencedVideoMediaIds(proj, startUs, endUs);
      const referencedMedia = [...referencedIds]
        .map((id) => store.mediaById.get(id))
        .filter((m): m is MediaSummary => !!m);

      // ---- Decode-engine resolution (ONCE, frozen for this export) --------
      // Runs BEFORE the readiness gate so native-routed blind-spot media
      // never enter the probe / full-proxy machinery below — they export
      // immediately off their originals. Rationale + rules live in
      // exportDecodeRouting.ts.
      decodeRouting = resolveExportDecodeRouting({
        setting: settings.decodeEngine,
        componentAvailable: useDecodeComponentStore.getState().available,
        bitDepth: compositeBitDepth(settings),
        media: referencedMedia,
      });

      setExportState({ kind: "starting" });
      const prep = await prepareExportMedia(proxyWaitScope(referencedMedia, decodeRouting), {
        probe: (url) => classifyWebcodecsDecodability(url),
        ensureFullProxy: (id) => ensureFullProxy(id),
        proxyStateOf: (id) => proxyStateRef.current.get(id),
        urlForOriginal: (m) => convertFileSrc(m.path),
        memo: decodeProbeMemo.current,
      });

      if (prep.failed.length > 0) {
        const labels = prep.failed
          .map((id) => store.mediaById.get(id)?.label ?? id)
          .join(", ");
        setExportState({
          kind: "error",
          detail: t("export.failed_prepare", { labels }),
        });
        return;
      }

      if (prep.waiting.length > 0) {
        const ctrl = new AbortController();
        const labels = prep.waiting.map(
          (id) => store.mediaById.get(id)?.label ?? id,
        );
        setExportState({
          kind: "preparing",
          labels,
          onCancel: () => ctrl.abort(),
        });
        try {
          await waitForProxies(prep.waiting, {
            pathReady: (id) => {
              const m = useProjectStore.getState().mediaById.get(id);
              return m != null && resolveDecode(m).exportPath != null;
            },
            subscribeStore: (cb) => useProjectStore.subscribe(cb),
            onProxyError: (cb) => {
              // `listen` is async; guard against it resolving after cleanup
              // (which would leak the listener).
              let off: (() => void) | null = null;
              let disposed = false;
              void listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
                if (e.payload.kind === "proxy") cb(e.payload.media_id);
              }).then((u) => {
                if (disposed) u();
                else off = u;
              });
              return () => {
                disposed = true;
                off?.();
              };
            },
            signal: ctrl.signal,
          });
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          setExportState({
            kind: "error",
            detail: gateFailureDetail(e, (id) =>
              t("export.failed_prepare", { labels: store.mediaById.get(id)?.label ?? id }),
            ),
          });
          return;
        }
      }

      // ---- Audio conform gate ---------------------------------------------
      // Every audible Audio layer in range needs its conform PCM — the Rust
      // export mixer reads only conform files (docs/audio.md). Selection +
      // readiness live Rust-side (`ensure_export_audio_conform`, sharing the
      // mix plan's layer walk so gate and plan can't disagree); completion is
      // job-event-tracked because a stale conform_path (cache file deleted)
      // reads identically in the store before and after the re-conform.
      if (settings.audio.include) {
        const tracker = createConformTracker(listen);
        try {
          await tracker.ready; // listeners first — a fast job must not slip by
          const conformWaiting = await ensureExportAudioConform({
            startUs,
            endUs,
          });
          if (conformWaiting.length > 0) {
            const ctrl = new AbortController();
            setExportState({
              kind: "preparing",
              labels: conformWaiting.map(
                (id) => store.mediaById.get(id)?.label ?? id,
              ),
              onCancel: () => ctrl.abort(),
            });
            await tracker.waitFor(conformWaiting, ctrl.signal);
          }
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          setExportState({
            kind: "error",
            detail: gateFailureDetail(e, (id) =>
              t("export.failed_prepare", { labels: store.mediaById.get(id)?.label ?? id }),
            ),
          });
          return;
        } finally {
          tracker.dispose();
        }
        // ---- Audio effect-chain gate --------------------------------------
        // Same two-part wait as the audio-only path: the conform above, then
        // the bakes that read it.
        const fx = await audioFxGate(proj, { startUs, endUs });
        if (fx.kind === "cancelled") {
          setExportState(null);
          return;
        }
        if (fx.kind === "error") {
          setExportState({ kind: "error", detail: fx.detail });
          return;
        }
      }
    }
    // ---- end gate --------------------------------------------------------

    // Allocate unique temp paths up-front so cleanup in `finally`
    // can hit them whether or not the respective stage completed.
    const tempBase = await tempDir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempVideoExt = isIntermediateCodec(settings.codec) ? "mov" : "mp4";
    const tempVideoPath = await join(tempBase, `weftcut-pixi-${stamp}.${tempVideoExt}`);
    const audioExt = settings.audio.codec === "opus" ? "mka" : "m4a";
    const tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.${audioExt}`);
    let releaseFinalization = () => {};
    cleanup = async () => {
      releaseFinalization();
      await Promise.all([tempVideoPath, tempAudioPath].map(file => remove(file).catch(() => {})));
    };

    const summary = useProjectStore.getState().summary!;
    const comp = rootCompositionOf(summary);
    const exportRange = {
      startUs: range?.startUs ?? 0,
      endUs: range?.endUs ?? comp.duration_us,
    };

    // Motif pixels are streamed under the export worker's byte budget.

    const dims = resolveOutputDims(comp, settings);
    const fpsNum = settings.fps != null ? settings.fps : comp.fps_num;
    const fpsDen = settings.fps != null ? 1 : comp.fps_den;
    const outFps = fpsNum / fpsDen;
    // `path` already carries the chosen container extension (set by the dialog).

    // One resolution seam for the encode engine (see docs/render.md §"Encode exits").
    // Probe injected: the smoke-encode only runs when the target needs it —
    // that's only an explicit WebCodecs pin; `auto` always resolves
    // native and this ternary short-circuits to `true` unconsulted. Cast is
    // sound: this branch only runs when needsEncoderProbe(settings) is true,
    // which needsEncoderProbe itself defines as excluding
    // isIntermediateCodec(settings.codec) — so settings.codec here is always
    // a WebCodecsCodecId, never "prores"/"dnxhr".
    const needsProbe = needsEncoderProbe(settings);
    const smokeOk = needsProbe
      ? await smokeEncode(
          settings.codec as WebCodecsCodecId,
          dims.width,
          dims.height,
          outFps,
        )
      : true;
    // A pinned WebCodecs export that fails its own smoke test has no
    // fallback — the pin is explicit user intent, unlike `auto`'s
    // fallback-carrying native-first path (handled below at the native
    // sink-start catch). Fail loudly, before the sink or the export Worker
    // ever starts, instead of letting resolveEncodeTarget silently proceed
    // with an encoder that just proved it can't run.
    if (needsProbe && !smokeOk) {
      setExportState({
        kind: "error",
        detail: t("export_dialog.codec_unsupported", {
          codec: settings.codec.toUpperCase(),
        }),
      });
      return;
    }
    // `let`, not `const`: a native sink-start failure under `auto` can flip
    // this trio to a consent-gated WebCodecs retry below. `sinkTarget`
    // is nulled out alongside the flip so its type (`NativeTarget | null`)
    // stays honest — no consumer below may assert it non-null with `!`;
    // each site re-checks `sinkTarget` (or reads it after the flip settles).
    let target = resolveEncodeTarget(settings, smokeOk);
    let nativeSink = target.engine === "native";
    let sinkTarget = target.engine === "native" ? target : null;

    setExportState({ kind: "preparing", labels: [t("export.plan_resources")], onCancel });
    const resourcePlans = await prepareExportResourcePlans({ summary, media: useProjectStore.getState().mediaById,
      routing: decodeRouting, ...exportRange, bitDepth: compositeBitDepth(settings), nativeEncoder: nativeSink,
      outputWidth: dims.width, outputHeight: dims.height, signal: exportController.signal });
    let audioProduced = false;
    // Finish audio before video production. Once encoding completes, retry
    // needs only immutable files and cannot accidentally mix a newer timeline.
    if (settings.audio.include) {
      setExportState({ kind: "preparing", labels: [t("export.prepare_audio")] });
      audioProduced = await exportProjectAudioOnly(tempAudioPath, {
        codec: settings.audio.codec, bitrate: settings.audio.bitrate,
        sampleRate: settings.audio.sampleRate, channels: settings.audio.channels,
      }, exportRange);
    }

    const finalizationReservation = await admitExportResources(resourcePlans, nativeSink, exportController.signal,
      reason => setExportState({ kind: "preparing", labels: [t(reason === 'host-pressure' || reason === 'pressure' ? "export.wait_memory" : "export.wait_resources")], onCancel }));
    releaseFinalization = finalizationReservation.release;

    // Native-sink path: start the native-encode video sink (ffmpeg, frames
    // streamed over IPC) before the Worker starts. On the WebCodecs path the
    // existing fMP4 streaming path is used.
    if (nativeSink && sinkTarget) {
      try {
        await exportVideoSinkStart({
          finalizationToken: finalizationReservation.token,
          width: dims.width,
          height: dims.height,
          fpsNum,
          fpsDen,
          codec: settings.codec,
          pixFmt: sinkTarget.pixFmt,
          bitrate: computeBitrate(settings, dims.width, dims.height, outFps),
          cbr: settings.rateMode === "cbr",
          // Peak/buffer ride the same *Applies predicates the dialog shows the
          // fields under, so what the encoder receives is exactly what the user
          // could see and edit — an inert-but-persisted value (a VBR peak left
          // behind after switching to CBR) never leaks into the argv.
          ...(maxBitrateApplies(settings) && settings.maxBitrate != null
            ? { maxBitrate: settings.maxBitrate }
            : {}),
          ...(bufferSizeApplies(settings) && settings.bufferSize != null
            ? { bufferSize: settings.bufferSize }
            : {}),
          gop: gopFrames(settings.keyframeIntervalSec, outFps),
          software:
            settings.hwAccel === "software" || settings.rateMode === "quality",
          ...(settings.rateMode === "quality" && !isIntermediateCodec(settings.codec)
            ? { crf: settings.crf ?? defaultCrf(settings.codec) }
            : {}),
          preset: settings.preset,
          ...(settings.codec === "prores" ? { profile: settings.proresProfile } : {}),
          ...(settings.codec === "dnxhr" ? { profile: settings.dnxhrProfile } : {}),
          outputPath: tempVideoPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] video sink start failed:", e);
        // Native encoder unavailable under `auto`, on a combo WebCodecs can
        // actually take (8-bit, non-intermediate): offer an explicit-consent
        // fallback instead of hard-erroring — never a silent encoder swap.
        // Pinned-native / 10-bit / intermediate-codec failures, and a
        // declined dialog, keep the original hard error.
        const canFallBack =
          settings.encoderEngine === "auto" &&
          !isIntermediateCodec(settings.codec) &&
          settings.bitDepth === 8;
        if (
          !isResourceCapacityError(msg) && canFallBack &&
          window.confirm(t("export_dialog.native_unavailable_fallback"))
        ) {
          const fallbackOk = await smokeEncode(
            settings.codec as WebCodecsCodecId,
            dims.width,
            dims.height,
            outFps,
          );
          if (!fallbackOk) {
            setExportState({
              kind: "error",
              detail: t("export_dialog.native_unavailable_no_fallback"),
            });
            return;
          }
          target = {
            engine: "webcodecs",
            workerCodec: settings.codec as WebCodecsCodecId,
          };
          nativeSink = false;
          sinkTarget = null;
        } else {
          setExportState({ kind: "error", detail: `Failed to start the native encoder: ${msg}` });
          return;
        }
      }
    }
    // `target`/`nativeSink` are final past this point (the only reassignment
    // is the fallback retry above) — safe to read `target` while building the
    // worker-facing encoder config below.
    const workerBitrate = computeBitrate(settings, dims.width, dims.height, outFps);
    // Encoder-acceleration hint (WebCodecs path only — the worker IS the
    // final encode there). Present only under the user's software pin:
    // Chromium treats the hint as MANDATORY, so an "auto" prefer-hardware ask
    // hard-errors at configure() wherever no HW encoder exists rather than
    // falling back (encoderHwHint, issue #7 boundary #10).
    const hwHint = encoderHwHint(settings.hwAccel);
    const encoderConfig: VideoEncoderConfig = {
      // codecString only runs on the WebCodecs path, where target.workerCodec
      // is a genuine WebCodecsCodecId. On the native-sink path settings.codec
      // can be a prores/dnxhr intermediate — codecString throws on those — so
      // the field carries an inert "": the Worker never constructs an
      // EncoderSink from this config when nativeSink is set (exportWorker.ts
      // reads only .width/.height there).
      codec: target.engine === "webcodecs" ? codecString(target.workerCodec) : "",
      width: dims.width,
      height: dims.height,
      bitrate: workerBitrate,
      framerate: outFps,
      bitrateMode: settings.rateMode === "cbr" ? "constant" : "variable",
      ...(hwHint ? { hardwareAcceleration: hwHint } : {}),
    };

    const startedAtMs = performance.now();

    const onProgress = (encoded: number, total: number) => {
      if (total <= 0) return;
      const elapsedSec = (performance.now() - startedAtMs) / 1000;
      const fps = elapsedSec > 0 ? encoded / elapsedSec : 0;
      // `encoded * nominal` is exactly the accumulating product frames.ts warns
      // against — fine here because nothing reads it as a grid time: it feeds
      // the progress/speed readout, where lagging ~1 frame per hour of output
      // is invisible.
      const currentTimeUs = encoded * approxFrameDurUs(fpsNum, fpsDen);
      const speed = elapsedSec > 0 ? currentTimeUs / 1e6 / elapsedSec : 0;
      setExportState({
        kind: "progress",
        onCancel,
        progress: {
          progress: encoded / total,
          currentTimeUs,
          frame: encoded,
          fps,
          speed,
        },
      });
    };

    // Stream the worker's output to the temp file: it emits the MP4 in
    // sequential slices (fMP4) which we append here, so the whole file is never
    // held in one ArrayBuffer (V8's ~2GB cap OOM'd long exports). `writeFile`
    // with `append` is used instead of an open FileHandle because the fs bridge
    // exposes append-write but no open-handle API. The temp path is a fresh
    // UUID, so the first append creates it (create defaults true).
    // On the native-sink path the Worker streams raw packed frames via the
    // chunk/ack channel; the main thread forwards them to export_video_sink_write.
    const writeChunk = nativeSink
      ? async (data: ArrayBuffer): Promise<void> => {
          await exportVideoSinkWrite(new Uint8Array(data));
        }
      : async (data: ArrayBuffer): Promise<void> => {
          await writeFile(tempVideoPath, new Uint8Array(data), { append: true });
        };

    onProgress(0, 1);
    let result;
    try {
      result = await previewRef.current?.runPixiExport({
        finalizationToken: finalizationReservation.token,
        resourcePlan: finalizationReservation.plan,
        onProgress,
        encoderConfig,
        outputFps: { num: fpsNum, den: fpsDen },
        startUs: exportRange.startUs,
        endUs: exportRange.endUs,
        keyframeIntervalSec: settings.keyframeIntervalSec,
        writeChunk,
        signal: exportController.signal,
        bitDepth: compositeBitDepth(settings),
        ...(nativeSink && sinkTarget ? { nativeSinkPixFmt: sinkTarget.pixFmt } : {}),
        ...(decodeRouting ? { decodeRouting } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (nativeSink) await exportVideoSinkCancel().catch(() => {});
      if (exportController.signal.aborted) {
        setExportState(null);
        return;
      }
      console.error("[weftcut/pixi] export failed:", e);
      setExportState({ kind: "error", detail: msg });
      return;
    }
    if (!result) {
      if (nativeSink) await exportVideoSinkCancel().catch(() => {});
      setExportState({
        kind: "error",
        detail: "Preview not initialized.",
      });
      return;
    }

    // On the native-sink path, signal the sink that all frames have been
    // sent. The sink flushes its encoder + muxer and writes the final
    // tempVideoPath. Must run BEFORE mux.
    if (nativeSink) {
      setExportState({ kind: "finalizing", step: "sink" });
      try {
        await exportVideoSinkFinish();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] sink finish failed:", e);
        setExportState({ kind: "error", detail: `Finalize failed: ${msg}` });
        return;
      }
    }

    const durationUs = Math.round((result.totalFrames * 1_000_000 * result.fpsDen) / result.fpsNum);
    const cleanupFiles = cleanup;
    const finalization = createExportFinalization({
      mux: () => muxExport(tempVideoPath, tempAudioPath, path, { token: finalizationReservation.token, audioRequired: audioProduced }),
      cleanup: async () => {
        pendingFinalization.current = null;
        await cleanupFiles();
      },
      onRunning: () => setExportState({ kind: "finalizing", step: "mux" }),
      onFailure: detail => setExportState({
        kind: "error", detail: `Finalize failed: ${detail}`,
        onRetry: async () => {
          if (runningRef.current) return;
          runningRef.current = true;
          const restore = previewRef.current?.suspendForExport();
          try { await finalization.retry(); } finally { restore?.(); runningRef.current = false; }
        },
        onDiscard: async () => {
          await finalization.discard();
          setExportState(null);
          setExportDialogOpen(false);
        },
      }),
      onComplete: () => setExportState({ kind: "complete", payload: { outputPath: path, durationUs } }),
    });
    pendingFinalization.current = finalization;
    retained = true;
    await finalization.retry();
    } catch (error) {
      setExportState(exportController.signal.aborted ? null : { kind: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!retained) await cleanup?.();
      restorePreview?.();
      runningRef.current = false;
    }
    },
    [t, audioFxGate, previewRef, proxyStateRef, decodeProbeMemo, exportLog],
  );

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
