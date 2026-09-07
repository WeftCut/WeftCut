// What an audio effect IS: the descriptor shape, the registry of kinds, and
// the reduction of a layer's stored `effects` array to the chain a bake will
// actually render. The single home shared by the main process (validation,
// baker, export injection) and the renderer (inspector cards, picker).
//
// Boundary: emits no ffmpeg text of its own (each descriptor's `buildStage`
// does, through graph.ts) and computes no signature (signature.ts). Nothing
// under this directory may import pixi.js, Electron or the DOM — main compiles
// it too — and only signature.ts may reach for Node.
//
// Adding an effect: one module beside denoise.ts, one line in AUDIO_EFFECTS.
// See ADR 0063 and docs/audio.md.

import type { Animated } from "../keyframe";
import type { BakeCtx, MeasurementRequest, StageLabels } from "./graph";
import { DENOISE } from "./denoise";

/// The `audio.*` namespace marker. An effect kind is audio if and only if it
/// starts with this, and that predicate — not catalog membership — is what the
/// command layer's namespace rule tests: an UNKNOWN `audio.*` kind must still
/// be refused on a visual layer (spec Decision 16), while unknown non-audio
/// kinds stay permissive (ADR 0027).
const AUDIO_KIND_PREFIX = "audio.";

/// The flattened, static-only param view an audio effect is evaluated against:
/// each catalog param's stored `Static` value, or its `default` when the layer
/// never wrote one — absent-means-default is the same contract the visual
/// registry uses.
///
/// A REGION key is the exception and stays absent when unwritten: "no sample
/// region yet" is exactly what `isComplete` refuses on, and a default would
/// silently invent one.
export type StaticParams = Readonly<Record<string, number | undefined>>;

/// One catalog param. `range` and `step` drive the inspector field only — the
/// mutation layer quantizes an effect param but deliberately enforces no range
/// on it (effect params live in their own namespace, see `quantizeEffectTrack`),
/// so a descriptor's bounds are guidance for the UI, never a validation gate.
export interface AudioEffectParamSpec {
  default: number;
  range: [number, number];
  step?: number;
  unit?: "dB" | "us";
}

/// Which two params carry the noise-profile sample span, and the shortest span
/// the filter can learn from. Bounds are SOURCE (media) time, so trim, slip,
/// move and split never invalidate a bake (spec Decision 3).
export interface AudioEffectRegion {
  inKey: string;
  outKey: string;
  minUs: number;
}

/// What the media side of a completeness test needs. `duration_us` is null on a
/// media item whose duration was never probed — a region cannot be bounded
/// against an unknown length, so such an effect reads incomplete.
export interface MediaBounds {
  duration_us: number | null;
}

export interface AudioEffectDescriptor {
  kind: `audio.${string}`;
  /// Bumped when this effect's GRAPH changes for unchanged params: it rides in
  /// the canonical chain string, so a bump invalidates every artifact baked
  /// from this kind and the baker re-renders them.
  version: number;
  nameI18nKey: string;
  descI18nKey: string;
  /// Picker grouping. Widens the visual registry's `EffectCategory` with the
  /// one audio group; presentational only.
  category: "audio";
  params: Record<string, AudioEffectParamSpec>;
  region?: AudioEffectRegion;
  /// Whether this effect can be rendered at all yet. An incomplete effect is
  /// dropped from the effective chain exactly as a disabled one is — the card
  /// says what is missing — because a half-configured filter that silently
  /// falls back to some default is "not what you heard" (spec Decision 9).
  isComplete(params: StaticParams, media: MediaBounds): boolean;
  /// One `-filter_complex` stage, from `labels.in` to `labels.out`. Called
  /// only for an entry `effectiveChain` returned, so it may treat every value
  /// `isComplete` proved present as present.
  buildStage(params: StaticParams, labels: StageLabels, ctx: BakeCtx): string;
  /// What must be read off the conform before `buildStage` can be called.
  measurements(params: StaticParams): MeasurementRequest[];
}

/// The stored shape of one `Layer.effects` entry, structurally — main's
/// `Effect` satisfies it. Restated rather than imported: src/shared/ is
/// referenced BY main's project, so importing main's model here would cycle.
export interface AudioEffectEntry {
  id: string;
  kind: string;
  enabled: boolean;
  params: Record<string, Animated<number>>;
}

/// One audio effect resolved for baking: the stored entry, the descriptor its
/// `kind` names, and the flattened params both the signature and the graph
/// read. Only `effectiveChain` mints one, so holding a `ChainEntry` is proof
/// the effect is enabled, known and complete.
export interface ChainEntry {
  effect: AudioEffectEntry;
  descriptor: AudioEffectDescriptor;
  params: StaticParams;
}

export type EffectiveChain = readonly ChainEntry[];

export const AUDIO_EFFECTS: Readonly<Record<string, AudioEffectDescriptor>> = {
  [DENOISE.kind]: DENOISE,
};

export function isAudioKind(kind: string): boolean {
  return kind.startsWith(AUDIO_KIND_PREFIX);
}

export function getAudioEffect(kind: string): AudioEffectDescriptor | null {
  return AUDIO_EFFECTS[kind] ?? null;
}

/// Flatten one stored entry's params for evaluation: every catalog param's
/// `Static` value or its default, plus whichever region bounds are actually
/// written. A `Keyframed` track is impossible here — the command layer refuses
/// one on an `audio.*` param (spec Decision 11) — and is skipped rather than
/// sampled, so a project hand-edited past that gate reads as unset instead of
/// baking a frozen value nobody chose.
export function staticParams(
  effect: AudioEffectEntry,
  descriptor: AudioEffectDescriptor,
): StaticParams {
  const regionKeys = descriptor.region
    ? [descriptor.region.inKey, descriptor.region.outKey]
    : [];
  const out: Record<string, number | undefined> = {};
  for (const [key, spec] of Object.entries(descriptor.params)) {
    if (regionKeys.includes(key)) continue;
    out[key] = spec.default;
  }
  for (const [key, track] of Object.entries(effect.params)) {
    if (track.mode === "Static") out[key] = track.value;
  }
  return out;
}

/// The layer's effective chain: enabled, catalogued, complete `audio.*`
/// effects, in stored order. Chain order is the render order and is part of the
/// signature, so this preserves it and never sorts.
export function effectiveChain(
  layer: { effects: readonly AudioEffectEntry[] },
  media: MediaBounds,
): EffectiveChain {
  const out: ChainEntry[] = [];
  for (const effect of layer.effects) {
    if (!effect.enabled || !isAudioKind(effect.kind)) continue;
    const descriptor = getAudioEffect(effect.kind);
    if (!descriptor) continue;
    const params = staticParams(effect, descriptor);
    if (!descriptor.isComplete(params, media)) continue;
    out.push({ effect, descriptor, params });
  }
  return out;
}
