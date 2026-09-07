// `audio.denoise` — ffmpeg `afftdn` driven by a user-sampled noise profile.
// The v1 audio effect, and the worked example every later descriptor copies.
// See ADR 0063 and docs/audio.md § Clip effects.

import type {
  AudioEffectDescriptor,
  MediaBounds,
  StaticParams,
} from "./catalog";
import { CONFORM_SAMPLE_RATE } from "./conform";
import type { BakeCtx, MeasurementRequest, StageLabels } from "./graph";
import { readMeasurement, samplesFromUs, secsFromSamples } from "./graph";

/// Shortest span `afftdn` can learn a spectrum from — roughly a dozen FFT
/// windows. Below it the profile describes the window function more than the
/// noise, so the effect reads incomplete rather than baking a bad profile.
const MIN_REGION_US = 250_000;

/// `afftdn`'s own `nf` bounds. The derived floor is clamped into them rather
/// than refused: a measured floor outside the filter's range is a real
/// recording, and the nearest representable floor is the honest answer.
const NF_MIN_DB = -80;
const NF_MAX_DB = -20;

const PROFILE_IN_KEY = "profile_in_us";
const PROFILE_OUT_KEY = "profile_out_us";

/// Sample-span bound, as authored. A day is far past any conform we would bake
/// and keeps the inspector's number field from offering nonsense; the real
/// bound is `isComplete`'s check against the media's own duration.
const MAX_REGION_BOUND_US = 24 * 60 * 60 * 1_000_000;

/// One param a stage cannot proceed without. `buildStage` runs only on an
/// entry `effectiveChain` returned, so an absent key here is a catalog bug —
/// loud, never defaulted.
function req(params: StaticParams, key: string): number {
  const v = params[key];
  if (v === undefined) throw new Error(`audio.denoise: param '${key}' is unset`);
  return v;
}

/// The sample region, or null when either bound is unwritten.
function region(params: StaticParams): { inUs: number; outUs: number } | null {
  const inUs = params[PROFILE_IN_KEY];
  const outUs = params[PROFILE_OUT_KEY];
  return inUs === undefined || outUs === undefined ? null : { inUs, outUs };
}

/// `afftdn`'s noise floor, derived at bake time from the region's measured
/// RMS: the profile sets the spectral SHAPE only, never the level, so a loud
/// floor left at the filter's default `nf` makes the whole filter a no-op.
/// Digital silence (no dBFS to report) takes the filter's minimum — nothing to
/// subtract, so leave the quietest possible floor rather than inventing one.
function noiseFloorDb(rmsDbfs: number | null, marginDb: number): number {
  if (rmsDbfs === null) return NF_MIN_DB;
  return Math.min(NF_MAX_DB, Math.max(NF_MIN_DB, Math.round(rmsDbfs + marginDb)));
}

export const DENOISE: AudioEffectDescriptor = {
  kind: "audio.denoise",
  version: 1,
  nameI18nKey: "effects.audio_denoise.name",
  descI18nKey: "effects.audio_denoise.desc",
  category: "audio",
  params: {
    strength: { default: 12, range: [1, 40], step: 1, unit: "dB" },
    margin: { default: 8, range: [0, 20], step: 1, unit: "dB" },
    [PROFILE_IN_KEY]: { default: 0, range: [0, MAX_REGION_BOUND_US], unit: "us" },
    [PROFILE_OUT_KEY]: { default: 0, range: [0, MAX_REGION_BOUND_US], unit: "us" },
  },
  region: { inKey: PROFILE_IN_KEY, outKey: PROFILE_OUT_KEY, minUs: MIN_REGION_US },

  isComplete(params: StaticParams, media: MediaBounds): boolean {
    const r = region(params);
    if (!r) return false;
    if (r.inUs < 0) return false;
    if (r.outUs - r.inUs < MIN_REGION_US) return false;
    // An unprobed duration cannot bound the span, so the region is unverifiable
    // and the effect stays out of the chain.
    return media.duration_us !== null && r.outUs <= media.duration_us;
  },

  measurements(params: StaticParams): MeasurementRequest[] {
    const r = region(params);
    return r === null ? [] : [{ kind: "rms", inUs: r.inUs, outUs: r.outUs }];
  },

  /// Concat pre-roll, not a bare `asendcmd`: `afftdn` is streaming, so samples
  /// that reach it before `sn stop` are processed with an untrained profile.
  /// Prepending a copy of the region ahead of the clip trains the filter first
  /// and the trailing `atrim` drops that pre-roll again, which is what makes
  /// the reduction before the region equal the reduction after it (measured:
  /// 9.3 dB vs 3.7 dB without).
  ///
  /// Both trims count SAMPLES and the `asendcmd` schedule is derived from the
  /// same count, so the pre-roll and the trim that removes it are equal by
  /// construction for ANY region bounds — see `samplesFromUs`. Output stays
  /// sample-for-sample as long as the input, which the bake primitive asserts.
  buildStage(params: StaticParams, labels: StageLabels, ctx: BakeCtx): string {
    const inUs = req(params, PROFILE_IN_KEY);
    const outUs = req(params, PROFILE_OUT_KEY);
    const nr = req(params, "strength").toFixed(3);
    const nf = noiseFloorDb(
      readMeasurement(ctx, { kind: "rms", inUs, outUs }),
      req(params, "margin"),
    );
    const inN = samplesFromUs(inUs, CONFORM_SAMPLE_RATE);
    const outN = samplesFromUs(outUs, CONFORM_SAMPLE_RATE);
    const lenN = outN - inN;
    const lenS = secsFromSamples(lenN, CONFORM_SAMPLE_RATE);
    // Every filter instance and internal label carries the stage tag: two
    // denoise entries in one chain are otherwise the same graph twice, and
    // ffmpeg refuses duplicate labels and would send both `sn` commands to
    // both filters.
    const fx = `afftdn@${labels.tag}`;
    const a = `${labels.tag}a`;
    const b = `${labels.tag}b`;
    const n = `${labels.tag}n`;
    return (
      `[${labels.in}]asplit[${a}][${b}];` +
      `[${a}]atrim=start_sample=${inN}:end_sample=${outN},asetpts=PTS-STARTPTS[${n}];` +
      `[${n}][${b}]concat=n=2:v=0:a=1,` +
      `asendcmd=c='0 ${fx} sn start; ${lenS} ${fx} sn stop',` +
      `${fx}=nr=${nr}:nf=${nf},` +
      `atrim=start_sample=${lenN},asetpts=PTS-STARTPTS[${labels.out}]`
    );
  },
};
