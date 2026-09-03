import type { SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, LayerSummary, Rgba, TrackSummary } from "../ipc";
import {
  readNumberTrack,
  readRgbaTrack,
  type NumberParamDescriptor,
  type ParamDescriptor,
  type ParamTrack,
  type RgbaParamDescriptor,
} from "../keyframe/descriptors";
import { resolveNavLayer } from "../keyframe/nav";
import { snapFrameRound } from "../frames";
import { useKeyframeFocusStore } from "../keyframe/focusStore";
import { AppColorField, hexToRgba, rgbaToHex } from "../components/AppColorField";
import { displayValue } from "../components/AnimatableField";
import { autoKeyTrack } from "../keyframe/autoKey";
import { resolveAnimatedColor } from "../render/animated";
import { KeyframeField } from "../components/KeyframeField";

function stopPropagation(e: SyntheticEvent): void {
  e.stopPropagation();
}

/// Where the row's value field writes: the timeline's one keyframe commit sink,
/// typed over the value union because a colour row hands it a colour track.
interface CommitSink {
  onCommitParamTrack: (layerId: string, paramKey: string, t: ParamTrack) => void;
}

/// The editable value for one expanded sub-lane row: the property's value at
/// the frame-snapped playhead, with no stopwatch — a compact number field for a
/// numeric property, the colour swatch for a colour one. Acts on the same
/// resolved clip as the row's navigator (resolveNavLayer → focused clip / sole
/// keyframed clip / none). Editing creates/updates a key at the playhead
/// through the timeline's onCommitParamTrack (one undo step).
export function KeyframeValueField({
  track,
  desc,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  desc: ParamDescriptor;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
} & CommitSink) {
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);
  const layer = resolveNavLayer(track, desc.paramKey, focusedLayerId);
  if (!layer) return null;

  const tLocalUs = snapFrameRound(currentTimeUs - layer.t_start_us, fpsNum, fpsDen);
  const inSpan = tLocalUs >= 0 && tLocalUs <= layer.t_end_us - layer.t_start_us;
  const common = { layerId: layer.id, tLocalUs, inSpan, onCommitParamTrack };

  return desc.valueKind === "rgba"
    ? <ColorValueRow {...common} desc={desc} params={layer.params} />
    : <NumberValueRow {...common} desc={desc} params={layer.params} />;
}

/// The timeline root's onClick clears the layer selection; stop the bubble so
/// editing the value doesn't deselect (same guard as KeyframeNavigator).
const ROW_PROPS = { className: "kf-value-row mx-auto w-20", onClick: stopPropagation, onPointerDown: stopPropagation };

function NumberValueRow({
  layerId,
  params,
  desc,
  tLocalUs,
  inSpan,
  onCommitParamTrack,
}: {
  layerId: string;
  params: LayerSummary["params"];
  desc: NumberParamDescriptor;
  tLocalUs: number;
  inSpan: boolean;
} & CommitSink) {
  const { t } = useTranslation();
  const trk = readNumberTrack(params, desc);
  if (!trk || trk.mode !== "Keyframed") return null;
  // exactOptionalPropertyTypes rejects passing `undefined` for `?: number`
  // props, so spread step/min/max only when set (mirrors InspectorAnimField).
  const bounds = {
    ...(desc.step !== undefined ? { step: desc.step } : {}),
    ...(desc.min !== undefined ? { min: desc.min } : {}),
    ...(desc.max !== undefined ? { max: desc.max } : {}),
  };
  return (
    <div {...ROW_PROPS}>
      <KeyframeField
        layerId={layerId}
        paramKey={desc.paramKey}
        label={t(desc.labelKey, { defaultValue: desc.paramKey })}
        track={trk}
        fallback={desc.fallback}
        tInLayerUs={tLocalUs}
        playheadInSpan={inSpan}
        onCommitTrack={(k, next) => onCommitParamTrack(layerId, k, next)}
        widgets={["number"]}
        {...bounds}
        showStopwatch={false}
        compact
      />
    </div>
  );
}

/// The colour row's compact field: the same swatch the inspector shows, bound
/// to the same auto-key rule, with the eyedropper dropped — the header cell is
/// 80px wide and the inspector row is where a pick belongs.
function ColorValueRow({
  layerId,
  params,
  desc,
  tLocalUs,
  inSpan,
  onCommitParamTrack,
}: {
  layerId: string;
  params: LayerSummary["params"];
  desc: RgbaParamDescriptor;
  tLocalUs: number;
  inSpan: boolean;
} & CommitSink) {
  const { t } = useTranslation();
  const trk: AnimTrack<Rgba> | null = readRgbaTrack(params, desc);
  if (!trk || trk.mode !== "Keyframed") return null;
  const shown = displayValue(trk, tLocalUs, desc.fallback, resolveAnimatedColor);
  const label = t(desc.labelKey, { defaultValue: desc.paramKey });
  return (
    <div {...ROW_PROPS}>
      <div className="kf-value-field kf-value-field--compact">
        <AppColorField
          value={rgbaToHex(shown)}
          ariaLabel={label}
          disabled={!inSpan}
          withEyeDropper={false}
          onValueChange={(hex) =>
            onCommitParamTrack(layerId, desc.paramKey, autoKeyTrack(trk, tLocalUs, hexToRgba(hex, shown.a)))
          }
        />
      </div>
    </div>
  );
}
