/// What a gap IS, stated once: the free span on one track between two layer
/// boundaries. Three readers share this one rule — the lane's click resolves a
/// pointer time to the gap under it, the selection store checks that a selected
/// gap still exists after every project summary, and the ripple planner refuses
/// to close a span that is not one. A second definition in any of them would be
/// the drift a gap selection cannot afford: the highlight would show one span
/// and the edit would close another.
///
/// Class-agnostic, unlike the ripple's hole. A hole is measured per overlap
/// class because a transition lets two visual layers share a lane; a gap is
/// what the user sees as blank on the row, and a combined V+A row whose audio
/// half is empty under a picture is not blank. The head of the composition
/// counts as a left boundary — the space before the first clip is a gap in
/// Premiere and Resolve too — and the space after the last clip is not a gap at
/// all: it has no right edge to close up to.
///
/// Pure and renderer-side, for the boundary `plan.ts` records: main may import
/// a pure renderer module, the renderer may never import `main/state`.
///
/// ADR 0069.
import type { TimeUs } from '../../shared/commandErrors'

/** Half-open `[s, e)`, the convention every span here uses. */
export interface GapSpan { s: TimeUs; e: TimeUs }

/** The two fields a gap reads off a layer — the actor's `Layer` and the wire's
 *  `LayerSummary` both carry them under these names. */
export interface GapLayerView { t_start_us: TimeUs; t_end_us: TimeUs }

/**
 * The gap on a track that contains `tUs`, or null when there is none: `tUs` is
 * under a layer, before composition time 0, past the last layer (trailing space
 * is not a gap), or the track is empty.
 *
 * The left edge is the latest end among layers wholly before `tUs`, floored at
 * 0; the right edge is the earliest start among layers after it. Half-open
 * throughout, so a press exactly on a layer's start is on the layer and one
 * exactly on its end is in the gap that follows.
 */
export function gapAt(layers: readonly GapLayerView[], tUs: TimeUs): GapSpan | null {
  if (tUs < 0) return null
  let s = 0
  let e = Infinity
  for (const l of layers) {
    if (l.t_start_us <= tUs && tUs < l.t_end_us) return null
    if (l.t_end_us <= tUs) s = Math.max(s, l.t_end_us)
    else e = Math.min(e, l.t_start_us)
  }
  return e === Infinity ? null : { s, e }
}

/**
 * Whether `[s, e)` is EXACTLY a gap on the track — the span `gapAt` would answer
 * for any time inside it. Not "is this span free": a sub-span of a gap is free
 * but is not the gap, and closing it would leave the user's highlight and the
 * edit disagreeing about what went.
 */
export function isGapOn(layers: readonly GapLayerView[], s: TimeUs, e: TimeUs): boolean {
  if (!(s >= 0 && e > s)) return false
  const gap = gapAt(layers, s)
  return gap !== null && gap.s === s && gap.e === e
}
