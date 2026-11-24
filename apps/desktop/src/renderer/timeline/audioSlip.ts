/// Sample-precision audio authoring: the pure half. Nudge steps and the derived
/// link sync offset (ADR 0038), with no React and no IPC, so every acceptance
/// property is a unit test rather than a UI walkthrough.
///
/// An audio layer's edges sit on the frame grid like every layer's; sample
/// precision lives in its source window. A nudge slips the source under fixed
/// edges, and the sync offset is read off where each member's source lands.
import { AUDIO_GRID, AUDIO_SAMPLES_PER_MS, gridIndex, stepPointOnGrid } from "../grid";

/** The two nudge tiers. One sample is the finest the mix lattice has; 1 ms = 48
 *  samples is the coarse tier, because a single sample (~21 µs) is far below the
 *  threshold of an audible sync fix and holding a key for 48 presses is not a UI. */
export const NUDGE_SAMPLE = 1;
export const NUDGE_MS = AUDIO_SAMPLES_PER_MS;

/** Minimum layer geometry the slip helpers need — structurally satisfied by
 *  `LayerSummary` (whose top-level `kind` IS `params.kind`; see
 *  `summary.ts::layerKind`), so callers pass summary rows straight in. The source
 *  fields are present on the kinds that have a source window. */
export interface SlipLayer {
  id: string;
  t_start_us: number;
  t_end_us: number;
  kind: string;
  media_id?: string;
  src_in_us?: number;
  src_out_us?: number;
  time_map?: unknown;
}

/** A source window to write back with `update_layer_params`. */
export interface SourceWindow {
  src_in_us: number;
  src_out_us: number;
}

/** The source window that makes an audio layer's sound play `steps` SAMPLES later
 *  (earlier when negative) under the same edges, or `null` when it has no source
 *  to slip.
 *
 *  Resolved through the sample index, never by adding a sample's width in µs — 48 kHz
 *  spacing alternates 20/21 µs, so a µs-additive step drifts and nudging out and back
 *  10 000 times would not return to the original sample. Not clamped: a window that
 *  would leave the media is refused by the actor (`InvalidSrcRange`,
 *  `SrcRangeExceedsMedia`), which is the notice the user sees. */
export function nudgedSource(layer: SlipLayer, steps: number): SourceWindow | null {
  if (layer.src_in_us === undefined || layer.src_out_us === undefined) return null;
  return {
    src_in_us: stepPointOnGrid(layer.src_in_us, -steps, AUDIO_GRID),
    src_out_us: stepPointOnGrid(layer.src_out_us, -steps, AUDIO_GRID),
  };
}

/** The audio layers in `selection` that a nudge should slip.
 *
 *  Audio-only by design: the nudges exist because audio has a finer lattice, and
 *  applying them to a visual layer would either do nothing or silently move its
 *  picture by a sub-frame amount no frame can show. A mixed selection nudges only
 *  its audio members, which is also what makes the command safe to fire on a
 *  whole-link selection — the video member stays put. */
export function slippableAudioLayers(
  selection: ReadonlySet<string>,
  layers: readonly SlipLayer[],
): SlipLayer[] {
  return layers.filter((l) => selection.has(l.id) && l.kind === "Audio");
}

/** A signed µs amount as whole samples, rounded half away from zero, without
 *  asking the leaf for a time before 0. */
function samplesOf(us: number): number {
  return Math.sign(us) * gridIndex(Math.abs(us), AUDIO_GRID);
}

/** Whether `l` plays its source at rate 1 from `src_in_us`: the only mapping on
 *  which "where source time 0 lands" is one instant. */
function plainSource(l: SlipLayer): l is SlipLayer & { media_id: string; src_in_us: number; src_out_us: number } {
  return l.media_id !== undefined && l.src_in_us !== undefined && l.src_out_us !== undefined && l.time_map === undefined;
}

/** The visual member of `audio`'s link that plays the SAME media, the one whose
 *  start is closest to the audio's — "the picture this sound was recorded with".
 *  `null` when there is none, or when either side is retimed. */
function syncReference(audio: SlipLayer, linkMembers: readonly SlipLayer[]): (SlipLayer & { src_in_us: number }) | null {
  if (!plainSource(audio)) return null;
  let ref: (SlipLayer & { src_in_us: number }) | null = null;
  for (const v of linkMembers) {
    if (v.id === audio.id || v.kind === "Audio" || !plainSource(v) || v.media_id !== audio.media_id) continue;
    if (ref === null || Math.abs(v.t_start_us - audio.t_start_us) < Math.abs(ref.t_start_us - audio.t_start_us)) ref = v;
  }
  return ref;
}

/** The sync offset of a linked audio layer, in SAMPLES: how much later its sound
 *  plays than the picture recorded with it. `null` when there is no visual member
 *  of the same media to measure against.
 *
 *  DERIVED, never stored, so no field can ever disagree with the geometry: the
 *  difference between where each member's source time 0 lands on the timeline,
 *  `t_start − src_in` for both. Edges are shared frames, so an un-slipped pair
 *  reads exactly 0 and N nudges read exactly N. */
export function syncOffsetSamples(
  audio: SlipLayer,
  linkMembers: readonly SlipLayer[],
): number | null {
  const ref = syncReference(audio, linkMembers);
  if (ref === null) return null;
  const audioIn = audio.src_in_us!;
  return samplesOf((audio.t_start_us - ref.t_start_us) - (audioIn - ref.src_in_us));
}

/** The source window that puts an audio layer back in sync with its picture, its
 *  edges untouched. `null` when there is nothing to re-sync to, or when it is
 *  already synced (so the command can no-op rather than mint a history entry). */
export function resyncedSource(
  audio: SlipLayer,
  linkMembers: readonly SlipLayer[],
): SourceWindow | null {
  const ref = syncReference(audio, linkMembers);
  if (ref === null || syncOffsetSamples(audio, linkMembers) === 0) return null;
  const srcIn = ref.src_in_us + (audio.t_start_us - ref.t_start_us);
  return { src_in_us: srcIn, src_out_us: srcIn + (audio.src_out_us! - audio.src_in_us!) };
}

/** Human-readable slip for the clip badge. `null` when there is nothing to show —
 *  either no visual partner or a genuinely zero offset (a badge that always shows
 *  "0 ms" is a badge nobody reads).
 *
 *  Sub-millisecond slips read in samples because "0.0 ms" is not information; at 1 ms
 *  and above milliseconds are what a user reasons about. Sign is explicit: a positive
 *  offset means the audio is LATE relative to its video. */
export function formatSyncOffset(offsetSamples: number | null): string | null {
  if (offsetSamples === null || offsetSamples === 0) return null;
  const sign = offsetSamples > 0 ? "+" : "−";
  const mag = Math.abs(offsetSamples);
  if (mag < AUDIO_SAMPLES_PER_MS) return `${sign}${mag} smp`;
  return `${sign}${(mag / AUDIO_SAMPLES_PER_MS).toFixed(mag < AUDIO_SAMPLES_PER_MS * 10 ? 2 : 1)} ms`;
}
