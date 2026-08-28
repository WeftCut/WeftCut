import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";

import { type ProjectSummary } from "../ipc";
import { formatTimecode } from "../frames";
import {
  setPreviewRenderTarget,
  usePreviewRenderTargetId,
  usePreviewTargetChoice,
} from "../state/compositionAnchorStore";
import {
  useComposition,
  useCompositionRefCounts,
  useGroupOrdinals,
  useProjectSummary,
} from "../state/projectStore";
import {
  previewClockUs,
  seekPreviewLocalUs,
  setPlayheadFromPreview,
} from "../state/playheadProjection";
import { AppSelect } from "../components/AppSelect";
import { AppTimecodeField } from "../components/AppTimecodeField";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "../preview/PreviewSurface";
import {
  previewTargetOptions,
  targetOptionChoice,
  targetOptionValue,
} from "../preview/previewTargetOptions";
import { PlayheadTimecode } from "../preview/PlayheadTimecode";
import { DroppedFramesIndicator } from "../preview/DroppedFramesIndicator";

interface PreviewSectionProps {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  summary: ProjectSummary | null;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onTogglePlay: () => void;
  previewDecodableOf: (id: string) => boolean;
  visible: boolean;
}

/// The preview quadrant: the render-target control, `PreviewSurface`, and the
/// transport strip (editable timecode, skip/play buttons, canvas + duration
/// meta). Owns the timecode-edit state — purely local to this transport UI.
/// `paused` stays App state (AgentMode also writes it) and arrives as
/// a prop with `onPausedChange` forwarded back up.
export function PreviewSection({
  previewRef,
  summary,
  paused,
  onPausedChange,
  onTogglePlay,
  previewDecodableOf,
  visible,
}: PreviewSectionProps) {
  const { t } = useTranslation();
  // Timecode-edit state doubles as the field's seed value: capturing the
  // playhead at the moment editing opens (instead of live-updating the field
  // from a React-subscribed time) keeps the edit box stable during playback.
  const [tcEditUs, setTcEditUs] = useState<number | null>(null);
  // The transport and the meta line describe what is ON THE CANVAS — the render
  // target, which is the composition being edited only while the preview
  // follows focus. Every time on this strip is therefore that composition's own
  // clock, and reaches the one moment through `seekPreviewLocalUs`. `summary`
  // stays for the project-wide bits.
  const comp = useComposition(usePreviewRenderTargetId());

  const fpsLabel =
    comp &&
    (comp.fps_den === 1
      ? t("project.fps_simple", { fps: comp.fps_num })
      : t("project.fps_rational", {
          fps: (comp.fps_num / comp.fps_den).toFixed(2),
        }));

  return (
    <section className="preview">
      {/* A toolbar row, not a header bar — the Panel's title is its dock tab. */}
      <div className="preview-target-bar">
        <RenderTargetControl />
      </div>
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
              seekPreviewLocalUs(us);
            }}
            onCancel={() => setTcEditUs(null)}
          />
        ) : (
          <PlayheadTimecode
            fpsNum={comp?.fps_num ?? 30}
            fpsDen={comp?.fps_den ?? 1}
            visible={visible}
            editHint={t("transport.timecode_edit_hint")}
            onActivate={() => setTcEditUs(previewClockUs())}
          />
        )}
        <div className="transport-buttons">
          <button
            type="button"
            onClick={() => seekPreviewLocalUs(0)}
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
            onClick={() => seekPreviewLocalUs(comp?.duration_us ?? 0)}
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

/// What the preview renders: *follow focus*, or one named composition it holds
/// on to while the keyboard edits somewhere else (ADR 0053 decision 3).
///
/// Shows the raw CHOICE rather than the resolved target, so following reads as
/// following rather than as whichever composition happens to have focus.
function RenderTargetControl() {
  const { t } = useTranslation();
  const summary = useProjectSummary();
  const ordinals = useGroupOrdinals();
  const refCounts = useCompositionRefCounts();
  const choice = usePreviewTargetChoice();
  const panelTitle = t("dock_workspace.panels.timeline");
  const options = useMemo(
    () => previewTargetOptions(summary, ordinals, refCounts, panelTitle, t),
    [summary, ordinals, refCounts, panelTitle, t],
  );
  return (
    <AppSelect
      className="preview-target-select"
      ariaLabel={t("preview.target_label")}
      value={targetOptionValue(choice)}
      onValueChange={(value) => setPreviewRenderTarget(targetOptionChoice(value))}
      options={options.map((option) => ({
        value: targetOptionValue(option.compositionId),
        label: option.unused ? (
          // The media pool's own treatment of an orphan, down to the word: a
          // dimmed row carrying an `unused` badge.
          <span className="flex min-w-0 items-center gap-2 opacity-55">
            <span className="min-w-0 truncate">{option.label}</span>
            <span
              data-testid="preview-target-unused"
              className="shrink-0 rounded bg-amber-500/20 px-1 text-[9px] font-semibold uppercase text-amber-200"
            >
              {t("media_pool.groups_unused")}
            </span>
          </span>
        ) : (
          option.label
        ),
      }))}
    />
  );
}
