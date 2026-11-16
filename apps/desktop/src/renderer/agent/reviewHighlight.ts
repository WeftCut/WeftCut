// What the timelines paint for a set of review changes (ADR 0115): a pure
// projection of `Change[]` + `GroupDecoration[]` onto the shapes the surfaces
// draw — a mark per current clip or marker, a historical ghost per removed
// clip or marker, a badge per Group clip containing changes — and of the
// changed ranges (ADR 0169) onto the review bands of the mini timeline and
// the Review lane.
//
// The input is deliberately just a change set: the Review view's unreviewed
// list, or one activity's own changes (`review_activity_view`) — both through
// the same function onto the same surfaces (`reviewStore.ts`).
import { parseEntityKey, type Change, type ChangeClass, type ChangedRange, type GroupDecoration } from '../../shared/review'

/** How a CURRENT clip is decorated. `removed` has no current clip: it is a ghost. */
export type ReviewClipMark = Exclude<ChangeClass, 'removed'>

/** A removed layer, outlined where it was on a track that still exists
 *  (the surface checks the track; the model only knows the baseline id). */
export interface ReviewGhost {
  changeId: string
  layerId: string
  compositionId: string
  trackId: string
  tStartUs: number
  tEndUs: number
}

/** A removed marker, at its baseline place on the marker lane of its
 *  composition — `endUs` null for a point — named by its baseline label. */
export interface ReviewMarkerGhost {
  changeId: string
  markerId: string
  compositionId: string
  tUs: number
  endUs: number | null
  label: string
}

/** A measured trim cut at an edge of its current clip, on the clip's current
 *  track. It cannot represent an inferred ripple seam. */
export interface ReviewCut {
  changeId: string
  layerId: string
  compositionId: string
  trackId: string
  tUs: number
  kind: 'trim'
}

/** One changed range as the review bands paint it (ADR 0169). */
export interface ReviewRangeMark {
  /** Unique within one highlight. */
  key: string
  cls: ChangeClass
  compositionId: string
  tStartUs: number
  tEndUs: number
  /** A removal with no width now: drawn as a cut point. */
  cut: boolean
  /** Only the user's own changes play in it. */
  user: boolean
  range: ChangedRange
}

/** The bands' marks for `ranges`, in composition then time order. */
export function rangeMarks(ranges: readonly ChangedRange[]): ReviewRangeMark[] {
  return ranges.map((r, i) => ({
    key: `${r.composition_id}:${i}`, cls: r.class, compositionId: r.composition_id,
    tStartUs: r.t_start_us, tEndUs: r.t_end_us, cut: r.t_end_us <= r.t_start_us, user: r.source === 'user', range: r,
  }))
}

export interface ReviewHighlight {
  /** Current layer id → its mark. */
  layers: ReadonlyMap<string, ReviewClipMark>
  ghosts: readonly ReviewGhost[]
  /** Current marker id → its mark: the marker lane's light ring. */
  markers: ReadonlyMap<string, ReviewClipMark>
  markerGhosts: readonly ReviewMarkerGhost[]
  cuts: readonly ReviewCut[]
  /** Current layer id → the change that marks it (its tooltip's words). */
  layerChanges: ReadonlyMap<string, string>
  /** The painted changes by id, for the words a surface puts on a mark. */
  changes: ReadonlyMap<string, Change>
  /** Group layer id → number of highlighted changes it contains. */
  groups: ReadonlyMap<string, number>
  /** Where the film plays differently: the review bands. */
  ranges: readonly ReviewRangeMark[]
}

export const EMPTY_HIGHLIGHT: ReviewHighlight = {
  layers: new Map(), ghosts: [], markers: new Map(), markerGhosts: [], cuts: [], layerChanges: new Map(), changes: new Map(), groups: new Map(), ranges: [],
}

/** Project `changes` onto paintable marks. `decorations` may cover more
 *  changes than `changes` (the Review view's cover both lists); only the
 *  changes given count toward a Group's badge — main counts only those with
 *  a place on the Group's timeline (`GroupDecoration`). */
export function buildReviewHighlight(changes: readonly Change[], decorations: readonly GroupDecoration[], changed: readonly ChangedRange[] = []): ReviewHighlight {
  if (changes.length === 0 && changed.length === 0) return EMPTY_HIGHLIGHT
  const layers = new Map<string, ReviewClipMark>()
  const layerChanges = new Map<string, string>()
  const ghosts: ReviewGhost[] = []
  const markers = new Map<string, ReviewClipMark>()
  const markerGhosts: ReviewMarkerGhost[] = []
  const cuts: ReviewCut[] = []
  const ids = new Set<string>(changes.map(c => c.id))
  const groups = new Map<string, number>()
  for (const d of decorations) {
    const n = d.change_ids.reduce((sum, id) => sum + (ids.has(id) ? 1 : 0), 0)
    if (n === 0) continue
    groups.set(d.layer_id, n)
  }
  for (const c of changes) {
    const { kind, id } = parseEntityKey(c.id)
    if (kind === 'Marker') {
      if (c.class !== 'removed') markers.set(id, c.class)
      else for (const r of c.before_ranges ?? []) markerGhosts.push({ changeId: c.id, markerId: id, compositionId: r.composition_id,
        tUs: r.t_start_us, endUs: r.t_end_us > r.t_start_us ? r.t_end_us : null, label: c.before_name ?? '' })
      continue
    }
    if (kind !== 'Layer') continue
    if (c.class !== 'removed') {
      layers.set(id, c.class)
      layerChanges.set(id, c.id)
      const r = c.ranges[0]
      if (r && r.track_id !== null) for (const d of c.details) {
        if (d.type !== 'trim' || d.delta_us >= 0) continue
        cuts.push({ changeId: c.id, layerId: id, compositionId: r.composition_id, trackId: r.track_id,
          tUs: d.side === 'start' ? r.t_start_us : r.t_end_us, kind: 'trim' })
      }
      continue
    }
    // Historical footprint only: never place a removal from adjacent content.
    for (const r of c.before_ranges ?? []) {
      if (r.track_id === null) continue
      ghosts.push({ changeId: c.id, layerId: id, compositionId: r.composition_id, trackId: r.track_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
    }
  }
  return { layers, ghosts, markers, markerGhosts, cuts, layerChanges, changes: new Map(changes.map(c => [c.id, c])), groups, ranges: rangeMarks(changed) }
}
