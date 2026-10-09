import { convertFileSrc } from "@/bridge/ipc";
import { listen } from "@/bridge/events";
import { open as openDialog } from "@/bridge/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ensureFullProxy,
  IMPORT_EVENTS,
  importMedia,
  importQueueList,
  logEmit,
  MEDIA_JOB_EVENTS,
  type MediaJobEvent,
  type ImportEntry,
  type ProjectSummary,
} from "../ipc";
import { type ProxyState } from "../panels/mediaReadiness";
import {
  classifyWebcodecsDecodability,
} from "../render/decoder/probeSourceDecodable";
import { forgetWebcodecsCapability, markWebcodecsUnusable, resetWebcodecsCapabilitySession } from "../render/decoder/webcodecsCapability";
import {
  type ProbeState,
} from "../render/exportReadiness";
import {
  importOptimizeStatus,
  optimizeReason,
  type OptimizeDeps,
  type OptimizeInfo,
} from "../panels/importOptimize";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { useProjectStore } from "../state/projectStore";
import { PreviewCapabilities } from './previewCapabilities';
import { MEDIA_SOURCE_RELOCATED, type MediaSourceRelocated } from '../../shared/media-source-relocated';
import { forgetFfmpegCapability, resetFfmpegCapabilitySession } from '../render/decoder/ffmpegCapability';
import { resolvePreviewSource, onPreviewResolutionChange } from '../render/decoder/resolvePreviewSource';
import { resolveDecode } from "../render/decodeRoute";
import { onResourceChange, resourcePressure } from "../render/resourceClient";
import { resourceAllocation } from '../../shared/resource-policy';
import { ImportRequestQueue, importRequestWindow } from './importRequestQueue';
import { rendererImportDiagnostics } from '../importDiagnostics';
import { IMPORT_DIAGNOSTIC_TRACK } from '../../shared/import-diagnostics';
import { type MediaReadiness, mediaReadiness } from '../panels/mediaReadiness';

/// Owns the import pipeline + per-media preview readiness: the import queue,
/// the copying/proxy lifecycle maps, the session decodability probe memo, the
/// import-time decodability sweep, and the pool-wide optimization classification
/// the Media Pool badges read. The `proxyStateRef` + `decodeProbeMemo` refs it
/// returns are also consumed by useExportFlow; `summary`/`run`/`previewRef`
/// arrive from App via `deps`.
export function useImportReadiness(deps: {
  summary: ProjectSummary | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
}): {
  importsById: ReadonlyMap<string, ImportEntry>;
  readinessById: ReadonlyMap<string, MediaReadiness>;
  readinessOf: (id: string) => MediaReadiness;
  previewDecodableOf: (id: string) => boolean;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
  optimizeById: ReadonlyMap<string, OptimizeInfo>;
  importMediaFiles: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<void>;
} {
  const { t } = useTranslation();
  const { summary, run, previewRef } = deps;

  const [importQueue, setImportQueue] = useState<ImportEntry[]>([]);
  const [diagnosticTick, setDiagnosticTick] = useState(0);
  const importEpoch = useRef(0);
  const [importRequests] = useState(() => new ImportRequestQueue(importMedia,
    () => resourcePressure() ? 0 : importRequestWindow(resourceAllocation())));
  useEffect(() => onResourceChange(importRequests.refresh), [importRequests]);
  useEffect(() => () => { importEpoch.current++; importRequests.refresh(); }, [summary?.project_id, importRequests]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Also ends queued selections on same-project reopen and Save As. Correctness must
    // not depend on optional diagnostic delivery.
    void listen('project:workspace-changing', () => { importEpoch.current++; importRequests.refresh(); })
      .then(un => { if (disposed) un(); else unlisten = un; });
    return () => { disposed = true; unlisten?.(); };
  }, [importRequests]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Parameters<typeof rendererImportDiagnostics.track>[0]>(IMPORT_DIAGNOSTIC_TRACK, e => {
      rendererImportDiagnostics.track(e.payload);
      setDiagnosticTick(n => n + 1);
    }).then(un => { if (disposed) un(); else unlisten = un; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); rendererImportDiagnostics.track({ reset: true }); };
  }, []);

  // Import queue subscription (docs/data-model.md § `MediaItem`). The
  // background-copy worker pushes a fresh history list on every state
  // change. MediaPool reads the in-flight set out of this so pool items
  // can show a "Copying…" badge while their bytes are being moved into
  // `<workspace>/Media/`.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let streamed = false;
    importQueueList().then(entries => { if (!cancelled && !streamed) setImportQueue(entries); }).catch(() => {});
    (async () => {
      const u = await listen<ImportEntry[]>(IMPORT_EVENTS.queue, (e) => {
        streamed = true;
        setImportQueue(e.payload);
      });
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const importsById = useMemo(() => new Map(importQueue.map(entry => [entry.media_id, entry])), [importQueue]);
  // Per-video proxy lifecycle for the current session. Filled by the
  // `media:job_*` listener below (proxy / quick_proxy / proxy_bypass)
  // and consulted by
  // `mediaReadiness` to decide whether a video clip is usable on the
  // timeline. `MediaSummary.decode_route` from the next summary refresh is
  // the durable source of truth; this map is the fast, session-scoped
  // reflection so the UI flips the moment the event fires instead of
  // waiting on the project:changed round-trip.
  const [proxyState, setProxyState] = useState<Map<string, ProxyState>>(
    () => new Map(),
  );

  // Per-media preview-readiness job tracking — proxy / quick_proxy /
  // proxy_bypass only. We do NOT gate the UI on thumbnails / waveform;
  // those are decorations.
  // The listener owns transitions started → pending, complete → ready,
  // error → failed.
  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const set = (id: string, s: ProxyState) =>
        setProxyState((prev) => {
          const next = new Map(prev);
          next.set(id, s);
          return next;
        });
      const [onStarted, onComplete, onError] = await Promise.all([
        listen<MediaJobEvent>(MEDIA_JOB_EVENTS.started, (e) => {
          if (
            e.payload.kind === "proxy" ||
            e.payload.kind === "quick_proxy" ||
            e.payload.kind === "proxy_bypass"
          ) {
            set(e.payload.media_id, "pending");
          }
        }),
        listen<MediaJobEvent>(MEDIA_JOB_EVENTS.complete, (e) => {
          if (
            e.payload.kind === "proxy" ||
            e.payload.kind === "quick_proxy" ||
            e.payload.kind === "proxy_bypass"
          ) {
            set(e.payload.media_id, "ready");
          }
        }),
        listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
          if (
            e.payload.kind === "proxy" ||
            e.payload.kind === "quick_proxy" ||
            e.payload.kind === "proxy_bypass"
          ) {
            set(e.payload.media_id, "failed");
          }
        }),
      ]);
      if (cancelled) {
        onStarted();
        onComplete();
        onError();
        return;
      }
      unlisteners = [onStarted, onComplete, onError];
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Session decodability probe memo, shared by the import-time sweep and the
  // export-readiness gate. id → "ok" (decoded a key frame this session) /
  // "pending" (probe in flight). A decodable DirectExport source keeps its
  // direct-export route forever, so this memo is what stops re-probing it.
  const decodeProbeMemo = useRef<Map<string, ProbeState>>(new Map());
  // Fast mirror of proxyState for use inside callbacks (stale-closure-proof).
  const proxyStateRef = useRef(proxyState);
  useEffect(() => {
    proxyStateRef.current = proxyState;
  }, [proxyState]);
  // Ids the sweep route-corrected (machine can't decode) — drives the import
  // dialog's "本机无法直接解码" reason vs the static "格式/10-bit" reasons.
  const routeCorrected = useRef<Set<string>>(new Set());
  // Bumped whenever the sweep mutates decodeProbeMemo/routeCorrected (refs, so
  // they don't re-render on their own) to force the dialog to reclassify.
  const [sweepTick, setSweepTick] = useState(0);
  const notifiedFailureIds = useRef<Set<string>>(new Set());
  const [capabilities] = useState(() => new PreviewCapabilities({
    memo: decodeProbeMemo.current,
    available: () => !resourcePressure(),
    probe: (media, signal) => classifyWebcodecsDecodability(convertFileSrc(media.path), 2500, signal,
      resolvePreviewSource(media, false).status === 'pending'),
    forget: id => {
      routeCorrected.current.delete(id);
      notifiedFailureIds.current.delete(id);
      forgetWebcodecsCapability(id);
      forgetFfmpegCapability(id);
    },
    verdict: (media, verdict) => {
      if (verdict !== 'unsupported') return;
      markWebcodecsUnusable(media.id, 'webcodecs cannot decode original');
      if (resolveDecode(media).route === 'direct-export') {
        routeCorrected.current.add(media.id);
        void ensureFullProxy(media.id).catch(error => console.error('[weftcut] route correction failed', error));
      }
    },
    changed: () => { setSweepTick(n => n + 1); previewRef.current?.refreshSources(); },
  }));
  useEffect(() => {
    capabilities.clear();
    routeCorrected.current.clear();
    notifiedFailureIds.current.clear();
    resetWebcodecsCapabilitySession();
    resetFfmpegCapabilitySession();
    setProxyState(new Map());
    setImportQueue([]);
    return () => capabilities.clear();
  }, [summary?.project_id, capabilities]);
  useEffect(() => {
    capabilities.update(useProjectStore.getState().mediaById);
    setSweepTick(n => n + 1);
  }, [summary, capabilities]);
  useEffect(() => onResourceChange(capabilities.refresh), [capabilities]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<MediaSourceRelocated>(MEDIA_SOURCE_RELOCATED, e => capabilities.relocate(e.payload))
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, [capabilities]);
  useEffect(() => onPreviewResolutionChange(() => {
    setSweepTick(n => n + 1);
    previewRef.current?.refreshSources();
  }), [previewRef]);
  const previewDecodableOf = useCallback((id: string) => {
    const media = useProjectStore.getState().mediaById.get(id);
    return !!media && capabilities.decoded(media);
  }, [capabilities]);
  const readinessOf = useCallback((id: string): MediaReadiness => {
    const media = useProjectStore.getState().mediaById.get(id);
    return media ? mediaReadiness(media, media.kind === 'Video'
      ? resolvePreviewSource(media, capabilities.decoded(media)) : undefined) : { ready: false, reason: 'missing' };
  }, [capabilities]);
  const readinessById = useMemo(() => new Map(
    [...useProjectStore.getState().mediaById.keys()].map(id => [id, readinessOf(id)]),
  ), [summary, sweepTick, readinessOf]);
  useEffect(() => {
    for (const [id, readiness] of readinessById) {
      rendererImportDiagnostics.report(id, 'pool_observed');
      if (readiness.ready) rendererImportDiagnostics.report(id, 'editable');
    }
  }, [readinessById, diagnosticTick]);

  // Deps recreated each render; they read `.current` refs so they're always
  // live. `sweepTick` is what forces re-eval when only a ref changed.
  const optimizeDeps: OptimizeDeps = {
    memo: decodeProbeMemo.current,
    proxyStateOf: (id) => proxyStateRef.current.get(id),
    routeCorrected: routeCorrected.current,
  };

  // Live optimization verdict for EVERY pool entry — the Media Pool badges are
  // per-media and describe the clip's current state, so they must not be scoped
  // to "imported this session". Classification is a handful of map lookups per
  // clip, so a whole-pool pass every summary/proxy change is free.
  //
  // Computed here rather than in MediaPool because two of the three inputs
  // (`decodeProbeMemo`, `routeCorrected`) are refs: handing them across the
  // panel contract would leave MediaPool with no signal for when to recompute,
  // and its badges would silently go stale the moment a probe resolved.
  const optimizeById = useMemo<ReadonlyMap<string, OptimizeInfo>>(() => {
    const store = useProjectStore.getState();
    const out = new Map<string, OptimizeInfo>();
    for (const m of store.mediaById.values()) {
      out.set(m.id, {
        status: importOptimizeStatus(m, optimizeDeps),
        reason: optimizeReason(m, optimizeDeps),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, proxyState, sweepTick]);

  // Proxy failure is the one optimization outcome that needs the user to act
  // (re-import), so it cannot rely on the pool being on screen — the Media
  // Pool can sit behind another dock tab. Everything else stays silent and
  // lives only on the card.
  useEffect(() => {
    for (const [id, info] of optimizeById) {
      if (info.status !== "failed") continue;
      if (notifiedFailureIds.current.has(id)) continue;
      notifiedFailureIds.current.add(id);
      const label = useProjectStore.getState().mediaById.get(id)?.label ?? id;
      void logEmit({
        level: "error",
        category: { kind: "Import" },
        source: { kind: "System" },
        message: t("import_proxy.failed_log", { label }),
        details: { media_id: id },
      }).catch(() => {
        // The LogBus does not exist before a workspace opens. Un-mark so the
        // next classification pass retries rather than losing the report.
        notifiedFailureIds.current.delete(id);
      });
    }
  }, [optimizeById, t]);

  // Shared tail of every import entry point (file picker, media-pool
  // file drop): feed absolute paths into the import pipeline.
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const epoch = importEpoch.current;
      await run(() => importRequests.enqueue(paths, () => epoch === importEpoch.current));
    },
    [run, importRequests],
  );

  const importMediaFiles = useCallback(async () => {
    const picked = await openDialog({
      title: t("dialogs.import_title"),
      multiple: true,
      filters: [
        {
          name: t("dialogs.media_filter"),
          // Mirrors the backend's extension fallback (io/probe.rs detect_kind)
          // EXCEPT tif/tiff, avif and apng. TIFF: Electron/Chromium's
          // createImageBitmap can't decode it, so offering it would import a
          // layer that composites nothing. APNG: those files carry the `.png`
          // extension, already listed. AVIF: not offered by the picker; it
          // still imports through drag-drop / MCP.
          extensions: [
            "mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "m2v",
            "wav", "mp3", "flac", "aac", "m4a", "ogg", "opus",
            "png", "jpg", "jpeg", "gif", "webp", "bmp",
            "srt", "ass", "vtt",
          ],
        },
      ],
    });
    const paths = Array.isArray(picked)
      ? picked
      : typeof picked === "string"
        ? [picked]
        : [];
    await importPaths(paths);
  }, [importPaths, t]);

  // Media-pool drag-to-import: the preload bridge recovers real filesystem
  // paths from HTML5 file drops (webUtils.getPathForFile → media:dropped) and
  // emits them here — same pipeline as the picker from this point on.
  useEffect(() => {
    const un = listen<string[]>("media:external-drop", (e) => {
      void importPaths(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [importPaths]);

  return {
    importsById,
    readinessById,
    readinessOf,
    previewDecodableOf,
    proxyStateRef,
    decodeProbeMemo,
    optimizeById,
    importMediaFiles,
    importPaths,
  };
}
