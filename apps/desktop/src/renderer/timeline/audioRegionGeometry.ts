// The arithmetic behind the noise-profile sample region drawn on a clip: the
// clip's px↔µs axis, the source↔composition mapping the stored bounds live
// under, and the two resolvers that decide where a drag lands.
//
// Boundary: pure — no React, no store, no audio catalog. The gesture belongs to
// `hooks/useAudioRegionDrag.ts` and the drawing to `AudioRegionBand.tsx`; both
// resolve through this module, which is what keeps the band from painting a
// region the commit would not make. See ADR 0063 and docs/audio.md
// § Clip effects.

import { clamp } from "./geometry";

const US_PER_SEC = 1_000_000;

/// The clip's px↔µs axis.
///
/// Read ONCE at the press for a gesture — nothing here can change while a
/// pointer is down — and per render for the band.
export interface RegionPxContext {
  pxPerSec: number;
  /// Where the clip's `tStartUs` sits on the same px axis the `px` argument is
  /// measured on: the block's client-rect left for a pointer event, `0` for the
  /// band, which draws as an absolutely positioned child of the block.
  blockLeftPx: number;
  tStartUs: number;
}

/// Composition µs under a px coordinate on the clip's axis.
export function compUsFromPx(px: number, ctx: RegionPxContext): number {
  // A collapsed axis has no time under it; the clip's start is the only answer
  // that cannot be an infinity.
  if (ctx.pxPerSec <= 0) return ctx.tStartUs;
  return ctx.tStartUs + ((px - ctx.blockLeftPx) / ctx.pxPerSec) * US_PER_SEC;
}

/// Inverse of `compUsFromPx` — where a composition time draws on the clip's
/// axis.
export function pxFromCompUs(us: number, ctx: RegionPxContext): number {
  return ctx.blockLeftPx + ((us - ctx.tStartUs) / US_PER_SEC) * ctx.pxPerSec;
}

/// The clip's window onto its media: enough of a layer to convert between the
/// two axes and nothing else, so this file never learns what a layer is.
export interface RegionSourceMap {
  tStartUs: number;
  srcInUs: number;
}

/// Composition time → SOURCE time, the axis region bounds are stored on (spec
/// Decision 3: bounds in source time survive move, trim, slip and split). A
/// pure offset — an audio layer has no speed factor to bend the mapping.
export function sourceUsFromCompUs(compUs: number, layer: RegionSourceMap): number {
  return layer.srcInUs + (compUs - layer.tStartUs);
}

/// Inverse of `sourceUsFromCompUs` — where a stored bound falls on the
/// timeline.
export function compUsFromSourceUs(sourceUs: number, layer: RegionSourceMap): number {
  return layer.tStartUs + (sourceUs - layer.srcInUs);
}

/// A sample region, on whichever axis the caller handed in.
export interface RegionSpan {
  inUs: number;
  outUs: number;
}

/// Which bound of a region a handle drags.
export type RegionBound = "in" | "out";

/// Where the one-shot region drag lands, in composition µs.
///
/// The press point is the anchor, not merely one end: when the drag is shorter
/// than the filter can learn from, the press keeps its place and the far end
/// grows in the direction the pointer went — so a press near the clip's end
/// expands LEFT, which is the only direction with room. A window that still
/// runs off an edge slides back inside whole rather than being truncated to
/// something the effect would read as incomplete.
///
/// `null` when the clip itself is shorter than `minUs`: the card's arm button is
/// disabled in that case, but a clip trimmed short AFTER arming reaches here and
/// must produce nothing rather than a region no bake would accept.
///
/// No frame snapping: a noise profile is measured in samples, so rounding its
/// bounds onto the composition's frame grid would move them for nothing
/// (ADR 0038 governs picture, not audio).
export function resolveRegionDrag({
  pressUs,
  releaseUs,
  tStartUs,
  tEndUs,
  minUs,
}: {
  pressUs: number;
  releaseUs: number;
  tStartUs: number;
  tEndUs: number;
  minUs: number;
}): RegionSpan | null {
  if (tEndUs - tStartUs < minUs) return null;
  // Rounded on the way in, so every branch below is whole-µs arithmetic and no
  // expansion can come out a microsecond short of `minUs`.
  const press = clamp(Math.round(pressUs), tStartUs, tEndUs);
  const release = clamp(Math.round(releaseUs), tStartUs, tEndUs);
  const inUs = Math.min(press, release);
  const outUs = Math.max(press, release);
  if (outUs - inUs >= minUs) return { inUs, outUs };
  // A press with no travel counts as a drag to the right, which the two clamps
  // below turn around when the press sits at the clip's tail.
  const grown =
    release >= press
      ? { inUs: press, outUs: press + minUs }
      : { inUs: press - minUs, outUs: press };
  if (grown.outUs > tEndUs) return { inUs: tEndUs - minUs, outUs: tEndUs };
  if (grown.inUs < tStartUs) return { inUs: tStartUs, outUs: tStartUs + minUs };
  return grown;
}

/// Where one edge handle lands, in composition µs — the moved bound only; the
/// other one stays where it is.
///
/// The clip has the last word: when the region is already so close to an edge
/// that `minUs` cannot be honoured without moving the bound the user is NOT
/// touching, the moved bound stops at the clip instead. A bound outside the clip
/// names audio this clip does not play, while a short region is a state the card
/// already explains.
export function resolveHandleDrag({
  bound,
  newUs,
  otherUs,
  tStartUs,
  tEndUs,
  minUs,
}: {
  bound: RegionBound;
  newUs: number;
  otherUs: number;
  tStartUs: number;
  tEndUs: number;
  minUs: number;
}): number {
  const want = Math.round(newUs);
  return bound === "in"
    ? clamp(Math.min(want, otherUs - minUs), tStartUs, tEndUs)
    : clamp(Math.max(want, otherUs + minUs), tStartUs, tEndUs);
}

/// How much of a region falls inside the span it may be drawn in.
export type RegionVisibility = "visible" | "clipped" | "offscreen";

/// Whether the band draws, draws partly, or does not draw at all.
///
/// The window is the clip's own source span, so a trim that pulls the clip off
/// its region hides the band — the region itself survives (source time, spec
/// Decision 3) and the card says so.
export function regionVisibility({
  inUs,
  outUs,
  visibleLoUs,
  visibleHiUs,
}: {
  inUs: number;
  outUs: number;
  visibleLoUs: number;
  visibleHiUs: number;
}): RegionVisibility {
  if (outUs <= visibleLoUs || inUs >= visibleHiUs) return "offscreen";
  return inUs >= visibleLoUs && outUs <= visibleHiUs ? "visible" : "clipped";
}
