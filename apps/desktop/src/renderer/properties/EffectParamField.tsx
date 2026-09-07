import { useTranslation } from "react-i18next";
import { isAudioKind } from "../../shared/audioEffects/catalog";
import { KeyframeField } from "../components/KeyframeField";
import { tryMutate } from "../errors/tryMutate";
import { updateLayerParamTrack, type AnimTrack, type EffectView, type LayerSummary } from "../ipc";
import {
  effectI18nBase,
  type UiEffectDescriptor,
  type UiEffectParamSpec,
} from "../render/effects/effectRegistry";

/// One row per catalog param of `effect`, reusing the shared KeyframeField
/// (stopwatch + auto-key) exactly like the transform/opacity rows. The wire key
/// is `effects[<id>].params[<key>]`, which `update_layer_param_track` resolves
/// and lazily creates on first write.
///
/// A null descriptor — an unknown kind — renders no params. A region pair
/// renders none either: those two keys are one `AudioRegionRow`, not two number
/// fields, so the card owns them.
export function EffectParamFields({
  layer,
  effect,
  descriptor,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  descriptor: UiEffectDescriptor | null;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  if (!descriptor) return null;
  const regionKeys = descriptor.region
    ? [descriptor.region.inKey, descriptor.region.outKey]
    : [];
  const i18nBase = effectI18nBase(descriptor);
  return (
    <>
      {Object.entries(descriptor.params)
        .filter(([key]) => !regionKeys.includes(key))
        .map(([key, spec]) => (
          <EffectParamField
            key={key}
            layer={layer}
            effect={effect}
            paramName={key}
            spec={spec}
            i18nBase={i18nBase}
            tInLayerUs={tInLayerUs}
            playheadInSpan={playheadInSpan}
            onMutated={onMutated}
          />
        ))}
    </>
  );
}

function EffectParamField({
  layer,
  effect,
  paramName,
  spec,
  i18nBase,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  paramName: string;
  spec: UiEffectParamSpec;
  i18nBase: string;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const paramKey = `effects[${effect.id}].params[${paramName}]`;
  // Absent slot ⇒ the catalog default.
  const track: AnimTrack<number> = effect.params[paramName] ?? { mode: "Static", value: spec.default };
  const name = t(`${i18nBase}.params.${paramName}`, { defaultValue: paramName });
  // The unit rides in the label, as `property_panel.gain_db` already does —
  // one string to read, and no per-row chrome to style.
  const label = spec.unit === "dB" ? `${name} (dB)` : name;
  const step = spec.step ?? (spec.range && spec.range[1] - spec.range[0] <= 10 ? 0.1 : 1);
  // An audio effect is an offline whole-clip bake, so its params are static by
  // construction (spec Decision 11) — no stopwatch, and no playhead gate
  // either: there is no "off-clip" for a value that applies to the whole clip.
  const audio = isAudioKind(effect.kind);
  const commit = async (k: string, next: AnimTrack<number>) => {
    await tryMutate(
      () => updateLayerParamTrack(layer.id, k, next).then(onMutated),
      "Edit effect parameter",
    );
  };
  const field = (
    <KeyframeField
      layerId={layer.id}
      paramKey={paramKey}
      label={label}
      track={track}
      fallback={spec.default}
      tInLayerUs={tInLayerUs}
      playheadInSpan={audio ? true : playheadInSpan}
      onCommitTrack={commit}
      onMutated={onMutated}
      widgets={["number"]}
      step={step}
      {...(spec.range ? { min: spec.range[0], max: spec.range[1] } : {})}
      {...(audio ? { showStopwatch: false } : {})}
    />
  );
  // Wrapper carries a stable testid (effect id + param) so the e2e can target
  // this exact field; KeyframeField/AppNumberField don't take a testid prop.
  // Without the stopwatch there is no AnimatableField to render the label, so
  // the audio row states it itself.
  return audio ? (
    <div className="prop-field prop-effect-param" data-testid={`effect-param-${effect.id}-${paramName}`}>
      <span className="prop-field-label">{label}</span>
      <div className="prop-field-control">{field}</div>
    </div>
  ) : (
    <div className="prop-effect-param" data-testid={`effect-param-${effect.id}-${paramName}`}>
      {field}
    </div>
  );
}
