// What the timelines paint for a set of review changes (ADR 0115): a pure
// projection of `Change[]` + `GroupDecoration[]` onto the shapes the surfaces
// draw — a mark per current clip, a ghost per removed clip, a cut mark where
// material was taken out, a badge per Group clip containing changes, and time
// ranges per composition for the mini timeline's band.
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

/** Where material was taken out, at an instant of one lane: the seam a ripple
 *  delete closed (`seam`, on the removed clip's baseline track — it replaces
 *  that clip's zero-width ghost), or the end a trim cut back (`trim`, on the
 *  clip's current lane, which the surface resolves: `trackId` null). The only
 *  mark for an edit that left no geometry of its own to colour. Words are the
 *  surface's (`changeWords.ts`), from the change itself. */
export interface ReviewCut {
  changeId: string
  /** The removed clip (`seam`) or the trimmed one (`trim`). */
  layerId: string
  compositionId: string
  trackId: string | null
  tUs: number
  kind: 'seam' | 'trim'
  /** The content after it was carried along (a ripple): which way. */
  carried?: 'earlier' | 'later'
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
  // A carried translation paints nowhere: the edit that carried it is the
  // mark, as a diff does not mark the lines a change above renumbered. Its
  // carrier's cut mark says the content after it moved — a rider's moving
  // too (it paints as the edit of its own it also is).
  const carries = new Map<string, 'earlier' | 'later'>()
  for (const c of changes) {
    if ((!c.carried && c.carried_us === undefined) || c.carried_by === undefined || carries.has(c.carried_by)) continue
    const delta = c.carried ? c.delta_us ?? c.details.find(d => d.type === 'shift')?.delta_us ?? 0 : c.carried_us!
    carries.set(c.carried_by, delta < 0 ? 'earlier' : 'later')
  }
  changes = changes.filter(c => !c.carried)
  if (changes.length === 0) return EMPTY_HIGHLIGHT
  const layers = new Map<string, ReviewClipMark>()
  const layerChanges = new Map<string, string>()
  const ghosts: ReviewGhost[] = []
  const cuts: ReviewCut[] = []
  const ranges: ReviewRangeMark[] = []
  for (const c of changes) {
    for (const r of c.ranges) ranges.push({ changeId: c.id, cls: c.class, compositionId: r.composition_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
    const carried = carries.get(c.id)
    for (const key of c.keys) {
      if (!key.startsWith(LAYER_PREFIX)) continue
      const layerId = key.slice(LAYER_PREFIX.length)
      if (c.class !== 'removed') {
        layers.set(layerId, c.class)
        layerChanges.set(layerId, c.id)
        // A trim that cut material: the end it cut back to. One that added
        // material shows as the clip's own mark; the geometry says the rest.
        const r = c.ranges.find(x => x.composition_id === c.composition_id) ?? c.ranges[0]
        if (r) for (const d of c.details) {
          if (d.type !== 'trim' || d.delta_us >= 0) continue
          cuts.push({ changeId: c.id, layerId, compositionId: r.composition_id, trackId: null, tUs: d.side === 'start' ? r.t_start_us : r.t_end_us, kind: 'trim', ...(carried ? { carried } : {}) })
        }
        continue
      }
      // A removed layer's change carries its baseline track; its single range
      // is where it was, on the current timeline (main's `removedRangeNow`).
      // A ripple delete leaves that range zero-length — the seam it closed — and
      // a zero-width ghost names nothing: the seam is a cut mark instead.
      const r = c.ranges[0]
      if (!c.from?.track_id || !r) continue
      if (r.t_end_us > r.t_start_us) {
        ghosts.push({ changeId: c.id, layerId, compositionId: c.from.composition_id, trackId: c.from.track_id, tStartUs: r.t_start_us, tEndUs: r.t_end_us })
      } else {
        cuts.push({ changeId: c.id, layerId, compositionId: c.from.composition_id, trackId: c.from.track_id, tUs: r.t_start_us, kind: 'seam', ...(carried ? { carried } : {}) })
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
