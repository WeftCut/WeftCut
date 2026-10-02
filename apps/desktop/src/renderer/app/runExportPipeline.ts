import { convertFileSrc } from "@/bridge/ipc";
import { listen } from "@/bridge/events";
import { join, tempDir } from "@/bridge/path";
import { remove, writeFile } from "@/bridge/fs";
import type { RefObject, MutableRefObject } from "react";
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

export type ExportOutcome =
  | { state: "completed"; outputPath: string; durationUs: number }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

export interface ExportPipelineDeps {
  previewRef: RefObject<PreviewSurfaceHandle | null>;
  proxyStateRef: MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: MutableRefObject<Map<string, ProbeState>>;
  signal: AbortSignal;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onState: (state: ExportState) => void;
  /// UI only. Agent exports omit this and fail rather than open a modal.
  confirmFallback?: (message: string) => boolean | Promise<boolean>;
}

/// Shared video/audio pipeline. Main owns admission and output publication.
/// Every exit cleans scratch files, including worker and finalize failures.
export async function runExportPipeline(
  settings: ExportSettings,
  path: string,
  range: { startUs: number; endUs: number } | undefined,
  deps: ExportPipelineDeps,
): Promise<ExportOutcome> {
  const { previewRef, proxyStateRef, decodeProbeMemo, signal, t } = deps;
  let tempVideoPath = "";
  let tempAudioPath = "";
  let nativeSink = false;
  const pendingWrites = new Set<Promise<void>>();
  const trackWrite = (write: () => Promise<void>): Promise<void> => {
    const pending = write();
    pendingWrites.add(pending);
    // The worker can reject immediately on cancellation while filesystem IPC
    // keeps running. Retain these writes until cleanup has drained them.
    void pending.finally(() => pendingWrites.delete(pending)).catch(() => {});
    return pending;
  };
  let completed: Extract<ExportOutcome, { state: "completed" }> | undefined;
  const checkCancelled = () => { if (signal.aborted) throw new ExportCancelled(); };
  const setExportState = (state: ExportState | null) => {
    checkCancelled();
    if (state === null) throw new ExportCancelled();
    if (state.kind === "error") throw new Error(state.detail);
    if (state.kind === "complete") {
      completed = { state: "completed", ...state.payload };
      return;
    }
    deps.onState(state);
  };
  const audioFxGate = (
    proj: ProjectSummary | null,
    range: { startUs: number | null; endUs: number | null },
  ): Promise<AudioFxGateOutcome> =>
      runAudioFxGate({
        listen,
        ensure: (r) => { checkCancelled(); return ensureExportAudioFx(r); },
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
          setExportState({
            kind: "preparing",
            labels,
          });
          return signal;
        },
      });

  try {
    checkCancelled();
    const initialSummary = await projectSummary();
    checkCancelled();
    if (!initialSummary) throw new Error("No project loaded.");
    const mediaById = new Map(initialSummary.media.map((media) => [media.id, media]));
    const execute = async () => {
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
        const proj = initialSummary;
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
        // Read the project from Rust directly, not the event-driven store — the
        // stale-`duration_us` hazard the no-material guard above spells out;
        // here it windows the export to [0,0] → empty plan → a false
        // "no audio material".
        const proj = initialSummary;
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
          checkCancelled();
          const conformWaiting = await ensureExportAudioConform({ startUs, endUs });
          if (conformWaiting.length > 0) {

            setExportState({
              kind: "preparing",
              labels: conformWaiting.map(
                (id) => mediaById.get(id)?.label ?? id,
              ),

            });
            await tracker.waitFor(conformWaiting, signal);
          }
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          setExportState({
            kind: "error",
            detail: gateFailureDetail(e, (id) =>
              t("export.failed_prepare", { labels: mediaById.get(id)?.label ?? id }),
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
        const proj = initialSummary;
        if (!proj) {
          setExportState({ kind: "error", detail: "No project loaded." });
          return;
        }
        const startUs = range?.startUs ?? 0;
        const endUs = range?.endUs ?? rootCompositionOf(proj).duration_us;
        const referencedIds = referencedVideoMediaIds(proj, startUs, endUs);
        const referencedMedia = [...referencedIds]
          .map((id) => mediaById.get(id))
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
          probe: async (url) => { checkCancelled(); const verdict = await classifyWebcodecsDecodability(url); checkCancelled(); return verdict; },
          ensureFullProxy: (id) => { checkCancelled(); return ensureFullProxy(id); },
          proxyStateOf: (id) => proxyStateRef.current.get(id),
          urlForOriginal: (m) => convertFileSrc(m.path),
          memo: decodeProbeMemo.current,
        });

        if (prep.failed.length > 0) {
          const labels = prep.failed
            .map((id) => mediaById.get(id)?.label ?? id)
            .join(", ");
          setExportState({
            kind: "error",
            detail: t("export.failed_prepare", { labels }),
          });
          return;
        }

        if (prep.waiting.length > 0) {

          const labels = prep.waiting.map(
            (id) => mediaById.get(id)?.label ?? id,
          );
          setExportState({
            kind: "preparing",
            labels,

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
              signal,
            });
          } catch (e) {
            if (e instanceof ExportCancelled) {
              setExportState(null);
              return;
            }
            setExportState({
              kind: "error",
              detail: gateFailureDetail(e, (id) =>
                t("export.failed_prepare", { labels: mediaById.get(id)?.label ?? id }),
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
            checkCancelled();
            const conformWaiting = await ensureExportAudioConform({
              startUs,
              endUs,
            });
            if (conformWaiting.length > 0) {

              setExportState({
                kind: "preparing",
                labels: conformWaiting.map(
                  (id) => mediaById.get(id)?.label ?? id,
                ),

              });
              await tracker.waitFor(conformWaiting, signal);
            }
          } catch (e) {
            if (e instanceof ExportCancelled) {
              setExportState(null);
              return;
            }
            setExportState({
              kind: "error",
              detail: gateFailureDetail(e, (id) =>
                t("export.failed_prepare", { labels: mediaById.get(id)?.label ?? id }),
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
      tempVideoPath = await join(tempBase, `weftcut-pixi-${stamp}.${tempVideoExt}`);
      const audioExt = settings.audio.codec === "opus" ? "mka" : "m4a";
      tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.${audioExt}`);

      const summary = initialSummary;
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
      checkCancelled();
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
      nativeSink = target.engine === "native";
      let sinkTarget = target.engine === "native" ? target : null;

      // Native-sink path: start the native-encode video sink (ffmpeg, frames
      // streamed over IPC) before the Worker starts. On the WebCodecs path the
      // existing fMP4 streaming path is used.
      if (nativeSink && sinkTarget) {
        try {
          checkCancelled();
          await exportVideoSinkStart({
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
          checkCancelled();
        } catch (e) {
          checkCancelled();
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
            canFallBack &&
            (await deps.confirmFallback?.(t("export_dialog.native_unavailable_fallback")))
          ) {
            const fallbackOk = await smokeEncode(
              settings.codec as WebCodecsCodecId,
              dims.width,
              dims.height,
              outFps,
            );
            checkCancelled();
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
        if (signal.aborted || total <= 0) return;
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
        ? (data: ArrayBuffer): Promise<void> => trackWrite(async () => {
            checkCancelled();
            await exportVideoSinkWrite(new Uint8Array(data));
          })
        : (data: ArrayBuffer): Promise<void> => trackWrite(async () => {
            checkCancelled();
            await writeFile(tempVideoPath, new Uint8Array(data), { append: true });
          });

      checkCancelled();
      onProgress(0, 1);
      // Timeline geometry is the admitted snapshot. Media paths may have changed
      // during conform/proxy readiness, so take those from the backend now.
      const readySummary = await projectSummary();
      checkCancelled();
      const renderSummary = { ...initialSummary, media: readySummary.media };
      let result;
      try {
        result = await previewRef.current?.runPixiExport({
          summary: renderSummary,
          onProgress,
          encoderConfig,
          outputFps: { num: fpsNum, den: fpsDen },
          startUs: exportRange.startUs,
          endUs: exportRange.endUs,
          keyframeIntervalSec: settings.keyframeIntervalSec,
          writeChunk,
          signal,
          bitDepth: compositeBitDepth(settings),
          ...(nativeSink && sinkTarget ? { nativeSinkPixFmt: sinkTarget.pixFmt } : {}),
          ...(decodeRouting ? { decodeRouting } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (signal.aborted) {
          setExportState(null);
          return;
        }
        console.error("[weftcut/pixi] export failed:", e);
        setExportState({ kind: "error", detail: msg });
        return;
      }
      if (!result) {
        setExportState({
          kind: "error",
          detail: "Preview not initialized.",
        });
        return;
      }

      // On the native-sink path, signal the sink that all frames have been
      // sent. The sink flushes its encoder + muxer and writes the final
      // tempVideoPath. Must run BEFORE the audio export + mux.
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

      try {
        // (1) Video is already written to tempVideoPath (streamed above).
        // Audio-only Rust export -> temp audio file (.m4a/.mka).
        if (settings.audio.include) {
          setExportState({ kind: "finalizing", step: "audio" });
          await exportProjectAudioOnly(
            tempAudioPath,
            {
              codec: settings.audio.codec,
              bitrate: settings.audio.bitrate,
              sampleRate: settings.audio.sampleRate,
              channels: settings.audio.channels,
            },
            { startUs: exportRange.startUs, endUs: exportRange.endUs },
          );
        }

        // (3) Mux → user-chosen path. Every path already wrote the final codec
        // to tempVideoPath (WebCodecs direct-encode, or the native-encode video
        // sink) — the mux step is always a stream-copy into the chosen container.
        setExportState({ kind: "finalizing", step: "mux" });
        await muxExport(tempVideoPath, tempAudioPath, path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] finalize failed:", e);
        // nativeSink sink-finish already ran (above); mux failure doesn't need cancel.
        setExportState({
          kind: "error",
          detail: `Finalize failed: ${msg}`,
        });
        return;
      }

      const durationUs = Math.round(
        (result.totalFrames * 1_000_000 * result.fpsDen) / result.fpsNum,
      );
      setExportState({
        kind: "complete",
        payload: { outputPath: path, durationUs },
      });
    };
    await execute();
    checkCancelled();
    return completed ?? { state: "failed", error: "Export ended without producing a file." };
  } catch (error) {
    if (nativeSink) await exportVideoSinkCancel().catch(() => {});
    if (signal.aborted || error instanceof ExportCancelled) return { state: "cancelled" };
    return { state: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    // A pending append must finish before removal; otherwise it can recreate a
    // scratch file after cleanup and after main admits the next export.
    while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
    await Promise.all([tempVideoPath, tempAudioPath].filter(Boolean).map((file) => remove(file).catch(() => {})));
  }
}
