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
  type WebcodecsDecodeVerdict,
} from "../render/decoder/probeSourceDecodable";
import { forgetWebcodecsCapability, isWebcodecsUnusable, markWebcodecsUnusable, resetWebcodecsCapabilitySession } from "../render/decoder/webcodecsCapability";
import {
  sourcesNeedingPreviewProbe,
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
import { resolveDecode } from "../render/decodeRoute";
import { backgroundResourcesAvailable, onResourceChange } from "../render/resourceClient";
import { rendererImportDiagnostics } from '../importDiagnostics';
import { IMPORT_DIAGNOSTIC_TRACK } from '../../shared/import-diagnostics';
import { mediaReadiness } from '../panels/mediaReadiness';

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
  importingMediaIds: Set<string>;
  proxyState: Map<string, ProxyState>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
  previewDecodableMediaIds: Set<string>;
  optimizeById: ReadonlyMap<string, OptimizeInfo>;
  importMediaFiles: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<void>;
} {
  const { t } = useTranslation();
  const { summary, run, previewRef } = deps;

  const [importQueue, setImportQueue] = useState<ImportEntry[]>([]);
  const [diagnosticTick, setDiagnosticTick] = useState(0);
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
    importQueueList().then(setImportQueue).catch(() => {});
    (async () => {
      const u = await listen<ImportEntry[]>(IMPORT_EVENTS.queue, (e) => {
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

  // In-flight = Pending/Copying only. Once an entry moves past those
  // (Completed/Failed/Cancelled) its path_abs has either landed or never
  // will, so a copying badge would lie.
  const importingMediaIds = useMemo(() => {
    const set = new Set<string>();
    for (const entry of importQueue) {
      if (entry.status.kind === "Pending" || entry.status.kind === "Copying") {
        set.add(entry.media_id);
      }
    }
    return set;
  }, [importQueue]);
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
  const previewDecodableMediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, state] of decodeProbeMemo.current) {
      if (state === "ok") ids.add(id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepTick]);
  useEffect(() => {
    for (const media of useProjectStore.getState().mediaById.values()) {
      rendererImportDiagnostics.report(media.id, 'pool_observed');
      if (mediaReadiness(media, importingMediaIds, proxyState, { previewDecodable: previewDecodableMediaIds.has(media.id) }).ready) {
        rendererImportDiagnostics.report(media.id, 'editable');
      }
    }
  }, [summary, importingMediaIds, proxyState, previewDecodableMediaIds, diagnosticTick]);
  // Media_ids whose proxy failure already reached the status log. A failure is
  // reported once per media per session; the pool badge carries the durable
  // truth, so re-emitting on every re-render would only flood the log.
  const notifiedFailureIds = useRef<Set<string>>(new Set());
  const probeIdentities = useRef(new Map<string, string>());

  const [resourceTick, setResourceTick] = useState(0);
  useEffect(() => {
    let available = backgroundResourcesAvailable();
    return onResourceChange(() => {
      const next = backgroundResourcesAvailable();
      // Telemetry publishes repeatedly even when availability is unchanged.
      // Restarting on every sample would continually abort a slow decoder.
      if (next !== available) { available = next; setResourceTick((n) => n + 1); }
    });
  }, []);
  useEffect(() => {
    decodeProbeMemo.current.clear();
    routeCorrected.current.clear();
    notifiedFailureIds.current.clear();
    resetWebcodecsCapabilitySession();
    setProxyState(new Map());
    setSweepTick((n) => n + 1);
  }, [summary?.project_id]);

  // Probe non-bypass originals independently of proxy readiness. Successful and
  // unsupported verdicts settle this session; unknown results remain retryable.
  // Only unsupported DirectExport originals need route correction to a full
  // proxy. Sequential to avoid competing with preview decoders. Reads
  // the fresh Zustand pool; re-runs when `summary` changes (every project:changed).
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let pendingId: string | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryNeeded = false;
    const memo = decodeProbeMemo.current;
    const live = useProjectStore.getState().mediaById;
    for (const [id, identity] of probeIdentities.current) {
      const media = live.get(id);
      if (!media || identity !== `${media.path}:${media.size_bytes}`) {
        memo.delete(id);
        routeCorrected.current.delete(id);
        notifiedFailureIds.current.delete(id);
        forgetWebcodecsCapability(id);
      }
    }
    probeIdentities.current = new Map([...live].map(([id, media]) => [id, `${media.path}:${media.size_bytes}`]));
    for (const id of routeCorrected.current) if (!live.has(id)) routeCorrected.current.delete(id);
    for (const id of notifiedFailureIds.current) if (!live.has(id)) notifiedFailureIds.current.delete(id);
    void (async () => {
      const pool = useProjectStore.getState().mediaById;
      const candidates = sourcesNeedingPreviewProbe(pool).filter(
        (m) =>
          m.available &&
          memo.get(m.id) !== "ok" &&
          memo.get(m.id) !== "pending" &&
          !isWebcodecsUnusable(m.id),
      );
      for (const m of candidates) {
        if (cancelled) return;
        pendingId = m.id;
        memo.set(m.id, "pending");
        let verdict: WebcodecsDecodeVerdict = "unknown";
        try {
          verdict = await classifyWebcodecsDecodability(convertFileSrc(m.path), 2500, abort.signal);
        } catch {
          verdict = "unknown";
        }
        if (cancelled) return;
        pendingId = undefined;
        if (verdict === "unknown") retryNeeded = true;
        const ok = verdict === "ok";
        // DEFINITIVE WebCodecs-unsupported original (no codec mapping /
        // isConfigSupported declines both lanes — NOT a transient stall): sticky-
        // mark it so a pinned-Lite (webcodecs) resolve reaches
        // status:"unsupported" (surfacing UnsupportedClipCard) instead of hanging
        // on "pending" forever. Only "unsupported" is marked — a flaky/deadline
        // "unknown" must never condemn a decodable source. Mirrors the ffmpeg/HW
        // markers (ffmpegCapability.ts).
        if (verdict === "unsupported") {
          markWebcodecsUnusable(m.id, "webcodecs cannot decode original");
        }
        // Cleanup removes this effect's pending memo before the next sweep;
        // cancelled probes must never publish a result into another project.
        if (ok) {
          memo.set(m.id, "ok");
          // A paused clip already on the timeline won't re-run ensureClip on its
          // own; nudge the compositor to re-run ENGINE resolution now that this
          // source's WebCodecs-original probe (tier 2) reads "ok" — the resolver
          // can promote it from the proxy to decoding the original.
          previewRef.current?.refreshSources();
        } else {
          memo.delete(m.id);
          // A freshly-marked-unsupported original: nudge a re-composite now so
          // the UnsupportedClipCard surfaces immediately when pinned to Lite,
          // rather than staying blank/pending until the next seek. (The "ok"
          // branch above nudges for the promote-to-original case; this nudges
          // for the newly-unsupported case.)
          if (verdict === "unsupported") previewRef.current?.refreshSources();
          // Only DirectExport sources need route-correction (they were
          // pointing export at an original this machine can't decode). A
          // full-proxy source that fails the probe already routes correctly;
          // it just gets no bridge — preview waits for its proxy as before.
          // "unsupported" ONLY: like the sticky mark above, a transient
          // "unknown" (probe deadline on a loaded machine) must not demote a
          // decodable source onto a lossy proxy — it stays direct and the
          // next sweep re-probes it.
          if (verdict === "unsupported" && resolveDecode(m).route === "direct-export") {
            routeCorrected.current.add(m.id);
            try {
              await ensureFullProxy(m.id);
            } catch (e) {
              console.error("[weftcut] route-correct failed for", m.id, e);
            }
          }
        }
        // Force the import dialog to reclassify: memo/routeCorrected are refs
        // and the decodable ("ok") branch fires no store event, so without this
        // a now-decodable clip would stay stuck on "checking" in the dialog.
        setSweepTick((x) => x + 1);
      }
      if (!cancelled && retryNeeded) {
        retry = setTimeout(() => setResourceTick((n) => n + 1), 5000);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      abort.abort();
      if (pendingId && memo.get(pendingId) === "pending") memo.delete(pendingId);
    };
  }, [summary, previewRef, resourceTick]);

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
      await run(async () => {
        for (const p of paths) {
          await importMedia(p);
        }
      });
    },
    [run],
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
    importingMediaIds,
    proxyState,
    proxyStateRef,
    decodeProbeMemo,
    previewDecodableMediaIds,
    optimizeById,
    importMediaFiles,
    importPaths,
  };
}
