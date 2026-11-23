import { readLayerParamTrack } from "../keyframe/channels";
import type { SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { StepBack, StepForward, CircleSmall } from "lucide-react";
import type { Keyframe, TrackSummary } from "../ipc";
import { type ParamTrack } from "../keyframe/descriptors";
import { keyAt, prevKeyAt, nextKeyAt, resolveNavLayer } from "../keyframe/nav";
import { upsertKeyframe, removeKeyframe, type TrackValue } from "../keyframe/edits";
import { resolveParamTrack } from "../keyframe/autoKey";
import { snapFrameRound } from "../frames";
import { transportSeek } from "../state/playbackStore";
import { setKeyframeFocus, useKeyframeFocusStore } from "../keyframe/focusStore";
import { useSelectKeyframe } from "./keyframeBatch";
import { AppIcon } from "@/components/AppIcon";

function stopPropagation(e: SyntheticEvent): void {
  e.stopPropagation();
}

/// AE-style per-property keyframe navigator (prev / set / next) for one
/// sub-lane row. Acts on a single resolved clip (focused clip → sole keyframed
/// clip → disabled, per `resolveNavLayer`): the prev/next buttons seek the
/// playhead to the adjacent key (and select+focus it); the middle button
/// toggles a key at the frame-snapped playhead.
/// Pure-frontend — every mutation goes through `onCommitParamTrack`
/// (→ updateLayerParamTrack), one click = one undo step.
///
/// Value-type agnostic: the added key holds whatever the track resolves to at
/// the playhead, so a colour row toggles a colour key through the OkLab leaf
/// exactly as a numeric row toggles a number.
export function KeyframeNavigator({
  track,
  paramKey,
  fallback,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  paramKey: string;
  /// The param's unkeyed value, and the witness for its value type
  /// (`resolveParamTrack`).
  fallback: TrackValue;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  /// The timeline's one commit sink, typed over the value union: a colour row
  /// hands it a colour track.
  onCommitParamTrack: (layerId: string, paramKey: string, t: ParamTrack) => void;
}) {
  const { t } = useTranslation();
  // Atomic primitive selector (per the zustand composite-selector rule).
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);
  const selectKey = useSelectKeyframe();

  const layer = resolveNavLayer(track, paramKey, focusedLayerId);
  const trk: ParamTrack | null = layer ? readLayerParamTrack(layer, paramKey) : null;
  const keyed = trk && trk.mode === "Keyframed" ? trk : null;

  // 0 is a safe dummy when there's no target layer — every query below guards
  // on `keyed` (null whenever `layer` is null), so it's never actually read.
  const tLocalUs = layer ? snapFrameRound(currentTimeUs - layer.t_start_us, fpsNum, fpsDen) : 0;
  const inSpan = layer != null && tLocalUs >= 0 && tLocalUs <= layer.t_end_us - layer.t_start_us;

  const at = keyed ? keyAt(keyed, tLocalUs) : null;
  const prev = keyed ? prevKeyAt(keyed, tLocalUs) : null;
  const next = keyed ? nextKeyAt(keyed, tLocalUs) : null;

  const seekTo = (kf: Keyframe<TrackValue>) => {
    if (!layer) return;
    selectKey({ layerId: layer.id, paramKey, kfId: kf.id });
    setKeyframeFocus(layer.id, paramKey);
    transportSeek(layer.t_start_us + kf.t_us);
  };

  const onToggle = () => {
    if (!layer || !keyed) return;
    if (at) {
      onCommitParamTrack(layer.id, paramKey, removeKeyframe(keyed, at.id, fallback));
    } else if (inSpan) {
      onCommitParamTrack(
        layer.id,
        paramKey,
        upsertKeyframe(keyed, tLocalUs, resolveParamTrack(keyed, tLocalUs, fallback)),
      );
    }
  };

  // The buttons live inside the timeline root, whose onClick deselects the
  // current layer. Stop the bubble so navigating keys doesn't clear selection.
  return (
    <div className="flex flex-none items-center gap-0.5" onClick={stopPropagation} onPointerDown={stopPropagation}>
      <button
        type="button"
        data-testid="kf-nav-prev"
        className="anim-stopwatch"
        disabled={!keyed || !prev}
        title={t("keyframe.nav_prev")}
        aria-label={t("keyframe.nav_prev")}
        onClick={() => prev && seekTo(prev)}
      >
        <AppIcon icon={StepBack} size="body" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="kf-nav-set"
        // is-lit (amber) marks "a key sits on the playhead" — same active-state
        // convention as the inspector stopwatch (AnimatableField).
        className={`anim-stopwatch${at ? " is-lit" : ""}`}
        disabled={!keyed || (!at && !inSpan)}
        aria-pressed={at != null}
        title={t("keyframe.nav_set")}
        aria-label={t("keyframe.nav_set")}
        onClick={onToggle}
      >
        <AppIcon icon={CircleSmall} size="heading" fill={at ? "currentColor" : "none"} aria-hidden />
      </button>
      <button
        type="button"
        data-testid="kf-nav-next"
        className="anim-stopwatch"
        disabled={!keyed || !next}
        title={t("keyframe.nav_next")}
        aria-label={t("keyframe.nav_next")}
        onClick={() => next && seekTo(next)}
      >
        <AppIcon icon={StepForward} size="body" aria-hidden />
      </button>
    </div>
  );
}
