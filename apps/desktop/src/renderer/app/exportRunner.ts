import { listen } from "@/bridge/events";
import { remove, writeFile } from "@/bridge/fs";
import { convertFileSrc } from "@/bridge/ipc";
import { getAudioEffect } from "../../shared/audioEffects/catalog";
import { isResourceCapacityError } from "../../shared/resource-policy";
import { approxFrameDurUs } from "../frames";
import {
  ensureExportAudioConform,
  ensureExportAudioFx,
  ensureFullProxy,
  exportProjectAudioOnly,
  exportVideoSinkCancel,
  exportVideoSinkFinish,
  exportVideoSinkStart,
  exportVideoSinkWrite,
  MEDIA_JOB_EVENTS,
  muxExport,
  projectSummary,
  type MediaJobEvent,
  type MediaSummary,
  type ProjectSummary,
} from "../ipc";
import { type ExportState } from "../panels/ExportPanel";
import { type ProxyState } from "../panels/mediaReadiness";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { hasVisibleContent, referencedVideoMediaIds } from "../render/activeVideoLayers";
import { classifyWebcodecsDecodability } from "../render/decoder/probeSourceDecodable";
import { resolveDecode } from "../render/decodeRoute";
import { needsEncoderProbe, resolveEncodeTarget } from "../render/encodeTarget";
import { smokeEncode } from "../render/exportCodecProbe";
import {
  proxyWaitScope,
  resolveExportDecodeRouting,
  type ExportDecodeRouting,
} from "../render/exportDecodeRouting";
import { createExportFinalization } from "../render/exportFinalization";
import {
  createConformTracker,
  ExportCancelled,
  ExportProxyFailed,
  prepareExportMedia,
  runAudioFxGate,
  waitForProxies,
  type AudioFxGateOutcome,
  type ProbeState,
} from "../render/exportReadiness";
import { prepareExportResourcePlans } from '../render/exportResourcePlan';
import {
  bufferSizeApplies,
  codecString,
  compositeBitDepth,
  computeBitrate,
  defaultCrf,
  encoderHwHint,
  gopFrames,
  isIntermediateCodec,
  maxBitrateApplies,
  resolveOutputDims,
  type WebCodecsCodecId
} from "../render/exportSettings";
import { admitExportResources } from "../render/resourceClient";
import { useDecodeComponentStore } from "../settings/decodeComponentStore";
import { rootCompositionOf, useProjectStore } from "../state/projectStore";

import type { TFunction } from 'i18next';
import type { ExportRun } from '../../shared/exportJob';
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


export function createExportRunner(deps: {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
  t: TFunction;
  onState: (state: ExportState | null) => void;
  cancel: () => void;
  publish: () => Promise<string>;
}) {
  const { previewRef, proxyStateRef, decodeProbeMemo, t } = deps;
  const runningRef = { current: false };
  const pendingFinalization = { current: null as ReturnType<typeof createExportFinalization> | null };
  let state: ExportState | null = null;
  let exportController = new AbortController();
  const setExportState = (next: ExportState | null) => { state = next; deps.onState(next); };
  async function finalize(mux: () => Promise<void>, cleanup: () => Promise<void>, durationUs: number) {
    let muxed = false;
    let actual = '';
    const finalization = createExportFinalization({
      mux: async () => { if (!muxed) { await mux(); muxed = true; } actual = await deps.publish(); },
      cleanup: async () => { await cleanup(); pendingFinalization.current = null; },
      onRunning: () => setExportState({ kind: 'finalizing', step: 'mux', onCancel: deps.cancel }),
      onFailure: detail => setExportState({ kind: 'error', detail, onRetry: async () => { await finalization.retry(); }, onDiscard: async () => { await finalization.discard(); setExportState(null); } }),
      onComplete: () => setExportState({ kind: 'complete', payload: { outputPath: actual, durationUs } }),
    });
    pendingFinalization.current = finalization;
    await finalization.retry();
  }
  const audioFxGate =
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
          const ctrl = exportController;
          setExportState({
            kind: "preparing",
            labels,
            onCancel: deps.cancel,
          });
          return ctrl.signal;
        },
      });


  /// Confirms every video source a render of [startUs, endUs) decodes is
  /// ready: resolves the decode routing once (Decode-engine resolution runs
  /// BEFORE the readiness gate so native-routed blind-spot media never enter
  /// the probe / full-proxy machinery — they export straight off their
  /// originals; rules in exportDecodeRouting.ts), then waits for any proxy
  /// still encoding. `detail: null` is a cancel.
  async function videoGate(
    proj: ProjectSummary, startUs: number, endUs: number, settings: ExportRun["settings"],
    signal: AbortSignal, onWaiting: (labels: string[]) => void,
  ): Promise<{ ok: true; decodeRouting: ExportDecodeRouting } | { ok: false; detail: string | null }> {
    const store = useProjectStore.getState();
    const referencedMedia = [...referencedVideoMediaIds(proj, startUs, endUs)]
      .map((id) => store.mediaById.get(id))
      .filter((m): m is MediaSummary => !!m);
    const decodeRouting = resolveExportDecodeRouting({
      setting: settings.decodeEngine,
      componentAvailable: useDecodeComponentStore.getState().available,
      bitDepth: compositeBitDepth(settings),
      media: referencedMedia,
    });
    const prep = await prepareExportMedia(proxyWaitScope(referencedMedia, decodeRouting), {
      probe: (url) => classifyWebcodecsDecodability(url),
      ensureFullProxy: (id) => ensureFullProxy(id),
      proxyStateOf: (id) => proxyStateRef.current.get(id),
      urlForOriginal: (m) => convertFileSrc(m.path),
      memo: decodeProbeMemo.current,
    });
    if (prep.failed.length > 0) {
      const labels = prep.failed.map((id) => store.mediaById.get(id)?.label ?? id).join(", ");
      return { ok: false, detail: t("export.failed_prepare", { labels }) };
    }
    if (prep.waiting.length > 0) {
      onWaiting(prep.waiting.map((id) => store.mediaById.get(id)?.label ?? id));
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
          signal,
        });
      } catch (e) {
        if (e instanceof ExportCancelled) return { ok: false, detail: null };
        return { ok: false, detail: gateFailureDetail(e, (id) => t("export.failed_prepare", { labels: store.mediaById.get(id)?.label ?? id })) };
      }
    }
    return { ok: true, decodeRouting };
  }

  /// `render_frames`: the composition at each time, rendered by the export
  /// pipeline (same decode routing, Motif frames and compositor) and handed
  /// back as JPEGs instead of encoded. One frame-long range per time. Never
  /// alongside an export, and invisible to the export panel.
  async function runStills(
    request: { times_us: number[]; width: number; settings: ExportRun["settings"] },
    signal: AbortSignal,
  ): Promise<Array<{ t_us: number; width: number; height: number; jpeg: ArrayBuffer }>> {
    if (runningRef.current || pendingFinalization.current) throw new Error("an export is running; render frames after it finishes");
    runningRef.current = true;
    const restorePreview = previewRef.current?.suspendForExport();
    try {
      const summary = await projectSummary().catch(() => useProjectStore.getState().summary);
      if (!summary) throw new Error("No project loaded.");
      const comp = rootCompositionOf(summary);
      const frameUs = Math.ceil((1_000_000 * comp.fps_den) / comp.fps_num);
      const times = [...new Set(request.times_us.map((t) => Math.max(0, Math.min(Math.round(t), Math.max(0, comp.duration_us - frameUs)))))].sort((a, b) => a - b);
      if (!times.length) return [];
      const gate = await videoGate(summary, times[0]!, times.at(-1)! + frameUs, request.settings, signal, () => { });
      if (!gate.ok) throw new Error(gate.detail ?? "render cancelled");
      const out: Array<{ t_us: number; width: number; height: number; jpeg: ArrayBuffer }> = [];
      for (const t of times) {
        if (signal.aborted) throw new Error("render cancelled");
        const range = { startUs: t, endUs: t + frameUs };
        const plans = await prepareExportResourcePlans({
          summary, media: useProjectStore.getState().mediaById, routing: gate.decodeRouting, ...range,
          bitDepth: 8, nativeEncoder: false, outputWidth: comp.width, outputHeight: comp.height, signal,
        });
        const reservation = await admitExportResources(plans, false, signal, () => { });
        try {
          let got: { width: number; height: number; jpeg: ArrayBuffer } | null = null;
          await previewRef.current?.runPixiExport({
            finalizationToken: reservation.token,
            resourcePlan: reservation.plan,
            encoderConfig: { codec: "", width: comp.width, height: comp.height, bitrate: 1, framerate: comp.fps_num / comp.fps_den },
            outputFps: { num: comp.fps_num, den: comp.fps_den },
            ...range,
            writeChunk: async () => { },
            signal,
            bitDepth: 8,
            decodeRouting: gate.decodeRouting,
            stills: { width: request.width },
            onStill: (s) => { if (!got) got = { width: s.width, height: s.height, jpeg: s.jpeg }; },
          });
          if (!got) throw new Error(`no frame rendered at ${t} µs`);
          out.push({ t_us: t, ...(got as { width: number; height: number; jpeg: ArrayBuffer }) });
        } finally {
          reservation.release();
        }
      }
      return out;
    } finally {
      restorePreview?.();
      runningRef.current = false;
    }
  }

  async function run(request: ExportRun, controller: AbortController) {
    const { settings, range, agent, staging_path: path } = request;
    // A double click or stale command cannot replace an unfinished export.
    if (runningRef.current || pendingFinalization.current) return;
    runningRef.current = true;
    let cleanup: (() => Promise<void>) | undefined;
    let retained = false;
    exportController = controller;
    const onCancel = deps.cancel;
    // Name the run for the log mirror before any state can transition.

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
            const ctrl = exportController;
            setExportState({
              kind: "preparing",
              labels: conformWaiting.map(
                (id) => store.mediaById.get(id)?.label ?? id,
              ),
              onCancel: deps.cancel,
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
        retained = true;
        await finalize(async () => { }, async () => { }, endUs - startUs);
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
        // ---- Decode-engine resolution + proxy readiness ---------------------
        // Shared with stills (`videoGate`), so `render_frames` decodes exactly
        // as this export will.
        setExportState({ kind: "starting" });
        const gate = await videoGate(proj, startUs, endUs, settings, exportController.signal, (labels) =>
          setExportState({ kind: "preparing", labels, onCancel: deps.cancel }));
        if (!gate.ok) {
          setExportState(gate.detail === null ? null : { kind: "error", detail: gate.detail });
          return;
        }
        decodeRouting = gate.decodeRouting;

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
              const ctrl = exportController;
              setExportState({
                kind: "preparing",
                labels: conformWaiting.map(
                  (id) => store.mediaById.get(id)?.label ?? id,
                ),
                onCancel: deps.cancel,
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
      const tempVideoPath = request.encoded_video_path;
      const tempAudioPath = request.encoded_audio_path;
      let releaseFinalization = () => { };
      cleanup = async () => {
        releaseFinalization();
        await Promise.all([tempVideoPath, tempAudioPath].map(file => remove(file).catch(() => { })));
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

      setExportState({ kind: "preparing", labels: [t("export.plan_resources")], message: t("export.plan_resources"), onCancel });
      const resourcePlans = await prepareExportResourcePlans({
        summary, media: useProjectStore.getState().mediaById,
        routing: decodeRouting, ...exportRange, bitDepth: compositeBitDepth(settings), nativeEncoder: nativeSink,
        outputWidth: dims.width, outputHeight: dims.height, signal: exportController.signal
      });
      let audioProduced = false;
      // Finish audio before video production. Once encoding completes, retry
      // needs only immutable files and cannot accidentally mix a newer timeline.
      if (settings.audio.include) {
        setExportState({ kind: "preparing", labels: [t("export.prepare_audio")], message: t("export.finalize_audio") });
        audioProduced = await exportProjectAudioOnly(tempAudioPath, {
          codec: settings.audio.codec, bitrate: settings.audio.bitrate,
          sampleRate: settings.audio.sampleRate, channels: settings.audio.channels,
        }, exportRange);
      }

      const finalizationReservation = await admitExportResources(resourcePlans, nativeSink, exportController.signal,
        reason => {
          const message = t(reason === 'host-pressure' || reason === 'pressure' ? "export.wait_memory" : "export.wait_resources");
          setExportState({ kind: "preparing", labels: [message], message, onCancel });
        });
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
            !agent && settings.rateMode !== "quality" && settings.encoderEngine === "auto" &&
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
        if (nativeSink) await exportVideoSinkCancel().catch(() => { });
        if (exportController.signal.aborted) {
          setExportState(null);
          return;
        }
        console.error("[weftcut/pixi] export failed:", e);
        setExportState({ kind: "error", detail: msg });
        return;
      }
      if (!result) {
        if (nativeSink) await exportVideoSinkCancel().catch(() => { });
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
      retained = true;
      await finalize(() => muxExport(tempVideoPath, tempAudioPath, path, { token: finalizationReservation.token, audioRequired: audioProduced, stagingOutput: true }), cleanup, durationUs);
    } catch (error) {
      setExportState(exportController.signal.aborted ? null : { kind: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!retained) await cleanup?.();
      restorePreview?.();
      runningRef.current = false;
    }

  }
  return {
    run,
    runStills,
    state: () => state,
    retry: async () => { await pendingFinalization.current?.retry(); },
    discard: async () => { await pendingFinalization.current?.discard(); setExportState(null); },
  };
}
