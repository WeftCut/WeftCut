// What the timelines paint for a set of review changes (ADR 0115): a pure
// projection of `Change[]` + `GroupDecoration[]` onto the shapes the surfaces
// draw — a mark per current clip, a ghost per removed clip, a badge per Group
// clip containing changes, and time ranges per composition for the mini
// timeline's band.
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
  /** Group layer id → number of highlighted changes it contains. */
  groups: ReadonlyMap<string, number>
  ranges: readonly ReviewRangeMark[]
}

export const EMPTY_HIGHLIGHT: ReviewHighlight = { layers: new Map(), ghosts: [], groups: new Map(), ranges: [] }

const LAYER_PREFIX = 'Layer:'

/** Project `changes` onto paintable marks. `decorations` may cover more
 *  changes than `changes` (the Review view's cover both lists); only the
 *  changes given count toward a Group's badge. */
export function buildReviewHighlight(changes: readonly Change[], decorations: readonly GroupDecoration[]): ReviewHighlight {
  if (changes.length === 0) return EMPTY_HIGHLIGHT
  const layers = new Map<string, ReviewClipMark>()
  const ghosts: ReviewGhost[] = []
  const ranges: ReviewRangeMark[] = []
  for (const c of changes) {
    for (const r of c.ranges) ranges.push({ changeId: c.id, cls: c.class, compositionId: r.composition_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
    for (const key of c.keys) {
      if (!key.startsWith(LAYER_PREFIX)) continue
      const layerId = key.slice(LAYER_PREFIX.length)
      if (c.class !== 'removed') { layers.set(layerId, c.class); continue }
      // A removed layer's change carries its baseline track; its single range
      // is where it was, on the current timeline (main's `removedRangeNow`).
      const r = c.ranges[0]
      if (c.from?.track_id && r) {
        ghosts.push({ changeId: c.id, layerId, compositionId: c.from.composition_id, trackId: c.from.track_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
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
  return { layers, ghosts, groups, ranges }
}
