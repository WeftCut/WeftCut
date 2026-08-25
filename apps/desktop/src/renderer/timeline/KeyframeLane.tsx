import {
  useCallback,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, TrackSummary } from "../ipc";
import { trackKeyframeProperties } from "./geometry";
import {
  readParamTrack,
  isHiddenTwinAxis,
  type ParamDescriptor,
} from "../keyframe/descriptors";
import {
  selectKeyframe,
  keyframeKey,
  useIsKeyframeSelected,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";
import { retimeKeyframe, setKeyframeInterp } from "../keyframe/edits";
import { useKeyframeBatchCommit } from "./keyframeBatch";
import { transportSeek } from "../state/playbackStore";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import {
  setKeyframeFocus,
  useFocusedParamKeyForTrackLayers,
  useKeyframeFocusStore,
} from "../keyframe/focusStore";
import { useMarqueeAnchor } from "./hooks/useMarqueeAnchor";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";
import { EasingMenu } from "./EasingMenu";
import { KeyframeNavigator } from "./KeyframeNavigator";
import { KeyframeValueField } from "./KeyframeValueField";

export const KF_SUBLANE_H = 24;
export const KF_SUBLANE_EXPANDED_H = 72;

/// Hands one rendered sub-lane row to the registry the Timeline measures the
/// marquee against — the keyframe twin of `registerLaneEl`, keyed by
/// `(trackId, paramKey)`. `expanded` rides along because the ROW is where that
/// answer lives; `null` deregisters.
export type RegisterSubLaneEl = (
  trackId: string,
  paramKey: string,
  expanded: boolean,
  el: HTMLElement | null,
) => void;

type OpenInterpMenu = (
  clientX: number,
  clientY: number,
  layerId: string,
  paramKey: string,
  kfId: string,
) => void;

/// Header-column rows: each property's keyframe navigator (◄ ◆ ►) on the left,
/// the property-name label right-aligned. Row-aligned with the body rows below
/// by sharing trackKeyframeProperties + KF_SUBLANE_H.
export function KeyframeLaneHeaders({
  track,
  fpsNum,
  fpsDen,
  visible,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  fpsNum: number;
  fpsDen: number;
  visible: boolean;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  // Panel-rate playhead subscription (tier 3, playheadStore.ts): navigator
  // arrows + value readouts follow playback without per-frame re-renders.
  const currentTimeUs = usePlayheadTimeUsThrottled(100, visible);
  const props = trackKeyframeProperties(track);
  const layerIds = useMemo(() => new Set(track.layers.map((l) => l.id)), [track.layers]);
  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  return (
    <>
      {props.map((d) => {
        const expanded = d.paramKey === focusedParamKey;
        return (
          <div
            key={d.paramKey}
            className="border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
            style={{ height: expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
          >
            <div className="flex items-center justify-between gap-1" style={{ height: KF_SUBLANE_H }}>
              <span className="min-w-0 truncate">{t(d.labelKey, { defaultValue: d.paramKey })}</span>
              <KeyframeNavigator
                track={track}
                paramKey={d.paramKey}
                fallback={d.fallback}
                currentTimeUs={currentTimeUs}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                onCommitParamTrack={onCommitParamTrack}
              />
            </div>
            {expanded && (
              <KeyframeValueField
                track={track}
                desc={d}
                currentTimeUs={currentTimeUs}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                onCommitParamTrack={onCommitParamTrack}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/// Body rows: one diamond lane per property, diamonds absolute-positioned.
export function KeyframeLane({
  track,
  pxPerSec,
  registerSubLaneEl,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  pxPerSec: number;
  registerSubLaneEl: RegisterSubLaneEl;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const props = trackKeyframeProperties(track);
  const [interpMenu, setInterpMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    paramKey: string;
    kfId: string;
  } | null>(null);

  // A right-click that lands OUTSIDE the selection replaces it with that one
  // key first, so the menu acts on what the user aimed at — the rule
  // `Timeline`'s clip `onContextMenu` states in full. The diamond path arrives
  // already selected (`KeyframeCurveGraph` selects before it opens the menu);
  // this is what covers the segment path, which selects nothing.
  const openInterpMenu: OpenInterpMenu = (clientX, clientY, layerId, paramKey, kfId) => {
    const key = { layerId, paramKey, kfId };
    if (!useKeyframeSelectionStore.getState().selected.has(keyframeKey(key))) {
      selectKeyframe(key);
    }
    setInterpMenu({ x: clientX, y: clientY, layerId, paramKey, kfId });
  };

  const layerIds = useMemo(
    () => new Set(track.layers.map((l) => l.id)),
    [track.layers],
  );
  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  const focusedLayerId = useKeyframeFocusStore((s) =>
    s.layerId && layerIds.has(s.layerId) ? s.layerId : null,
  );

  // A box started on a sub-lane row sweeps KEYFRAMES, not the clips it is drawn
  // over — the surface decides, so one handler serves every row. Diamonds and
  // segment hits stop their own pointerdown, leaving the row's background.
  const { onPointerDown: onMarqueeDown } = useMarqueeAnchor({
    kind: "keyframe",
  });
  const commitKeyframeBatch = useKeyframeBatchCommit();

  return (
    <>
      {props.map((d) => (
        <KeyframeSubLaneRow
          key={d.paramKey}
          track={track}
          desc={d}
          expanded={d.paramKey === focusedParamKey}
          pxPerSec={pxPerSec}
          focusedLayerId={focusedLayerId}
          registerSubLaneEl={registerSubLaneEl}
          onPointerDown={onMarqueeDown}
          onCommitParamTrack={onCommitParamTrack}
          onOpenInterpMenu={openInterpMenu}
        />
      ))}
      {interpMenu && (() => {
        const layer = track.layers.find((l) => l.id === interpMenu.layerId);
        if (!layer) return null;
        const trk = readParamTrack(layer.params, interpMenu.paramKey);
        if (!trk || trk.mode !== "Keyframed") return null;
        return (
          <EasingMenu
            x={interpMenu.x}
            y={interpMenu.y}
            track={trk}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onApply={commitKeyframeBatch}
          />
        );
      })()}
    </>
  );
}

/// One property's row, drawing that property's curve for every layer on the
/// track. A component rather than inline JSX so the registry ref can be a
/// `useCallback` stable per (property, expanded), the way `TrackLane`'s
/// `laneRef` is: an inline ref would churn the registry through null on every
/// render of the timeline above it.
function KeyframeSubLaneRow({
  track,
  desc,
  expanded,
  pxPerSec,
  focusedLayerId,
  registerSubLaneEl,
  onPointerDown,
  onCommitParamTrack,
  onOpenInterpMenu,
}: {
  track: TrackSummary;
  desc: ParamDescriptor;
  expanded: boolean;
  pxPerSec: number;
  focusedLayerId: string | null;
  registerSubLaneEl: RegisterSubLaneEl;
  onPointerDown: (e: ReactPointerEvent) => void;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
  onOpenInterpMenu: OpenInterpMenu;
}) {
  const paramKey = desc.paramKey;
  const height = expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H;
  const rowRef = useCallback(
    (el: HTMLDivElement | null) =>
      registerSubLaneEl(track.id, paramKey, expanded, el),
    [registerSubLaneEl, track.id, paramKey, expanded],
  );
  return (
    <div
      ref={rowRef}
      data-testid="kf-sublane"
      className="relative border-b border-border-soft"
      style={{ height }}
      onPointerDown={onPointerDown}
    >
      {track.layers.map((layer) => {
        if (isHiddenTwinAxis(paramKey, layer.params)) return null;
        const trk = readParamTrack(layer.params, paramKey);
        if (!trk || trk.mode !== "Keyframed") return null;
        return (
          <LayerCurveLane
            key={layer.id}
            layerId={layer.id}
            paramKey={paramKey}
            track={trk}
            layerTStartUs={layer.t_start_us}
            clipDurationUs={layer.t_end_us - layer.t_start_us}
            pxPerSec={pxPerSec}
            height={height}
            editable={expanded && focusedLayerId === layer.id}
            onCommitParamTrack={onCommitParamTrack}
            onOpenInterpMenu={onOpenInterpMenu}
          />
        );
      })}
    </div>
  );
}

function LayerCurveLane({
  layerId, paramKey, track, layerTStartUs, clipDurationUs, pxPerSec, height,
  editable, onCommitParamTrack, onOpenInterpMenu,
}: {
  layerId: string;
  paramKey: string;
  track: Extract<AnimTrack<number>, { mode: "Keyframed" }>;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
  editable: boolean;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
  onOpenInterpMenu: OpenInterpMenu;
}) {
  const isSelected = useIsKeyframeSelected(layerId, paramKey);
  return (
    <KeyframeCurveGraph
      track={track}
      layerTStartUs={layerTStartUs}
      clipDurationUs={clipDurationUs}
      pxPerSec={pxPerSec}
      height={height}
      editable={editable}
      isSelected={isSelected}
      onSelectSeek={(kfId) => {
        const kf = track.value.find((k) => k.id === kfId);
        if (!kf) return;
        selectKeyframe({ layerId, paramKey, kfId });
        setKeyframeFocus(layerId, paramKey);
        transportSeek(layerTStartUs + kf.t_us);
      }}
      onRetime={(kfId, newTUs) =>
        onCommitParamTrack(layerId, paramKey, retimeKeyframe(track, kfId, newTUs))
      }
      onSetInterp={(kfId, interp) =>
        onCommitParamTrack(layerId, paramKey, setKeyframeInterp(track, kfId, interp))
      }
      onOpenMenu={(cx, cy, kfId) => onOpenInterpMenu(cx, cy, layerId, paramKey, kfId)}
    />
  );
}
