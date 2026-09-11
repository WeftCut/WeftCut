// React mount for the PixiJS-backed preview surface. Uses @pixi/react's
// <Application> for the PIXI.Application lifecycle (StrictMode-safe,
// async-init, ref-forwarded); the Compositor is driven imperatively from
// onInit and does not own the Application itself.
//
// Plan: docs/render.md

import {
  type CSSProperties,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@/bridge/ipc";
import { Application as PixiApplication } from "@pixi/react";
import { Rectangle, type Application } from "pixi.js";
import type { PlaybackResolution } from "../../shared/app-settings";

import {
  registerTransport,
  releaseTransport,
  setTransportPlaying,
} from "../state/playbackStore";
import { previewLocalUs } from "../state/playheadProjection";
import { playheadTimeUs } from "../state/playheadStore";
import { compositionOrRoot, rootCompositionOf, useProjectStore } from "../state/projectStore";
import {
  previewRenderTargetId,
  usePreviewRenderTargetId,
} from "../state/compositionAnchorStore";
import { useAppSettingsStore, useDecodeEngine } from "../settings/appSettingsStore";
import {
  useDecodeComponentAvailable,
  useDecodeComponentStore,
} from "../settings/decodeComponentStore";
import { containMap } from "../colorpick/pixel";
import {
  clearPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "../colorpick/previewSamplerRegistry";
import {
  clearGizmoProbe,
  registerGizmoProbe,
  type GizmoProbe,
} from "../preview/gizmoProbeRegistry";
import { observeClientRect, type ClientRectCache } from "../preview/layoutRectCache";
import { quickProxyPath } from "./decodeRoute";
import {
  setSlotFenceBackend,
  slotFenceBackendForRenderer,
} from "./decoder/transports/slotFenceQueue";
import { proxyIntent } from "../state/proxyPreferenceStore";
import { layerFxState, readyAudioPath } from "../state/audioFxStore";
import { resolveDecodeEngine } from "./decoder/decodeEngine";
import {
  fittedCanvasBox,
  playbackScaleDiv,
  previewRenderResolution,
  roomFrom,
  type HostBox,
} from "./decoder/playbackResolution";
import { isFfmpegUnusable } from "./decoder/ffmpegCapability";
import { isWebcodecsUnusable } from "./decoder/webcodecsCapability";
import { noteResolution } from "./decoder/decodeCapability";
import { logEmit, type MediaSummary, reportAudioMeter } from "../ipc";
import {
  resetUnderrunState,
  setUnderrunState,
} from "../state/underrunStore";
import {
  setEffectDisabled,
  subscribeEffectOverrides,
} from "./effects/effectOverrides";
import { subscribeRoleGainOverrides } from "./audio/roleGainOverrides";
import { subscribeTransformOverrides } from "./transformOverrides";
import { subscribeMotifCatalog } from "./motifs/catalog";
import { subscribeMotifPreview } from "./motifs/previewOverlay";
import { Compositor, type ResolvedRendererSource } from "./Compositor";
import { ffprobeColorToWebCodecs } from "./decoder/ffprobeColorSpace";
import type { ExportDecodeRouting } from "./exportDecodeRouting";
import { PerfTelemetryBridge } from "./PerfHUD";
import { PlaybackEngine } from "./PlaybackEngine";
import { UnsupportedClipCard } from "./UnsupportedClipCard";
import type { PixiExportResult, PixiPreviewHandle } from "./pixiPreviewFlag";
import { runExport } from "./worker/runExport";
import { webgpuDeviceOf } from "./webgpuDevice";
import {
  clearMasterMeter,
  publishMasterMeter,
  publishMasterMeterSilent,
  publishRoleMeters,
  publishRoleMetersSilent,
  roleMeterDemandWanted,
  subscribeRoleMeterDemand,
} from "../state/masterMeterStore";
import {
  installTimedPresent,
  setPixiPresentationVisible,
} from "./previewPresentation";
import type { PreviewFrameCapture } from "../testhook/e2eHook";

interface Props {
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
  // Explicit `| undefined` (not just `?`) so PreviewSurface can pass its own
  // optional prop straight through under `exactOptionalPropertyTypes`, where a
  // bare `?:` would reject an explicitly-`undefined` value. Handled internally
  // via `previewDecodableOf?.(…) ?? false`.
  previewDecodableOf?: ((mediaId: string) => boolean) | undefined;
  visible?: boolean;
}

const LOG = "[weftcut/pixi]";
let previewResourceSequence = 0;

/// Period of the preview mixer's UI meter tap — master output AND per-Role,
/// sampled together at this one rate. Fast enough that a level meter moves
/// rather than steps, which is why it is a second timer and not a faster
/// version of the agent-facing meter push (the ~2 Hz Rust report), whose slow
/// rate is deliberate. The master's UI reading rides this tap so it moves at the
/// same rate as the Role meters shown beside it; only its agent-facing report
/// stays at the slow cadence.
const PREVIEW_METER_SAMPLE_MS = 50;

/// The render-target half of Playback Resolution, with the display fit folded
/// in: rasterize at `composition × fraction`, the fraction being the smaller of
/// how much of the composition the panel can show (never above 1) and the
/// knob, and put the canvas where the fit's buffer blits 1:1. Pixi shrinks only the canvas
/// backing store (`texture.source.pixelWidth`) — every sprite transform,
/// `containMap` and render texture keep composition coordinates and nothing
/// has to move. Below a fit of 1 the canvas box is the buffer's own size,
/// snapped to the device grid (`fittedCanvasBox`); at 1 the box is CSS's
/// contain-fit and the browser upscales the composition-sized buffer as it
/// always did. The downscale is then Pixi's own, which is the point: `Text`
/// follows `renderer.resolution` (the `resolutionChange` runner re-rasterizes
/// every glyph at the new density), where glyphs drawn at composition size and
/// shrunk by the compositor's 2×2 bilinear tap read as blurred. ADR 0071.
///
/// Size and fraction are applied together on purpose: a composition-size
/// change must carry the current fraction forward rather than reset it.
function applyPreviewFit(
  app: Application,
  size: { width: number; height: number },
  setting: PlaybackResolution | undefined,
  host: HostBox | null,
): void {
  const { width, height } = size;
  app.renderer.resize(
    width,
    height,
    previewRenderResolution(setting, { width, height }, host?.available ?? null),
  );
  const box = host
    ? fittedCanvasBox({
        composition: { width, height },
        available: host.available,
        hostOrigin: host.origin,
        devicePixelRatio: window.devicePixelRatio || 1,
      })
    : null;
  const style = (app.canvas as HTMLCanvasElement).style;
  if (box) {
    style.position = "absolute";
    style.left = `${box.css.left}px`;
    style.top = `${box.css.top}px`;
    style.width = `${box.css.width}px`;
    style.height = `${box.css.height}px`;
  } else {
    for (const p of ["position", "left", "top", "width", "height"]) style.removeProperty(p);
  }
}

/// The host's device-pixel box and origin read synchronously, for the first
/// application at init: the observer's first reading arrives after this
/// frame's rAF, and a first frame drawn at composition size only to be redrawn
/// at the fit is the double render the init sequence is ordered to avoid. Null
/// before layout.
function measureHostBox(host: HTMLElement): HostBox | null {
  const r = host.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  const dpr = window.devicePixelRatio || 1;
  return {
    available: roomFrom(r.width, r.height, dpr),
    origin: { x: r.left * dpr, y: r.top * dpr },
  };
}

function sameHostBox(a: HostBox, b: HostBox): boolean {
  return (
    a.available.width === b.available.width &&
    a.available.height === b.available.height &&
    a.origin.x === b.origin.x &&
    a.origin.y === b.origin.y
  );
}

export const PixiPreview = forwardRef<PixiPreviewHandle, Props>(function PixiPreview(
  { onTimeUpdate, onPausedChange, previewDecodableOf, visible = true },
  ref,
) {
  const compositorRef = useRef<Compositor | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const applicationRef = useRef<Application | null>(null);
  // `handleInit` must not change identity when an always-rendered dock tab
  // flips visibility. Read the current value through a ref at initialization;
  // the visibility effect owns every subsequent transition.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /// MCP meter push timer; set in `onInit`, cleared on unmount (the mount
  /// effect is async and can't return a cleanup itself).
  const meterTimerRef = useRef<number | null>(null);
  /// Per-Role UI meter tap; runs only while a consumer holds a demand lease and
  /// the transport plays. Same teardown path as `meterTimerRef`.
  const roleMeterTimerRef = useRef<number | null>(null);
  const unsubRoleMeterDemandRef = useRef<(() => void) | null>(null);
  const samplerRef = useRef<PreviewSampler | null>(null);
  const gizmoProbeRef = useRef<GizmoProbe | null>(null);
  /// The canvas box the gizmo probe hands out, cached because its readers are
  /// per-frame rAF loops (`preview/layoutRectCache.ts`). Lives beside the probe
  /// and retires with it.
  const canvasRectRef = useRef<ClientRectCache | null>(null);
  /// The composition's size as the renderer draws it, held HERE rather than
  /// read back off `app.screen`: below a fit of 1 Pixi's logical size drifts
  /// off the composition by a fraction of a pixel (`displayFit`), and every
  /// extract frame, `containMap` and render-texture allocation wants the
  /// integer the composition actually is. Seeded at init, followed by the
  /// composition-size effect.
  const logicalSizeRef = useRef<{ width: number; height: number } | null>(null);
  /// The device pixels the host offers and where it sits on the device grid,
  /// as last observed — the fit half of `applyPreviewFit`. Null until the host
  /// has a layout box.
  const hostBoxRef = useRef<HostBox | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const unsubOverridesRef = useRef<(() => void) | null>(null);
  const unsubRoleOverridesRef = useRef<(() => void) | null>(null);
  const unsubTransformOverridesRef = useRef<(() => void) | null>(null);
  const [initializing, setInitializing] = useState(true);
  // On-screen media the Compositor can't decode with any engine — fed ONLY
  // by `Compositor.onUnsupported` (membership-change snapshots, never
  // per-frame; see that field's contract). This component must NEVER clear
  // it directly (React would desync from the Compositor's ground truth); to
  // react to a decode_engine / component-availability change, trigger a
  // re-composite (the `scheduleRepaint()` effect below) and let the
  // Compositor's next resolve fire the correction.
  const [unsupportedIds, setUnsupportedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useImperativeHandle(
    ref,
    () => ({
      play() {
        engineRef.current?.play();
      },
      pause() {
        engineRef.current?.pause();
      },
      seek(tUs: number) {
        engineRef.current?.seek(tUs);
      },
      paused() {
        return !(engineRef.current?.isPlaying() ?? false);
      },
      refreshSources() {
        const compositor = compositorRef.current;
        const engine = engineRef.current;
        if (!compositor) return;
        const t = engine?.positionUs() ?? 0;
        compositor.setProject(
          useProjectStore.getState().summary,
          previewRenderTargetId(),
        );
        compositor.setAnchorTime(t);
        compositor.compositeFrame(t);
      },
      runExport(opts) {
        return handlePixiExport(
          opts,
          compositorRef.current,
          engineRef.current,
        );
      },
    }),
    [],
  );
  const summary = useProjectStore((s) => s.summary);
  const mediaById = useProjectStore((s) => s.mediaById);
  // The preview draws its RENDER TARGET (ADR 0053 decision 3;
  // compositionAnchorStore.ts) — the composition it is locked to, or the
  // editing target while it follows focus. Size and fps here must describe what
  // the Compositor draws, so both follow the same id. Nothing on the rendering
  // side has to change with it: a Group already composites into a texture of
  // its own for its parent to stage, so drawing the film while a Group is
  // edited is a change of argument. Export is unaffected: it renders the root.
  const targetId = usePreviewRenderTargetId();
  const composition = compositionOrRoot(summary, targetId) ?? undefined;
  /// The composition the engine's clock is currently running on. Seeded on the
  /// first pass so the re-base below fires only on a real change of target.
  const previewTargetRef = useRef<string | null | undefined>(undefined);
  const decodeEngine = useDecodeEngine();
  const decodeComponentAvailable = useDecodeComponentAvailable();

  // Called by @pixi/react once the underlying PIXI.Application is
  // ready. Handed an already-initialized Application — we wire the
  // Compositor and PlaybackEngine against it.
  const handleInit = useCallback(
    (app: Application) => {
      applicationRef.current = app;
      // The device dies one microtask after Pixi's own teardown, and not a
      // moment sooner. @pixi/react destroys the Application asynchronously
      // after this component's cleanup; inside that one synchronous
      // `Application.destroy()` Pixi destroys the stage, then the renderer, and
      // the stage's `destroyed` event is the public hook in between — the
      // microtask lands after the renderer half. Destroying the device before
      // Pixi has released the canvas swap chain and its textures reproduces the
      // Electron 44 freeze exactly as leaving it to the garbage collector does.
      // ADR 0059.
      const device = webgpuDeviceOf(app.renderer);
      app.stage.once("destroyed", () => queueMicrotask(() => device?.destroy()));
      // `app.screen` is exact only here, before the first `resize` — Pixi
      // initialized it from the composition-sized props at resolution 1.
      const logical = { width: app.screen.width, height: app.screen.height };
      logicalSizeRef.current = logical;
      /// The composition size for every closure below — never
      /// `renderer.width/height` (see `logicalSizeRef`).
      const logicalSize = (): { width: number; height: number } =>
        logicalSizeRef.current ?? logical;
      // The buffer follows the room the host offers (ADR 0071), taken as the
      // host's CSS box in whole device pixels (`roomFrom`). The HOST is
      // observed rather than the canvas because below a fit of 1 the canvas
      // box is WRITTEN from the fit (`applyPreviewFit`) and could not report
      // the room it has. Observed in `device-pixel-content-box` terms so a DPR
      // change fires it as a panel resize does. A hidden dock tab reads 0×0 and
      // is skipped, so the last good fit outlives the hide; an unchanged
      // reading is skipped so a layout pass that moved nothing costs no
      // `resize`. LANDMINE: a host that moves without resizing is not observed
      // — its origin is re-read only when its size changes.
      resizeObserverRef.current?.disconnect();
      const hostEl = hostRef.current ?? (app.canvas as HTMLCanvasElement).parentElement;
      hostBoxRef.current = hostEl ? measureHostBox(hostEl) : null;
      if (hostEl) {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (!entry || applicationRef.current !== app) return;
          const dpr = window.devicePixelRatio || 1;
          const available = roomFrom(entry.contentRect.width, entry.contentRect.height, dpr);
          if (!(available.width > 0 && available.height > 0)) return;
          const r = hostEl.getBoundingClientRect();
          const next: HostBox = { available, origin: { x: r.left * dpr, y: r.top * dpr } };
          const prev = hostBoxRef.current;
          if (prev && sameHostBox(prev, next)) return;
          hostBoxRef.current = next;
          applyPreviewFit(
            app,
            logicalSize(),
            useAppSettingsStore.getState().settings.playback_resolution,
            next,
          );
        });
        observer.observe(hostEl, { box: "device-pixel-content-box" });
        resizeObserverRef.current = observer;
      }
      // Before the log so it reports the buffer we actually got, and before
      // the first composite so the very first frame rasterizes at the fit and
      // the user's setting instead of full res and then re-rendering.
      applyPreviewFit(
        app,
        logical,
        useAppSettingsStore.getState().settings.playback_resolution,
        hostBoxRef.current,
      );
      console.log(
        `${LOG} application init: canvas=${app.canvas.width}×${app.canvas.height} ` +
          `resolution=${app.renderer.resolution.toFixed(4)} renderer=${app.renderer.type}`,
      );
      // Hardware-lane slot acks: the read-completion signal is taken on THIS
      // device, because it is presented every frame and therefore serviced every
      // frame (see slotFenceQueue.ts — an unpresented context signals ~2 display
      // intervals late on an idle GPU). Registered from the host rather than
      // reached for by the transport: the device belongs to the Application's
      // lifecycle, not to any one decode session.
      setSlotFenceBackend(slotFenceBackendForRenderer(app.renderer));
      // Display geometry: at a fit of 1 the canvas box is CSS's contain-fit
      // (`.pixi-preview-canvas`); below it `applyPreviewFit` writes the box as
      // the buffer's own device pixels, centered on the device grid. Either way
      // the Playback Resolution knob changes the backing pixels alone and never
      // the on-panel size.

      // Dispose any prior Compositor (StrictMode re-mount). Release its
      // transport registration first so the store never holds a disposed
      // engine (the new engine re-registers below).
      if (engineRef.current) releaseTransport(engineRef.current);
      engineRef.current?.dispose();
      compositorRef.current?.dispose();

      // THE preview decode resolver: the single injected gatherer that reads
      // the live stores, runs the PURE `resolveDecodeEngine`, and returns the
      // resolved source (engine + source + decode target + swap key). Impure
      // by design (store reads) but hands only plain values into the pure
      // core; a mid-session setting/component/probe flip takes effect on the
      // next `ensureClip` because every input is read live per call. Lane
      // (HW/SW) selection is NOT gathered here — `FfmpegSource` owns it (via
      // `pickInitialLane`/`ffmpegCapability`); the pool acquires by `engine`.
      const resolveSource = (mediaId: string): ResolvedRendererSource | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        if (!m) return null;
        const setting = useAppSettingsStore.getState().settings.decode_engine;
        const componentAvailable = useDecodeComponentStore.getState().available;
        const qp = quickProxyPath(m);
        const r = resolveDecodeEngine({
          setting,
          componentAvailable,
          // Gate on availability: intent true but no proxy on disk keeps the
          // original decoding until a build lands (then the swap key flips).
          useProxySource: proxyIntent(mediaId) && qp !== null,
          proxyReady: qp !== null,
          proxyUrl: qp !== null ? convertFileSrc(qp) : null,
          originalPath: m.path,
          // convertFileSrc HERE (the impure edge) so the Compositor + pure
          // core stay URL-scheme-agnostic.
          originalUrl: convertFileSrc(m.path),
          // Session probe memo (App's decodeProbeMemo via the prop) — read
          // live so a mid-session probe flip feeds the webcodecs×original
          // branch on the next ensureClip. A sticky "webcodecs-confirmed-
          // unusable" mark (set by the import sweep on a DEFINITIVE
          // unsupported-codec verdict, e.g. ProRes) wins as "fail" so a pinned-
          // Lite decode resolves status:"unsupported" (UnsupportedClipCard)
          // instead of hanging on "pending"; mirrors the `ffmpegUsable` feed.
          webcodecsCanDecodeOriginal: isWebcodecsUnusable(mediaId)
            ? "fail"
            : (previewDecodableOf?.(mediaId) ?? false)
              ? "ok"
              : "untested",
          ffmpegUsable: !isFfmpegUnusable(mediaId),
        });
        noteResolution(mediaId, r);
        return r;
      };
      const originalAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        if (!m) return null;
        return convertFileSrc(m.path);
      };
      const sourceColor = (mediaId: string): VideoColorSpaceInit | undefined => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        return m ? ffprobeColorToWebCodecs(m) : undefined;
      };
      const lookupMedia = (mediaId: string): MediaSummary | undefined =>
        useProjectStore.getState().mediaById.get(mediaId);
      // The audio a layer's mixer reads: the baked effect-chain sibling when
      // one is ready for THIS layer, else the media's raw conform PCM (null
      // while the conform job hasn't landed). Keyed by LAYER and not by media
      // on purpose — two layers can share one media and carry different
      // chains, so a per-media answer would play one layer's effects on the
      // other. See ADR 0063.
      const audioSourceUrl = (layerId: string, mediaId: string): string | null => {
        const baked = readyAudioPath(layerFxState(layerId));
        if (baked !== null) return convertFileSrc(baked);
        const m = useProjectStore.getState().mediaById.get(mediaId);
        const p = m?.conform_path;
        return p ? convertFileSrc(p) : null;
      };

      const compositor = new Compositor({
        app,
        // LANDMINE: the composition's size, not `app.canvas.width/height` and
        // not `app.screen` either. The canvas is the physical backing store,
        // which the fit and the playback-resolution fraction shrink, and below
        // a fit of 1 the logical size drifts off the composition by a fraction
        // of a pixel (`displayFit`); these two become `compositionWidth`/
        // `Height` and size the effect + transition render textures, so either
        // would silently render effects at the wrong size and diverge from
        // export.
        width: logical.width,
        height: logical.height,
        mode: "preview",
        resolveSource,
        // Membership-change snapshot only (see `compositeFrame`'s reset/
        // diff/fire around its layer sweep) — safe to feed straight into
        // React state.
        onUnsupported: setUnsupportedIds,
        // Edge-triggered + throttled (UnderrunTracker) — feeds the
        // transport bar's DroppedFramesIndicator via the module store.
        onUnderrun: setUnderrunState,
        originalAssetUrl,
        sourceColor,
        mediaById: lookupMedia,
        audioSourceUrl,
      });
      // Playback resolution: seed the pool BEFORE the first `ensureClip` so the
      // very first source opens at the user's setting instead of full res and
      // then re-opening. Deliberately NOT part of the swap key that
      // `resolveSource` builds — the divisor is a transport property, and
      // `FfmpegSource` re-opens its transport in place (same ring, no flash),
      // which is both cheaper and gapless compared to rebuilding the handle.
      compositor.setPlaybackScaleDiv(
        playbackScaleDiv(useAppSettingsStore.getState().settings.playback_resolution),
      );
      compositor.setPresentationVisible(visibleRef.current);
      // Before the visibility call: that one early-returns when the state is
      // unchanged (the usual init case, already visible), so it would never
      // install the timed present on its own.
      installTimedPresent(app);
      setPixiPresentationVisible(app, visibleRef.current);
      const initialSummary = useProjectStore.getState().summary;
      // Read imperatively: Application init is async, so the target at mount
      // time is whatever the store holds NOW, not what the render that started
      // the init closed over. The effect below re-targets on every later change.
      const initialTargetId = previewRenderTargetId();
      compositor.setProject(initialSummary, initialTargetId);

      const engine = new PlaybackEngine({ compositor, ticker: app.ticker });
      const resourceGeneration = ++previewResourceSequence;
      const initialComposition = compositionOrRoot(initialSummary, initialTargetId);
      engine.bindFps(
        initialComposition?.fps_num ?? 30,
        initialComposition?.fps_den ?? 1,
      );
      // Seed the fresh engine from the live playhead store, AFTER bindFps so
      // the position snaps on the composition's real frame grid. Application
      // init is async, and every seek issued in that window (keyboard
      // shortcuts, timecode commits) writes the store optimistically while
      // `engineRef`/the transport registration are still null — this engine
      // never heard them. Its first tick emits ITS position over the store
      // (`lastEmittedUs` starts unset), so without the seed a playhead parked
      // during init — or across any preview remount — teleports back to 0.
      // The store is ROOT time and the engine's clock is the composition it
      // draws, so the seed is projected on the way in.
      const restoreUs = previewLocalUs(playheadTimeUs());
      if (restoreUs !== 0) engine.seek(restoreUs);
      if (onTimeUpdate) engine.onTimeUpdate(onTimeUpdate);
      if (onPausedChange) engine.onPlayStateChange((p) => onPausedChange(!p));

      compositorRef.current = compositor;
      engineRef.current = engine;

      // Global transport: expose this engine to code outside the React ref
      // chain (backend event handlers, MCP-driven mutations, dialogs) via the
      // playback store. Mirror the play state so store subscribers track
      // play/pause without polling.
      engine.onPlayStateChange(setTransportPlaying);
      registerTransport(engine);

      // Session-end underrun summary → status log. FCP-style "warn after
      // playback": the transport indicator shows the counts live; this row
      // makes them durable + explains the cause. `takeUnderrun
      // SessionSummary` is once-per-session, so a pause-during-warmup
      // (which also fires playing=false) can't re-log a stale count.
      //
      // The two counts stay separate phrases: "dropped" is a decoder that
      // fell behind, "late" is a composite loop that stalled with a full
      // ring. Merging them would point the reader at the wrong subsystem.
      engine.onPlayStateChange((playing) => {
        if (playing) return;
        const { droppedFrames, lateFrames } =
          compositor.takeUnderrunSessionSummary();
        if (droppedFrames === 0 && lateFrames === 0) return;
        const causes: string[] = [];
        if (droppedFrames > 0) {
          causes.push(
            `${droppedFrames} frame${droppedFrames === 1 ? "" : "s"} dropped (decoding fell behind)`,
          );
        }
        if (lateFrames > 0) {
          causes.push(
            `${lateFrames} frame${lateFrames === 1 ? "" : "s"} late (the render loop stalled)`,
          );
        }
        void logEmit({
          level: "warn",
          category: { kind: "System" },
          source: { kind: "System" },
          message: `Playback couldn't keep up — ${causes.join("; ")}`,
          i18n_key: "log.playback_dropped_frames",
          i18n_args: { dropped: droppedFrames, late: lateFrames },
        });
      });

      // Color picker: register the sampling surface (same replace-on-remount
      // lifecycle as the transport registration above). captureFrame reuses the
      // compositeFrame→render→extract discipline the e2e sampleComposite path
      // proved; excludeEffectId freezes the PRE-key frame the chromakey
      // eyedropper samples. Spec: docs/features.md#color-picker-eyedropper
      unsubOverridesRef.current?.();
      const previewSampler: PreviewSampler = {
        captureFrame: async (opts) => {
          const excludeId = opts?.excludeEffectId;
          try {
            if (excludeId) setEffectDisabled(excludeId, true);
            compositor.compositeFrame(engine.positionUs());
            app.renderer.render(app.stage);
            const out = app.renderer.extract.pixels({
              target: app.stage,
              frame: new Rectangle(0, 0, logicalSize().width, logicalSize().height),
              // Pinned, because `extract` otherwise inherits
              // `renderer.resolution` while `mapClientToComposition` below maps
              // through the composition size — a fitted or throttled preview
              // would hand the eyedropper a buffer the coordinates don't index.
              resolution: 1,
            });
            return { pixels: out.pixels, width: out.width, height: out.height };
          } finally {
            if (excludeId) {
              setEffectDisabled(excludeId, false);
              compositor.compositeFrame(engine.positionUs());
            }
          }
        },
        mapClientToComposition: (clientX, clientY) => {
          const rect = (app.canvas as HTMLCanvasElement).getBoundingClientRect();
          const { width, height } = logicalSize();
          return containMap(clientX, clientY, rect, width, height);
        },
        canvasRect: () => (app.canvas as HTMLCanvasElement).getBoundingClientRect(),
      };
      registerPreviewSampler(previewSampler);
      samplerRef.current = previewSampler;

      // On-canvas gizmo: geometry only (no pixels), same register-on-init /
      // identity-guarded-clear lifecycle as the sampler above.
      // Cached, unlike the sampler's own `canvasRect` above: the gizmo's readers
      // are rAF loops running alongside the timeline playhead's `style.left`
      // write, where a live read costs a full-document reflow every frame. The
      // sampler reads at event time, where a fresh box is the point.
      canvasRectRef.current?.dispose();
      canvasRectRef.current = observeClientRect(app.canvas as HTMLCanvasElement);
      const canvasRect = canvasRectRef.current;
      const gizmoProbe: GizmoProbe = {
        canvasRect: () => canvasRect.rect(),
        naturalSizeOf: (layerId) => compositor.naturalSizeOf(layerId),
        textFitOf: (layerId) => compositor.textFitOf(layerId),
      };
      registerGizmoProbe(gizmoProbe);
      gizmoProbeRef.current = gizmoProbe;
      // Hover live-apply while paused: sync() only runs inside compositeFrame,
      // so poke one on every transient-override change.
      unsubOverridesRef.current = subscribeEffectOverrides(() => {
        compositor.compositeFrame(engine.positionUs());
      });
      // Role Gain fader audition: the audio pass re-derives the mixer from the
      // renderer-local override only inside compositeFrame, so poke one on every
      // change (the change-detection guard skips a reschedule when the folded
      // gain is unchanged). Playing already composites per rAF; this keeps the
      // audition responsive at the very start/end of a gesture.
      unsubRoleOverridesRef.current?.();
      unsubRoleOverridesRef.current = subscribeRoleGainOverrides(() => {
        compositor.compositeFrame(engine.positionUs());
      });

      // On-canvas gizmo drag: same reason as the two above — the transient
      // delta is only read inside compositeFrame, and while paused nothing
      // else calls it, so the dragged layer would not move until the commit.
      unsubTransformOverridesRef.current?.();
      unsubTransformOverridesRef.current = subscribeTransformOverrides(() => {
        compositor.compositeFrame(engine.positionUs());
      });

      // Master-bus meter REPORT (~2 Hz while playing) for the MCP
      // `composition://meter` resource. This is the agent-facing push only — the
      // master's UI reading is published by the fast preview tap below, at the
      // Role meters' rate, so the two do not read as two clocks. dB values clamp
      // at -120 — JSON can't carry the analyser's -Infinity silence reading.
      // Clear any prior timer first (StrictMode re-mount).
      if (meterTimerRef.current !== null) {
        window.clearInterval(meterTimerRef.current);
      }
      meterTimerRef.current = window.setInterval(() => {
        const g = compositor.getAudioGraph();
        if (!g || !engine.isPlaying()) return;
        const snap = g.meterSnapshot();
        void reportAudioMeter({
          rmsDb: Number.isFinite(snap.rmsDb) ? snap.rmsDb : -120,
          peakDb: Number.isFinite(snap.peakDb) ? snap.peakDb : -120,
        }).catch(() => {});
      }, 500);
      // The push samples only while playing, so a pause would leave the store
      // holding the last playing reading — beside Role meters that fall to the
      // floor the moment their tap stops. One silent sample on the transition
      // keeps the master's reading truthful. The store only: the MCP resource's
      // contract is a reading sampled while playing, and it is not touched here.
      engine.onPlayStateChange((playing) => {
        if (!playing) publishMasterMeterSilent();
      });

      // The preview mixer's UI meter tap: master output AND the four Roles, from
      // one instant at one rate, for the Role Mixer Panel. Independent of the
      // agent report above. It samples only while a consumer holds a demand
      // lease AND the transport plays, and publishes one silent sample whenever
      // it stops — a held last reading would show level over a silent mix.
      const stopRoleMeterTap = (): void => {
        if (roleMeterTimerRef.current === null) return;
        window.clearInterval(roleMeterTimerRef.current);
        roleMeterTimerRef.current = null;
        publishRoleMetersSilent();
      };
      const syncRoleMeterTap = (): void => {
        const wanted = roleMeterDemandWanted() && engine.isPlaying();
        if (wanted === (roleMeterTimerRef.current !== null)) return;
        if (!wanted) {
          stopRoleMeterTap();
          return;
        }
        roleMeterTimerRef.current = window.setInterval(() => {
          const g = compositor.getAudioGraph();
          if (!g) return;
          // Master and Roles carry the SAME sample time, so the master's line
          // and the four Role columns move as one clock rather than two.
          const sampledAtMs = performance.now();
          publishMasterMeter(g.meterSnapshot(), sampledAtMs);
          publishRoleMeters(g.roleMeterSnapshots(), sampledAtMs);
        }, PREVIEW_METER_SAMPLE_MS);
      };
      // Drop a prior mount's timer and subscription (StrictMode re-mount).
      if (roleMeterTimerRef.current !== null) {
        window.clearInterval(roleMeterTimerRef.current);
        roleMeterTimerRef.current = null;
      }
      unsubRoleMeterDemandRef.current?.();
      unsubRoleMeterDemandRef.current =
        subscribeRoleMeterDemand(syncRoleMeterTap);
      engine.onPlayStateChange(syncRoleMeterTap);
      syncRoleMeterTap();

      // E2E-only: register a live bridge so the WebDriver hooks
      // (window.__weftcutTest.weftcutSeekUs / weftcutSampleComposite) can drive
      // a real seek and read pixels straight off the composited canvas. Dynamic
      // import behind the static VITE_WEFTCUT_E2E check → stripped from prod.
      if (import.meta.env.VITE_WEFTCUT_E2E === "1") {
        void import("../testhook/e2eHook").then(({ installPreviewBridge }) => {
          installPreviewBridge({
            seekUs: (us: number) => {
              engine.seek(us);
            },
            sampleComposite: async (x: number, y: number) => {
              // Pull a full-composition RGBA buffer via renderer.extract.pixels
              // (reliable on WebGPU/WebGL regardless of preserveDrawingBuffer,
              // and avoids the OffscreenCanvas 2D-context quirks of the
              // canvas()+drawImage route). Frame is pinned to the WHOLE
              // composition AND `resolution: 1`, so (x,y) are
              // ABSOLUTE composition pixels no matter what the playback-
              // resolution knob does to the canvas — the countdown sits at
              // (0,0) scale 1, so its center is (W/2, H/2).
              const { width: W, height: H } = logicalSize();
              // Force a render of the live tree before extracting so the
              // freshly-bound motif texture is on the framebuffer (the
              // always-on ticker also renders, but extracting right after an
              // explicit render removes any race with removeChildren()).
              compositor.compositeFrame(engine.positionUs());
              app.renderer.render(app.stage);
              const readFrom = (
                target: import("pixi.js").Container,
              ): import("../testhook/e2eHook").CompositeSample => {
                const out = app.renderer.extract.pixels({
                  target,
                  frame: new Rectangle(0, 0, W, H),
                  resolution: 1,
                });
                const buf = out.pixels;
                const w = out.width;
                const px = Math.max(0, Math.min(w - 1, Math.round(x)));
                const py = Math.max(0, Math.min(out.height - 1, Math.round(y)));
                const i = (py * w + px) * 4;
                // Whole-frame scan: count opaque pixels AND accent-colored
                // pixels (the countdown's accent #ff4d4d = rgb(255,77,77):
                // high red, low green/blue, opaque). Reporting the accent
                // count + a representative accent pixel lets the spec assert
                // "renders accent-colored content" without depending on where
                // a single glyph stroke lands (the numeral's exact center can
                // fall in the "3"'s transparent hollow).
                let nonTransparent = 0;
                let maxA = 0;
                let accentCount = 0;
                let ar = 0;
                let ag = 0;
                let ab = 0;
                for (let j = 0; j < buf.length; j += 4) {
                  const r = buf[j]!;
                  const g = buf[j + 1]!;
                  const b = buf[j + 2]!;
                  const a = buf[j + 3]!;
                  if (a > 0) nonTransparent++;
                  if (a > maxA) maxA = a;
                  if (a === 255 && r > 180 && g < 150 && b < 150) {
                    if (accentCount === 0) {
                      ar = r;
                      ag = g;
                      ab = b;
                    }
                    accentCount++;
                  }
                }
                return {
                  r: buf[i] ?? 0,
                  g: buf[i + 1] ?? 0,
                  b: buf[i + 2] ?? 0,
                  a: buf[i + 3] ?? 0,
                  w,
                  h: out.height,
                  nonTransparent,
                  maxA,
                  accentCount,
                  accentR: ar,
                  accentG: ag,
                  accentB: ab,
                };
              };
              // Prefer the app root (the live presented tree). If it reads all-
              // transparent, fall back to the compositor's own stage container —
              // a divergence localises the bug (root-vs-container extract).
              const root = readFrom(app.stage);
              if (root.nonTransparent > 0) return root;
              return readFrom(compositor.stage);
            },
            // Preview-sw conformance: report the active clip's decode source +
            // sprite straight off the live Compositor.
            activeClipProbe: (layerId?: string) =>
              compositor.activeClipProbe(layerId),
            // Preview conformance: encode the current composited frame and
            // return the exact clip-frame identity bound during that same
            // capture. Ring bounds alone cannot establish what was painted.
            captureFrame: async (layerId?: string): Promise<PreviewFrameCapture> => {
              const { width: W, height: H } = logicalSize();
              // Re-composite + render so the freshly-decoded frame is on the
              // framebuffer before the read (mirrors sampleComposite).
              const positionUs = engine.positionUs();
              compositor.compositeFrame(positionUs);
              app.renderer.render(app.stage);
              const clip = compositor.activeClipProbe(layerId);
              const { presentedCompositeCount } = compositor.presentationSnapshot();
              const out = app.renderer.extract.pixels({
                target: app.stage,
                frame: new Rectangle(0, 0, W, H),
                // Conformance PNGs are composition-sized at every playback
                // resolution — a gate must not read a preview performance knob.
                resolution: 1,
              });
              const canvas = new OffscreenCanvas(out.width, out.height);
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("capturePng: no 2d context");
              ctx.putImageData(
                new ImageData(
                  new Uint8ClampedArray(out.pixels),
                  out.width,
                  out.height,
                ),
                0,
                0,
              );
              const blob = await canvas.convertToBlob({ type: "image/png" });
              const buf = await blob.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]!);
              }
              return {
                pngBase64: btoa(binary),
                positionUs,
                presentedCompositeCount,
                clip,
              };
            },
            resourceProbe: () => ({
              generation: resourceGeneration,
              playing: engine.isPlaying(),
              positionUs: engine.positionUs(),
              ...compositor.presentationSnapshot(),
            }),
            // Playback bench: read the product's OWN per-frame accounting
            // (dropped frames, per-clip rings, HW handoff barrier) rather than
            // having the driver recompute frame timing from outside.
            perfSnapshot: () => compositor.getPerfSnapshot(),
          });
        });
      }

      compositor.setAnchorTime(restoreUs);
      compositor.compositeFrame(restoreUs);
      setInitializing(false);
    },
    [onTimeUpdate, onPausedChange, previewDecodableOf],
  );

  useEffect(() => {
    const compositor = compositorRef.current;
    const app = applicationRef.current;
    compositor?.setPresentationVisible(visible);
    if (app) setPixiPresentationVisible(app, visible);
  }, [visible]);

  // A Standard switch (from the card's own button or the settings panel) or
  // the ffmpeg component finishing load can change whether a given media is
  // decodable — but `unsupportedIds` must be updated ONLY by the Compositor's
  // `onUnsupported` callback: a direct `setUnsupportedIds` here races it and
  // can permanently hide the card for a still-unsupported clip. Request a
  // re-composite instead; the Compositor re-resolves every on-screen clip
  // and fires exactly once if membership actually changed.
  useEffect(() => {
    compositorRef.current?.scheduleRepaint();
  }, [decodeEngine, decodeComponentAvailable]);

  // Playback resolution can change mid-session, and drives BOTH halves of the
  // setting from this one subscription: the decode side (fewer pixels shipped
  // over IPC) and the raster side (fewer pixels drawn). Subscribed to the store
  // DIRECTLY rather than read through a hook: a re-render is the wrong
  // response — the pool hands the new divisor to every live `FfmpegSource`,
  // which re-opens its transport in place keeping the ring, and the renderer
  // resize keeps every logical coordinate put, so playback continues without a
  // rebuild or a black frame. Neither target may exist yet (async onInit);
  // `handleInit` seeds both itself in that case.
  useEffect(() => {
    return useAppSettingsStore.subscribe((s) => {
      compositorRef.current?.setPlaybackScaleDiv(
        playbackScaleDiv(s.settings.playback_resolution),
      );
      const app = applicationRef.current;
      const logical = logicalSizeRef.current;
      if (app && logical) {
        applyPreviewFit(app, logical, s.settings.playback_resolution, hostBoxRef.current);
      }
    });
  }, []);

  // Re-applies size + fraction together (why: `applyPreviewFit`). No-ops while
  // the pixel dimensions are unchanged — Pixi compares them.
  const compositionWidth = composition?.width;
  const compositionHeight = composition?.height;
  useEffect(() => {
    const app = applicationRef.current;
    if (!app || compositionWidth === undefined || compositionHeight === undefined)
      return;
    const logical = { width: compositionWidth, height: compositionHeight };
    logicalSizeRef.current = logical;
    applyPreviewFit(
      app,
      logical,
      useAppSettingsStore.getState().settings.playback_resolution,
      hostBoxRef.current,
    );
    // The renderer alone is not enough: the Compositor sizes the transition RT
    // pool and each ImageOverlaySprite's decode cap off its own copy.
    compositorRef.current?.setCompositionSize(compositionWidth, compositionHeight);
  }, [compositionWidth, compositionHeight]);

  // Forward summary updates — and a change of RENDER TARGET — to the
  // Compositor without remounting the Application. `setProject` rebuilds the
  // node from scratch when the id changes: every sprite, mixer and decode
  // session belonged to the composition being left. The size effect above is
  // declared first, so the Compositor already knows the new frame size by the
  // time the node is built against it.
  useEffect(() => {
    if (!compositorRef.current) return;
    compositorRef.current.setProject(summary, targetId);
    engineRef.current?.bindFps(
      composition?.fps_num ?? 30,
      composition?.fps_den ?? 1,
    );
    // A change of TARGET re-bases the engine's clock. It reads and emits one
    // number and that number is the composition it draws, so without this the
    // next emit would be read as the new composition's while still naming the
    // old one's, and the playhead would jump by the offset between them. Guarded
    // on the id alone: a summary update leaves the engine's position meaning
    // exactly what it meant before.
    //
    // A target whose own `t = 0` is later than the moment re-bases to a negative
    // time, which the engine's clock floors at zero — so it sits at its first
    // frame until the film reaches it. The film is NOT dragged there:
    // `setPlayheadFromPreview` drops that floor rather than reading it as the
    // one moment.
    if (previewTargetRef.current !== targetId) {
      previewTargetRef.current = targetId;
      engineRef.current?.seek(previewLocalUs(playheadTimeUs()));
    }
    const t = engineRef.current?.positionUs() ?? 0;
    compositorRef.current.setAnchorTime(t);
    compositorRef.current.compositeFrame(t);
  }, [summary, targetId, composition, mediaById]);

  // A draft edit / install / delete updates the runtime Motif catalog (via the
  // async motifs:changed → syncUserMotifsFromBackend → setUserMotifs chain). We
  // subscribe to the catalog CHANGE-NOTIFIER rather than the raw backend event so
  // we refresh only AFTER `setUserMotifs` has landed the new manifests in the
  // catalog and bumped its revision — subscribing to the raw event races the
  // async re-sync and re-captures stale source. Refresh the live Motif sprites
  // against the fresh catalog + recapture at the current playhead. The
  // compositor may not be initialized yet (async onInit) — read the ref live
  // and bail if absent.
  useEffect(() => {
    return subscribeMotifCatalog(() => {
      const c = compositorRef.current;
      if (!c) return;
      c.refreshMotifs();
      c.compositeFrame(engineRef.current?.positionUs() ?? 0);
    });
  }, []);

  // A Motif params page previewing a gesture writes pending props into the
  // overlay store instead of the state actor, so no `summary` ever changes and
  // the effect above never fires. Ride the same signal path a catalog change
  // uses — the overlay is folded in at the frame descriptor, so re-arming the
  // sprites and recompositing is all it takes for the new props to reach the
  // canvas (the last bitmap holds until the fresh capture lands, so no flash).
  useEffect(() => {
    return subscribeMotifPreview(() => {
      const c = compositorRef.current;
      if (!c) return;
      c.refreshMotifs();
      c.compositeFrame(engineRef.current?.positionUs() ?? 0);
    });
  }, []);

  // Dispose Compositor + PlaybackEngine on unmount. The library
  // disposes the Application itself.
  useEffect(() => {
    return () => {
      // Identity-guarded release: a stale unmount can't tear down a newer
      // mount's registration.
      if (engineRef.current) releaseTransport(engineRef.current);
      resetUnderrunState();
      if (samplerRef.current) clearPreviewSampler(samplerRef.current);
      samplerRef.current = null;
      if (gizmoProbeRef.current) clearGizmoProbe(gizmoProbeRef.current);
      gizmoProbeRef.current = null;
      canvasRectRef.current?.dispose();
      canvasRectRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      hostBoxRef.current = null;
      logicalSizeRef.current = null;
      unsubOverridesRef.current?.();
      unsubOverridesRef.current = null;
      unsubRoleOverridesRef.current?.();
      unsubRoleOverridesRef.current = null;
      unsubTransformOverridesRef.current?.();
      unsubTransformOverridesRef.current = null;
      engineRef.current?.dispose();
      compositorRef.current?.dispose();
      compositorRef.current = null;
      engineRef.current = null;
      applicationRef.current = null;
      // The device goes with the Application. Slots already pending keep their
      // own probes and still ack — see `SlotFenceQueue.setBackend`.
      setSlotFenceBackend(null);
      clearMasterMeter();
      if (meterTimerRef.current !== null) {
        window.clearInterval(meterTimerRef.current);
        meterTimerRef.current = null;
      }
      unsubRoleMeterDemandRef.current?.();
      unsubRoleMeterDemandRef.current = null;
      if (roleMeterTimerRef.current !== null) {
        window.clearInterval(roleMeterTimerRef.current);
        roleMeterTimerRef.current = null;
      }
      // E2E-only: clear the preview bridge so seek/readback hooks don't
      // hold a stale closure over the disposed engine + compositor.
      if (import.meta.env.VITE_WEFTCUT_E2E === "1") {
        void import("../testhook/e2eHook").then(({ clearPreviewBridge }) => {
          clearPreviewBridge();
        });
      }
    };
  }, []);

  if (!composition) {
    return (
      <span className="placeholder" data-testid="pixi-preview-loading">
        Loading project…
      </span>
    );
  }

  // The card is a single overlay: with multiple simultaneously-unsupported
  // clips it targets one representative id (Set iteration order, i.e.
  // first-inserted this composite) — an accepted simplification.
  const unsupportedMediaId = unsupportedIds.values().next().value;

  return (
    <div
      ref={hostRef}
      className="pixi-preview-host"
      style={
        {
          "--pixi-preview-canvas-width": `min(100cqw, ${
            (composition.width / composition.height) * 100
          }cqh)`,
          "--pixi-preview-canvas-height": `min(100cqh, ${
            (composition.height / composition.width) * 100
          }cqw)`,
        } as CSSProperties
      }
    >
      <PixiApplication
        width={composition.width}
        height={composition.height}
        background={0x000000}
        antialias
        // Prefer WebGPU; PixiJS auto-falls back to WebGL when the
        // runtime doesn't expose `navigator.gpu` (older Chromium,
        // restricted contexts). `app.renderer.type` in the init log
        // reads 2 for WebGPU, 1 for WebGL — useful sanity check.
        preference="webgpu"
        onInit={handleInit}
        className="pixi-preview-canvas"
      />
      {initializing && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
          data-testid="pixi-preview-initializing"
        >
          <div className="preview-spinner" />
        </div>
      )}
      {(import.meta.env.DEV || import.meta.env.VITE_WEFTCUT_E2E === "1") && (
        <PerfTelemetryBridge compositorRef={compositorRef} engineRef={engineRef} />
      )}
      {unsupportedMediaId !== undefined && (
        <UnsupportedClipCard mediaId={unsupportedMediaId} />
      )}
    </div>
  );
});

/// Field semantics for `opts`: `PixiPreviewHandle.runExport` in
/// pixiPreviewFlag.ts, which most of them are threaded straight into.
async function handlePixiExport(
  opts: {
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
    startUs?: number;
    endUs?: number;
    keyframeIntervalSec?: number;
    writeChunk: (data: ArrayBuffer) => Promise<void>;
    motifFrames?: Record<string, ImageBitmap[]>;
    bitDepth?: 8 | 10;
    nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
    decodeRouting?: ExportDecodeRouting;
  },
  compositor: Compositor | null,
  engine: PlaybackEngine | null,
): Promise<PixiExportResult> {
  const store = useProjectStore.getState();
  const summary = store.summary;
  if (!summary) {
    throw new Error("No project loaded");
  }
  // Suspend the preview compositor so its VideoDecoder releases the
  // hardware video-decode slot. The export Worker's decoder otherwise
  // wedges fighting for the same slot. Engine is paused first so its
  // rAF loop can't squeeze in another setAnchorTime tick before
  // suspend takes effect.
  const wasPlaying = engine?.isPlaying() ?? false;
  engine?.pause();
  compositor?.setSuspended(true);

  try {
    const result = await runExport({
      summary,
      mediaById: store.mediaById,
      writeChunk: opts.writeChunk,
      // Conditional spreads: under exactOptionalPropertyTypes an optional
      // field may be absent but not explicitly `undefined`.
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.encoderConfig ? { encoderConfig: opts.encoderConfig } : {}),
      ...(opts.outputFps ? { outputFps: opts.outputFps } : {}),
      ...(opts.startUs != null ? { startUs: opts.startUs } : {}),
      ...(opts.endUs != null ? { endUs: opts.endUs } : {}),
      ...(opts.keyframeIntervalSec != null
        ? { keyframeIntervalSec: opts.keyframeIntervalSec }
        : {}),
      ...(opts.motifFrames ? { motifFrames: opts.motifFrames } : {}),
      ...(opts.bitDepth != null ? { bitDepth: opts.bitDepth } : {}),
      ...(opts.nativeSinkPixFmt != null
        ? { nativeSinkPixFmt: opts.nativeSinkPixFmt }
        : {}),
      ...(opts.decodeRouting ? { decodeRouting: opts.decodeRouting } : {}),
    });
    const outFpsNum = opts.outputFps?.num ?? rootCompositionOf(summary).fps_num;
    const outFpsDen = opts.outputFps?.den ?? rootCompositionOf(summary).fps_den;
    return {
      framesEncoded: result.framesEncoded,
      totalFrames: result.totalFrames,
      fpsNum: outFpsNum,
      fpsDen: outFpsDen,
    };
  } finally {
    compositor?.setSuspended(false);
    // Force re-init: the engine's rAF loop will re-acquire decoders
    // via ensureClip on its next tick, but kick the compositor once
    // here so the canvas isn't blank for a frame.
    const t = engine?.positionUs() ?? 0;
    compositor?.setProject(
      useProjectStore.getState().summary,
      previewRenderTargetId(),
    );
    compositor?.setAnchorTime(t);
    compositor?.compositeFrame(t);
    if (wasPlaying) engine?.play();
  }
}
