// The discovery/read seam for every keyframe editing surface. Addresses are
// the existing mutation keys; consumers never interpret an effect path or
// maintain a second list of supported properties. No React or GPU imports.
import type { AnimTrack, EffectView, LayerSummary, Rgba } from "../ipc";
import { VISUAL_EFFECT_PARAMS } from "../../shared/effects/params";
import {
  animatableParams, readParamTrack, readPositionMode, readScaleLinked,
  type NumberParamDescriptor, type ParamDescriptor, type ParamTrack,
  type RgbaParamDescriptor,
} from "./descriptors";

export function effectParamDescriptor(
  effect: Pick<EffectView, "id" | "kind">,
  param: string,
): NumberParamDescriptor | null {
  const spec = VISUAL_EFFECT_PARAMS[effect.kind]?.[param];
  if (!spec) return null;
  return {
    valueKind: "number",
    paramKey: `effects[${effect.id}].params[${param}]`,
    labelKey: `effects.${effect.kind}.params.${param}`,
    labelFallback: param,
    fallback: spec.default,
    min: spec.range[0], max: spec.range[1],
    step: spec.step ?? (spec.range[1] - spec.range[0] <= 10 ? 0.1 : 1),
    widgets: ["number"],
  };
}

/** Includes unmaterialized effect defaults. Hidden scale twins are available
 *  to editing/clipboard queries, but not to presentation discovery. */
export function layerParams(layer: LayerSummary, includeHiddenScale = false): ParamDescriptor[] {
  const descriptors = animatableParams(
    layer.kind, !includeHiddenScale && readScaleLinked(layer.params), readPositionMode(layer.params),
  );
  for (const [index, effect] of (layer.effects ?? []).entries()) {
    for (const param of Object.keys(VISUAL_EFFECT_PARAMS[effect.kind] ?? {})) {
      const desc = effectParamDescriptor(effect, param)!;
      descriptors.push({
        ...desc,
        owner: {
          labelKey: `effects.${effect.kind}.name`, name: effect.kind,
          ordinal: index + 1, layerLabel: layer.label ?? layer.id,
        },
      });
    }
  }
  return descriptors;
}

export function readLayerParamTrack(layer: LayerSummary, desc: NumberParamDescriptor): AnimTrack<number> | null;
export function readLayerParamTrack(layer: LayerSummary, desc: RgbaParamDescriptor): AnimTrack<Rgba> | null;
export function readLayerParamTrack(layer: LayerSummary, key: string | ParamDescriptor): ParamTrack | null;
export function readLayerParamTrack(layer: LayerSummary, key: string | ParamDescriptor): ParamTrack | null {
  const paramKey = typeof key === "string" ? key : key.paramKey;
  const effectPath = /^effects\[([^\]]+)\]\.params\[([^\]]+)\]$/.exec(paramKey);
  if (effectPath) {
    const effect = layer.effects?.find((e) => e.id === effectPath[1]);
    if (!effect) return null;
    const desc = effectParamDescriptor(effect, effectPath[2]!);
    return desc ? effect.params[effectPath[2]!] ?? { mode: "Static", value: desc.fallback } : null;
  }
  return readParamTrack(layer.params, paramKey);
}

/** One row per address, ordered by parameter definitions, with metadata from
 *  the first layer actually animating it (important for linked Scale). */
export function keyframedParams(layers: readonly LayerSummary[]): ParamDescriptor[] {
  const order = new Set<string>();
  const keyed = new Map<string, ParamDescriptor>();
  for (const layer of layers) {
    for (const desc of layerParams(layer)) {
      order.add(desc.paramKey);
      if (!keyed.has(desc.paramKey) && readLayerParamTrack(layer, desc)?.mode === "Keyframed") {
        keyed.set(desc.paramKey, desc);
      }
    }
  }
  return [...order].flatMap((key) => keyed.has(key) ? [keyed.get(key)!] : []);
}
