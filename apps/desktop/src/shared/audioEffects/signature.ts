// The canonical string that identifies one `(media, conform format, effective
// chain)` triple. Two layers whose canonical strings match share one bake.
//
// Pure, like everything else under src/shared/audioEffects/: no `node:` import
// anywhere in this tree, in production or in test code, because the renderer
// consumes it and tsconfig.shared compiles it without @types/node. The HASH of
// this string is therefore main's, in src/main/audioFx/signature.ts — nothing
// renderer-side computes a signature; it reads the paths the baker publishes
// (status.ts).
//
// See ADR 0063 and docs/audio.md.

import type { EffectiveChain } from "./catalog";

/// Canonical-string format. Bump when the STRING's grammar changes (a new
/// field, a different separator); every existing signature changes with it and
/// the baker re-renders. A catalog change bumps the effect's own `version`
/// instead — that is what keeps one effect's edit from invalidating the rest.
const CANONICAL_VERSION = "v1";

/// One stored param value, printed. Fixed 6 decimals: `toString()` reaches
/// exponent form for small magnitudes and `toLocaleString` a comma separator,
/// and either would make the same chain hash differently somewhere else. Six
/// is double the authored effect-param precision, so two values that differ in
/// storage can never print the same. (Beyond 1e21 `toFixed` falls back to
/// exponent form — far past any authorable param.)
function canonicalNumber(v: number): string {
  return v.toFixed(6);
}

/// `v1|{media_hash}|{conform_version}|{kind}@{version}{k=v,…};{kind}@{version}{…}`
///
/// Params sorted by key so a client that writes `margin` before `strength`
/// gets the same artifact; values as stored (already quantized by the mutation
/// layer) so the signature names what will be rendered; the effect `id`
/// excluded so two layers configured alike share one bake; chain order kept
/// because it is the render order.
///
/// The braces around the param list are LITERAL — they delimit one effect's
/// params from the next effect's kind, so no separator is ambiguous.
///
/// `null` for an empty effective chain: there is nothing to bake and the layer
/// plays the raw conform.
export function canonicalChain(
  mediaHash: string,
  conformVersion: number,
  chain: EffectiveChain,
): string | null {
  if (chain.length === 0) return null;
  const parts = chain.map((entry) => {
    // Only `Static` values are representable, and only Static can exist: a
    // `Keyframed` track on an `audio.*` param is refused at both write entries
    // (spec Decision 11). One hand-edited past that gate is skipped rather than
    // sampled — its absence reads as unset, which is what the catalog's
    // defaults already mean.
    const params = Object.entries(entry.effect.params)
      .filter(([, track]) => track.mode === "Static")
      .map(([key, track]) => [key, track.value as number] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${canonicalNumber(value)}`)
      .join(",");
    return `${entry.effect.kind}@${entry.descriptor.version}{${params}}`;
  });
  return `${CANONICAL_VERSION}|${mediaHash}|${conformVersion}|${parts.join(";")}`;
}
