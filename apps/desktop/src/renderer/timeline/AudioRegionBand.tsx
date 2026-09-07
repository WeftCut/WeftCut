// The noise-profile sample region drawn on its clip: a translucent band between
// the effect's two stored bounds, with an edge handle at each end. Visible only
// while the card that owns the region is on screen and expanded (spec
// Decision 12), which `state/audioRegionFocusStore` decides.
//
// Boundary: draws, and hands its handles' presses on. The gesture and the
// commit belong to `hooks/useAudioRegionDrag.ts`, the arithmetic to
// `audioRegionGeometry.ts`, and the audio catalog is never imported — the two
// param keys and the minimum span arrive as props. See ADR 0063 and
// docs/audio.md § Clip effects.

import type { AnimTrack, LayerSummary } from "../ipc";
import {
  compUsFromSourceUs,
  pxFromCompUs,
  regionVisibility,
  resolveRegionDrag,
  type RegionBound,
  type RegionPxContext,
  type RegionSpan,
} from "./audioRegionGeometry";
import type { RegionDragPreview, RegionPressEvent } from "./hooks/useAudioRegionDrag";

/// Invisible grab zone straddling each edge — wide enough to hit at any zoom
/// without covering a band that has shrunk to a few pixels.
const HANDLE_WIDTH_PX = 7;

/// A bound's stored value, or `null` when the key was never written. Absent IS
/// the unset state, and a `Keyframed` track — which the command layer refuses
/// on an `audio.*` param — reads unset rather than being sampled.
function storedBound(track: AnimTrack<number> | undefined): number | null {
  return track && track.mode === "Static" ? track.value : null;
}

export function AudioRegionBand({
  layer,
  effectId,
  inKey,
  outKey,
  minUs,
  pxPerSec,
  blockLeftPx,
  visibleLoUs,
  visibleHiUs,
  preview,
  onHandlePointerDown,
}: {
  layer: LayerSummary;
  effectId: string;
  inKey: string;
  outKey: string;
  minUs: number;
  pxPerSec: number;
  /// Where the clip's start sits on the axis this band's own offsets are
  /// measured against. The band mounts as an absolutely positioned child of the
  /// block, whose box IS the clip, so the block passes 0; the prop exists
  /// because the drag hook's context carries the same field in client
  /// coordinates, and one geometry contract for both is what stops the band and
  /// the gesture from drifting apart.
  blockLeftPx: number;
  /// The span the band may draw in, in SOURCE µs — the clip's own window onto
  /// its media, so a trim that pulls the clip off its region stops the band
  /// (the region itself survives; the card explains it).
  visibleLoUs: number;
  visibleHiUs: number;
  preview: RegionDragPreview | null;
  onHandlePointerDown: (e: RegionPressEvent, bound: RegionBound) => void;
}) {
  const px: RegionPxContext = { pxPerSec, blockLeftPx, tStartUs: layer.t_start_us };

  /// What to paint, in composition µs: the gesture's promise while one is in
  /// flight, else the stored bounds mapped forward from source time.
  const drawnSpan = (): RegionSpan | null => {
    if (preview !== null) {
      // Resolved exactly as the release will resolve it, so what the band shows
      // — the minimum-span expansion included — is what the commit writes.
      return resolveRegionDrag({
        pressUs: preview.t0Us,
        releaseUs: preview.t1Us,
        tStartUs: layer.t_start_us,
        tEndUs: layer.t_end_us,
        minUs,
      });
    }
    const effect = layer.effects.find((candidate) => candidate.id === effectId);
    const inUs = storedBound(effect?.params[inKey]);
    const outUs = storedBound(effect?.params[outKey]);
    if (inUs === null || outUs === null) return null;
    if (regionVisibility({ inUs, outUs, visibleLoUs, visibleHiUs }) === "offscreen") {
      return null;
    }
    // Drawn edges clipped to the clip's window: the part outside it is audio
    // this clip does not play. Each handle stays on its clipped edge, which is
    // how a bound a trim pushed out gets dragged back in.
    const map = { tStartUs: layer.t_start_us, srcInUs: sourceHeadUs(layer) };
    return {
      inUs: compUsFromSourceUs(Math.max(inUs, visibleLoUs), map),
      outUs: compUsFromSourceUs(Math.min(outUs, visibleHiUs), map),
    };
  };

  const span = drawnSpan();
  if (span === null) return null;
  const x0 = pxFromCompUs(span.inUs, px);
  const x1 = pxFromCompUs(span.outUs, px);

  return (
    <div
      data-testid="audio-region-band"
      // Inert body: relocating a region means re-arming and redrawing it (spec
      // Decision 12), so the only thing here that takes a press is a handle.
      className="pointer-events-none absolute inset-y-0 z-[2] border-x border-ring bg-ring/25"
      style={{ left: Math.min(x0, x1), width: Math.max(1, Math.abs(x1 - x0)) }}
    >
      <span
        data-testid="audio-region-handle-in"
        className="pointer-events-auto absolute inset-y-0 left-0 z-[3] -translate-x-1/2 cursor-ew-resize"
        style={{ width: HANDLE_WIDTH_PX }}
        onPointerDown={(e) => onHandlePointerDown(e, "in")}
      />
      <span
        data-testid="audio-region-handle-out"
        className="pointer-events-auto absolute inset-y-0 right-0 z-[3] translate-x-1/2 cursor-ew-resize"
        style={{ width: HANDLE_WIDTH_PX }}
        onPointerDown={(e) => onHandlePointerDown(e, "out")}
      />
    </div>
  );
}

/// The clip's head in source time, asked kind-agnostically: every kind that can
/// carry an audio effect windows its media the same way.
function sourceHeadUs(layer: LayerSummary): number {
  return "src_in_us" in layer.params ? layer.params.src_in_us : 0;
}
