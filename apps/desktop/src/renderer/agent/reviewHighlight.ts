// What the timelines paint for a set of review changes (ADR 0115): a pure
// projection of `Change[]` + `GroupDecoration[]` onto the shapes the surfaces
// draw — a mark per current clip, a historical ghost per removed clip, a badge
// per Group clip containing changes, and current ranges for the mini timeline.
//
// The input is deliberately just a change set: the Review view's unreviewed
// list, or one activity's own changes (`review_activity_view`) — both through
// the same function onto the same surfaces (`reviewStore.ts`).
import type { Change, ChangeClass, GroupDecoration } from '../../shared/review'

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

/** A measured trim cut at an edge of its current clip. The track is resolved
 *  by identity by the renderer; this cannot represent an inferred ripple seam. */
export interface ReviewCut {
  changeId: string
  layerId: string
  compositionId: string
  trackId: null
  tUs: number
  kind: 'trim'
}

/** One painted stretch of the mini timeline's change band: a change's own
 *  range, or a Group clip containing changes at its footprint (`changeId`
 *  `Group:<layer id>`, painted as `modified`), so what changed inside a
 *  Group shows on the timeline holding it. */
export interface ReviewRangeMark {
  changeId: string
  cls: ChangeClass
  compositionId: string
  tStartUs: number
  tEndUs: number
}

export interface ReviewHighlight {
  /** Current layer id → its mark. */
  layers: ReadonlyMap<string, ReviewClipMark>
  ghosts: readonly ReviewGhost[]
  cuts: readonly ReviewCut[]
  /** Current layer id → the change that marks it (its tooltip's words). */
  layerChanges: ReadonlyMap<string, string>
  /** The painted changes by id, for the words a surface puts on a mark. */
  changes: ReadonlyMap<string, Change>
  /** Group layer id → number of highlighted changes it contains. */
  groups: ReadonlyMap<string, number>
  ranges: readonly ReviewRangeMark[]
}

export const EMPTY_HIGHLIGHT: ReviewHighlight = {
  layers: new Map(), ghosts: [], cuts: [], layerChanges: new Map(), changes: new Map(), groups: new Map(), ranges: [],
}

const LAYER_PREFIX = 'Layer:'

/** Project `changes` onto paintable marks. `decorations` may cover more
 *  changes than `changes` (the Review view's cover both lists); only the
 *  changes given count toward a Group's badge. */
export function buildReviewHighlight(changes: readonly Change[], decorations: readonly GroupDecoration[]): ReviewHighlight {
  if (changes.length === 0) return EMPTY_HIGHLIGHT
  const layers = new Map<string, ReviewClipMark>()
  const layerChanges = new Map<string, string>()
  const ghosts: ReviewGhost[] = []
  const cuts: ReviewCut[] = []
  const ranges: ReviewRangeMark[] = []
  for (const c of changes) {
    for (const r of c.ranges) ranges.push({ changeId: c.id, cls: c.class, compositionId: r.composition_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
    for (const key of c.keys) {
      if (!key.startsWith(LAYER_PREFIX)) continue
      const layerId = key.slice(LAYER_PREFIX.length)
      if (c.class !== 'removed') {
        layers.set(layerId, c.class)
        layerChanges.set(layerId, c.id)
        const r = c.ranges.find(x => x.composition_id === c.composition_id) ?? c.ranges[0]
        if (r) for (const d of c.details) {
          if (d.type !== 'trim' || d.delta_us >= 0) continue
          cuts.push({ changeId: c.id, layerId, compositionId: r.composition_id, trackId: null,
            tUs: d.side === 'start' ? r.t_start_us : r.t_end_us, kind: 'trim' })
        }
        continue
      }
      // Historical footprint only: never place a removal from adjacent content.
      for (const r of c.before_ranges ?? []) {
        if (r.track_id === null) continue
        ghosts.push({ changeId: c.id, layerId, compositionId: r.composition_id, trackId: r.track_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
      }
    }
  }
  const ids = new Set(changes.map(c => c.id))
  const groups = new Map<string, number>()
  for (const d of decorations) {
    const n = d.change_ids.reduce((sum, id) => sum + (ids.has(id) ? 1 : 0), 0)
    if (n === 0) continue
    groups.set(d.layer_id, n)
    ranges.push({ changeId: `Group:${d.layer_id}`, cls: 'modified', compositionId: d.composition_id, tStartUs: d.t_start_us, tEndUs: d.t_end_us })
  }
  return { layers, ghosts, cuts, layerChanges, changes: new Map(changes.map(c => [c.id, c])), groups, ranges }
}
