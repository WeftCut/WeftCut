import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";

import { type ProjectSummary } from "../ipc";
import { formatTimecode } from "../frames";
import { useOpenComposition } from "../state/projectStore";
import {
  focusedPlayheadUs,
  focusedRootUs,
  setPlayheadFromPreview,
} from "../state/playheadProjection";
import { AppTimecodeField } from "../components/AppTimecodeField";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "../preview/PreviewSurface";
import { PlayheadTimecode } from "../preview/PlayheadTimecode";
import { DroppedFramesIndicator } from "../preview/DroppedFramesIndicator";

interface PreviewSectionProps {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  summary: ProjectSummary | null;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onSeek: (tUs: number) => void;          // App's seekTo, in ROOT time
  onTogglePlay: () => void;
  previewDecodableOf: (id: string) => boolean;
  visible: boolean;
}

/// The preview quadrant: `PreviewSurface` plus the transport strip
/// (editable timecode, skip/play buttons, canvas + duration meta).
/// Owns the timecode-edit state — purely local to this transport UI.
/// `paused` stays App state (AgentMode also writes it) and arrives as
/// a prop with `onPausedChange` forwarded back up.
export function PreviewSection({
  previewRef,
  summary,
  paused,
  onPausedChange,
  onSeek,
  onTogglePlay,
  previewDecodableOf,
  visible,
}: PreviewSectionProps) {
  const { t } = useTranslation();
  // Timecode-edit state doubles as the field's seed value: capturing the
  // playhead at the moment editing opens (instead of live-updating the field
  // from a React-subscribed time) keeps the edit box stable during playback.
  const [tcEditUs, setTcEditUs] = useState<number | null>(null);
  // The transport and the meta line describe the OPEN composition — which is
  // also what the preview draws, so every time on this strip is that
  // composition's own clock and reaches the root-time seek through
  // `focusedRootUs`. `summary` stays for the project-wide bits.
  const comp = useOpenComposition();

  const fpsLabel =
    comp &&
    (comp.fps_den === 1
      ? t("project.fps_simple", { fps: comp.fps_num })
      : t("project.fps_rational", {
          fps: (comp.fps_num / comp.fps_den).toFixed(2),
        }));

  return (
    <section className="preview">
      <div id="video-surface" className="video-surface">
        <PreviewSurface
          ref={previewRef}
          hasContent={(summary?.layer_count ?? 0) > 0}
          onTimeUpdate={setPlayheadFromPreview}
          onPausedChange={onPausedChange}
          previewDecodableOf={previewDecodableOf}
          visible={visible}
        />
      </div>
      <div className="preview-transport" role="toolbar" aria-label="Preview transport">
        {tcEditUs !== null ? (
          <AppTimecodeField
            className="preview-timecode"
            valueUs={tcEditUs}
            fpsNum={comp?.fps_num ?? 30}
            fpsDen={comp?.fps_den ?? 1}
            autoFocus
            ariaLabel={t("transport.timecode_label")}
            onCommit={(us) => {
              setTcEditUs(null);
              void onSeek(focusedRootUs(us));
            }}
            onCancel={() => setTcEditUs(null)}
          />
        ) : (
          <PlayheadTimecode
            fpsNum={comp?.fps_num ?? 30}
            fpsDen={comp?.fps_den ?? 1}
            visible={visible}
            editHint={t("transport.timecode_edit_hint")}
            onActivate={() => setTcEditUs(focusedPlayheadUs())}
          />
        )}
        <div className="transport-buttons">
          <button
            type="button"
            onClick={() => onSeek(focusedRootUs(0))}
            title={t("transport.to_start_hint")}
            aria-label={t("transport.to_start_hint")}
          >
            <SkipBackIcon size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            title={t("transport.play_pause_hint")}
            aria-label={t("transport.play_pause_hint")}
            disabled={(summary?.layer_count ?? 0) === 0}
          >
            {paused ? (
              <PlayIcon size={16} aria-hidden />
            ) : (
              <PauseIcon size={16} aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => onSeek(focusedRootUs(comp?.duration_us ?? 0))}
            title={t("transport.to_end_hint")}
            aria-label={t("transport.to_end_hint")}
            disabled={!comp || comp.duration_us === 0}
          >
            <SkipForwardIcon size={16} aria-hidden />
          </button>
        </div>
        <span className="preview-meta-cell">
          <DroppedFramesIndicator />
          <span className="preview-meta" aria-hidden="true">
            {comp && (
              <>
                {t("project.canvas", {
                  width: comp.width,
                  height: comp.height,
                  fps: fpsLabel,
                })}
                {" · "}
                {t("project.duration", {
                  value: formatTimecode(comp.duration_us, comp.fps_num, comp.fps_den),
                })}
              </>
            )}
          </span>
        </span>
      </div>
    </section>
  );
}
