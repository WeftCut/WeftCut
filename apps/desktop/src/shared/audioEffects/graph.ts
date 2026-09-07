// The bake-time contract for an audio effect chain: what a stage may ask to be
// measured off the conform, what those measurements look like once taken, and
// how the per-effect stages compose into the one `-filter_complex` the bake
// primitive runs.
//
// Owns nothing about WHICH effects exist (catalog.ts) and nothing about naming
// the artifact (signature.ts). Node-free — the renderer imports this tree too.
// See ADR 0063 and docs/audio.md.

import type { ChainEntry, EffectiveChain } from "./catalog";

/// A quantity a stage needs read off the conform PCM before its graph can be
/// written. `rms` pools all channels over `[inUs, outUs)` in source time and
/// answers dBFS — the noise floor a denoise stage derives `afftdn`'s `nf` from.
export type MeasurementRequest = { kind: "rms"; inUs: number; outUs: number };

/// Measurement results by `measurementKey`. `null` is a REAL answer, not a
/// miss: digital silence (and a zero-frame range) has no dBFS, and each stage
/// decides what that means for its own parameters. An absent key is the miss,
/// and `readMeasurement` throws on it.
export type BakeMeasurements = Record<string, number | null>;

/// Everything a stage may read that is not one of its own params. One field
/// today; a struct so adding a second bake-time input is not a signature
/// change across every descriptor.
export interface BakeCtx {
  measurements: BakeMeasurements;
}

/// Where a stage reads from, where it must write to, and the token it must
/// suffix every filter instance and internal link label with.
export interface StageLabels {
  /// Input link label, WITHOUT brackets (`0:a` for the first stage).
  in: string;
  /// Output link label, without brackets (`out` for the last stage).
  out: string;
  /// Per-stage uniquifier. Two identical effects in one chain differ only by
  /// this, so a stage that hard-codes a filter instance name or an internal
  /// label instead of suffixing it collides and ffmpeg refuses the graph.
  tag: string;
}

/// The label the bake primitive maps (`-map [out]`).
export const AUDIO_FX_OUT_LABEL = "out";

/// The lookup a stage and the baker must agree on, so the baker can fill
/// `BakeCtx.measurements` from a descriptor's `measurements()` list without
/// knowing what any stage will do with the numbers.
export function measurementKey(req: MeasurementRequest): string {
  return `${req.kind}:${req.inUs}:${req.outUs}`;
}

/// Read one measurement a stage declared. Throws on an absent key: the baker
/// takes exactly the measurements `descriptor.measurements(params)` asked for,
/// so a miss is a baker bug and a stage must never paper over it with a
/// plausible default — that would bake audio nobody asked for.
export function readMeasurement(
  ctx: BakeCtx,
  req: MeasurementRequest,
): number | null {
  const key = measurementKey(req);
  if (!(key in ctx.measurements)) {
    throw new Error(`audio fx bake: measurement '${key}' was not taken`);
  }
  return ctx.measurements[key] ?? null;
}

/// Fixed 6 decimals — the ONE numeric rule every stage template prints times
/// through. Never `toString()`: that reaches exponent form for small
/// magnitudes, and a locale-formatted comma would parse as an argument
/// separator.
function fixed6(seconds: number): string {
  return seconds.toFixed(6);
}

/// A source-time bound as a sample index on the conform lattice.
///
/// LANDMINE: a stage times its trims in SAMPLES, and derives any seconds it
/// also needs from those counts (`secsFromSamples`) rather than from the raw
/// µs. With second-valued `atrim` bounds, ffmpeg rounds each bound
/// independently, so a region whose edges do not sit on the lattice makes a
/// pre-roll and the trim that removes it differ by one sample — the output is
/// then 4·channels bytes off the input and the bake primitive bails on a
/// length-changing graph. There is no µs time formatter here on purpose.
export function samplesFromUs(us: number, sampleRate: number): number {
  return Math.round((us * sampleRate) / 1_000_000);
}

/// A sample count as an ffmpeg time literal, for the arguments that have to be
/// a time (`asendcmd`'s schedule, which is frame-granular anyway).
export function secsFromSamples(samples: number, sampleRate: number): string {
  return fixed6(samples / sampleRate);
}

/// Chain the effective chain's stages into one `-filter_complex`:
/// `[0:a] → [s1] → … → [out]`, one `;`-separated stage per effect, each tagged
/// by its index. `null` for an empty chain — there is no graph, and the layer
/// plays the raw conform.
export function buildFilterComplex(
  chain: EffectiveChain,
  ctx: BakeCtx,
): string | null {
  if (chain.length === 0) return null;
  return chain
    .map((entry: ChainEntry, i: number) =>
      entry.descriptor.buildStage(
        entry.params,
        {
          in: i === 0 ? "0:a" : `s${i}`,
          out: i === chain.length - 1 ? AUDIO_FX_OUT_LABEL : `s${i + 1}`,
          tag: `fx${i}`,
        },
        ctx,
      ),
    )
    .join(";");
}

/// Every measurement the chain needs, deduplicated by `measurementKey` — the
/// baker's work list, in chain order.
export function chainMeasurements(chain: EffectiveChain): MeasurementRequest[] {
  const seen = new Set<string>();
  const out: MeasurementRequest[] = [];
  for (const entry of chain) {
    for (const req of entry.descriptor.measurements(entry.params)) {
      const key = measurementKey(req);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(req);
    }
  }
  return out;
}
