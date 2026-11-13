import { CropOverlayHost } from './CropOverlay';
import { PreviewContextMenu } from './PreviewContextMenu';
import { canEditCrop } from '../commands/cropCommands';
import { canScaleLayer } from '../commands/scaleCommands';
import { transportPlay, transportPause, transportSeek, usePlaybackStore } from "../state/playbackStore";
/// Project preview surface. Renders the project through the Pixi
/// compositor (the only preview path) inside a PixiErrorBoundary, or an
/// empty-state / loading placeholder when there is no content or no
/// composition yet. Forwards play/pause/seek/refresh to the
/// underlying PixiPreview.

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { compositionOrRoot, useProjectStore } from "../state/projectStore";
import { PixiPreview } from "../render/PixiPreview";
import type { PixiPreviewHandle } from "../render/pixiPreviewFlag";
import { useExportPreviewSuspension } from "../render/exportPreviewSuspension";
import { PixiErrorBoundary } from "../render/PixiErrorBoundary";
import { SafeAreaGuidesHost } from "./SafeAreaGuides";
import { TextToolOverlayHost } from "./TextToolOverlay";
import { TransformGizmoHost } from "./TransformGizmo";
import { PreviewHandTool } from "./PreviewHandTool";
import { PreviewSuspendedNotice } from "./PreviewSuspendedNotice";
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
  editingLocked?: boolean;
  backgroundExportActive?: boolean;
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
}

export const PreviewSurface = forwardRef<PreviewSurfaceHandle, Props>(
  function PreviewSurface(
    { hasContent, previewDecodableOf, visible = true, editingLocked = false, backgroundExportActive = false },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    // Any composition will do — this decides only whether there is a project to
    // draw at all. WHICH composition is drawn is the preview's render target,
    // resolved inside `PixiPreview` (compositionAnchorStore.ts).
    const composition = useProjectStore((s) => compositionOrRoot(s.summary, null));

    const pixiRef = useRef<PixiPreviewHandle | null>(null);
    const suspendedBy = useExportPreviewSuspension(s => s.by);
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
        onContextMenu={e => {
          if (editingLocked || !canEditCrop() && !canScaleLayer()) return;
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
            backgroundExportActive={backgroundExportActive}
            ref={pixiRef}
            previewDecodableOf={previewDecodableOf}
            visible={visible}
          />
        </PixiErrorBoundary>
        {suspendedBy && <PreviewSuspendedNotice by={suspendedBy} preparing={backgroundExportActive} />}
        {/* After the canvas so they stack above it; screen-space by design —
            see TransformGizmo.tsx. Skipped while the dock tab is hidden — an
            overlay would otherwise track a canvas nobody can see.
            The Text tool's click surface first: it must sit UNDER the gizmo
            host so an open inline editor stays clickable (TextToolOverlay.tsx).
            Then safe areas: chrome about the frame, so they paint under the
            selection's box and handles. */}
        {visible && !editingLocked && <TextToolOverlayHost />}
        {visible && <SafeAreaGuidesHost />}
        {visible && !editingLocked && <TransformGizmoHost />}
        {visible && !editingLocked && <CropOverlayHost />}
        {visible && <PreviewHandTool />}
        {visible && !editingLocked && contextMenu && <PreviewContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
      </div>
    );
  },
);
