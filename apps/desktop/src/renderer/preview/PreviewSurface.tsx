import { CropOverlayHost } from './CropOverlay';
import { PreviewContextMenu } from './PreviewContextMenu';
import { canEditCrop } from '../commands/cropCommands';
import { canScaleLayer } from '../commands/scaleCommands';
import { transportPlay, transportPause, transportSeek, usePlaybackStore } from "../state/playbackStore";
/// Project preview surface. Renders the project through the Pixi
/// compositor (the only preview path) inside a PixiErrorBoundary, or an
/// empty-state / loading placeholder when there is no content or no
/// composition yet. Forwards play/pause/seek/refresh/export to the
/// underlying PixiPreview.

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { compositionOrRoot, useProjectStore } from "../state/projectStore";
import { PixiPreview } from "../render/PixiPreview";
import type {
  PixiExportResult,
  PixiPreviewHandle,
} from "../render/pixiPreviewFlag";
import { PixiErrorBoundary } from "../render/PixiErrorBoundary";
import { PreviewGridOverlayHost } from "./PreviewGridOverlay";
import { SafeAreaGuidesHost } from "./SafeAreaGuides";
import { TextToolOverlayHost } from "./TextToolOverlay";
import { TransformGizmoHost } from "./TransformGizmo";
import { PreviewHandTool } from "./PreviewHandTool";
import { PreviewSuspendedNotice, type PreviewSuspendedBy } from "./PreviewSuspendedNotice";
import { usePreviewViewGestures } from "./previewViewGestures";

interface Props {
  /// True when the project has at least one layer. When false we
  /// render the empty-state placeholder.
  hasContent: boolean;
  /// Live accessor for the session decodability verdict (App's
  /// decodeProbeMemo). When it returns true for a source, the preview
  /// resolver shows the original immediately instead of waiting on a proxy.
  previewDecodableOf?: (mediaId: string) => boolean;
  /** Dock visibility gates presentation work, never playback ownership. */
  visible?: boolean;
}

export interface PreviewSurfaceHandle {
  currentDecodeDevices(): import('../render/decoder/session').PreviewDecodeDevice[];
  play(): void;
  pause(): void;
  seekTo(tUs: number): void;
  paused(): boolean;
  /// Re-resolve every clip's preview source against the live decodability
  /// bridge and re-composite. Delegates to the underlying PixiPreview.
  refreshSources(): void;
  /// Yield the preview's decoders to the export pipeline until the returned
  /// restore runs; `by` is who the surface says is using them meanwhile.
  suspendForExport(by: PreviewSuspendedBy): () => void;
  /// Run the Pixi export pipeline. Resolves with the encoded MP4
  /// bytes; rejects on failure. App.tsx owns the save dialog + file
  /// write so the existing ExportPanel can drive the pipeline.
  runPixiExport(opts: {
    resourcePlan: import("../../shared/export-resources").ExportResourcePlan;
    finalizationToken: string;
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
    startUs?: number;
    endUs?: number;
    keyframeIntervalSec?: number;
    writeChunk: (data: ArrayBuffer) => Promise<void>;
    /// Cancels export, including pending Motif reads and captures.
    signal?: AbortSignal;
    /// Output bit depth (8 = existing pipeline; 10 = f16/WebGL2 + native-encode).
    bitDepth?: 8 | 10;
    /// Present ⇒ the worker packs frames to this format and streams them to
    /// the native ffmpeg sink instead of WebCodecs-encoding.
    nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
    /// Stills mode (`render_frames`): no encoder; each frame comes back as a JPEG.
    stills?: import("../render/worker/runExport").RunExportInit["stills"];
    onStill?: import("../render/worker/runExport").RunExportInit["onStill"];
    /// Per-media decode routing table (see render/exportDecodeRouting.ts).
    decodeRouting?: import("../render/exportDecodeRouting").ExportDecodeRouting;
  }): Promise<PixiExportResult>;
}

export const PreviewSurface = forwardRef<PreviewSurfaceHandle, Props>(
  function PreviewSurface(
    { hasContent, previewDecodableOf, visible = true },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    // Any composition will do — this decides only whether there is a project to
    // draw at all. WHICH composition is drawn is the preview's render target,
    // resolved inside `PixiPreview` (compositionAnchorStore.ts).
    const composition = useProjectStore((s) => compositionOrRoot(s.summary, null));

    const pixiRef = useRef<PixiPreviewHandle | null>(null);
    const [suspendedBy, setSuspendedBy] = useState<PreviewSuspendedBy | null>(null);
    // The wheel/middle-button view gestures bind HERE rather than inside
    // PixiPreview: this element is the one that contains the canvas AND every
    // overlay stacked on it, and the overlays are siblings of the Pixi host.
    // A callback ref, so the listeners attach when the surface mounts — a
    // ref object's identity never changes and would not re-run the effect.
    const [surface, setSurface] = useState<HTMLDivElement | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    usePreviewViewGestures(surface);

    useImperativeHandle(
      forwardedRef,
      (): PreviewSurfaceHandle => ({
        currentDecodeDevices() {
          return pixiRef.current?.currentDecodeDevices() ?? [];
        },
        play() {
          transportPlay();
        },
        pause() {
          transportPause();
        },
        seekTo(tUs: number) {
          transportSeek(tUs);
        },
        paused() {
          return !usePlaybackStore.getState().requestedPlaying;
        },
        refreshSources() {
          pixiRef.current?.refreshSources();
        },
        suspendForExport(by) {
          setSuspendedBy(by);
          const restore = pixiRef.current?.suspendForExport();
          return () => { restore?.(); setSuspendedBy(null); };
        },
        async runPixiExport(opts) {
          const handle = pixiRef.current;
          if (!handle) {
            throw new Error("Pixi preview is not initialized yet.");
          }
          return handle.runExport(opts);
        },
      }),
      [],
    );

    if (!hasContent) {
      return <span className="placeholder">{t("preview.empty_hint")}</span>;
    }
    if (!composition) {
      return (
        <div className="preview-loading" aria-live="polite">
          <span className="preview-spinner" aria-hidden="true" />
          <span className="placeholder">{t("preview.preparing")}</span>
        </div>
      );
    }

    return (
      <div
        ref={setSurface}
        className="preview-video"
        tabIndex={-1}
        onContextMenu={e => {
          if (!canEditCrop() && !canScaleLayer()) return;
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        <PixiErrorBoundary>
          <PixiPreview
            exportSuspended={suspendedBy !== null}
            ref={pixiRef}
            previewDecodableOf={previewDecodableOf}
            visible={visible}
          />
        </PixiErrorBoundary>
        {suspendedBy && <PreviewSuspendedNotice by={suspendedBy} />}
        {/* After the canvas so they stack above it; screen-space by design —
            see TransformGizmo.tsx. Skipped while the dock tab is hidden — an
            overlay would otherwise track a canvas nobody can see.
            The Text tool's click surface first: it must sit UNDER the gizmo
            host so an open inline editor stays clickable (TextToolOverlay.tsx).
            Grid and safe areas belong to the frame, under the selection's
            box and handles. */}
        {visible && <PreviewGridOverlayHost />}
        {visible && <TextToolOverlayHost />}
        {visible && <SafeAreaGuidesHost />}
        {visible && <TransformGizmoHost />}
        {visible && <CropOverlayHost />}
        {visible && <PreviewHandTool />}
        {visible && contextMenu && <PreviewContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
      </div>
    );
  },
);
