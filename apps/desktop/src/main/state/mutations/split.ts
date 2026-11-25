import { contentAt, sourceIn, sourceOut, writeSourceWindow } from '../../../renderer/layerTiming'
import { exactTime } from '../../../renderer/timeMapping'
// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Keyframe, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { frameGrid, snapOnGrid } from '../snap'
import { CommandFailure } from '../errors'
import { cloneLayer, hasSourceWindow, locateLayerIn, requireLayer } from './helpers'
import { linkSiblingsExcluding, checkLinkLock } from './links'
import { forEachAnimatedF64, forEachAnimatedRgba, retainKeyframes, shiftKeyframes, firstKeyframeValue, lastKeyframeValue, collapseToStatic } from './animated'

/** Partition one Animated<T> track for a split at the
 *  clip-local `splitOffset`. LEFT keeps t<=offset; RIGHT keeps t>offset, rebased
 *  by -offset. An emptied Keyframed half collapses to Static at the boundary value
 *  (LEFT→first, RIGHT→last). */
function splitTrackHalf<T>(a: Animated<T>, splitOffset: number, right: boolean): void {
  const boundary = right ? lastKeyframeValue(a) : firstKeyframeValue(a)
  if (right) { retainKeyframes(a, (t) => t > splitOffset); shiftKeyframes(a, -splitOffset) }
  else { retainKeyframes(a, (t) => t <= splitOffset) }
  if (a.mode === 'Keyframed' && (a.value as Keyframe<T>[]).length === 0 && boundary !== null) collapseToStatic(a, boundary)
}

/** Which half of a cut keeps the layer's id; the other half draws a fresh one.
 *  Everything that names a layer by id — the transitions it takes part in, the
 *  markers anchored to it, the selection — stays with the half that keeps it, so
 *  an edit that cuts and then deletes one half keeps the id on the half that
 *  survives (`applyRippleDeletePart`). A plain split keeps it on the left. */
export type SplitKeep = 'left' | 'right'

/** The two halves one layer was cut into. */
export interface SplitHalves { left: Uuid; right: Uuid }

/** Single-layer split (link-unaware). The `keep` half reuses the original id,
 *  the other gets a fresh one; the right half is inserted at li+1. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, keep: SplitKeep): SplitHalves {
  const { comp: c, track, layer: original, layerIndex: li } = requireLayer(p, id)
  // The cut resolves on the frame grid, so a linked A/V split cuts both members
  // at the same instant.
  const atTUs = snapOnGrid(atTUsRaw, frameGrid(c.fps))
  if (atTUs <= original.t_start_us || atTUs >= original.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })
  const splitOffset = atTUs - original.t_start_us

  // RIGHT half — [atTUs, original.t_end]. A source window (media or a
  // Group's composition) is divided at the same offset: at speed 1 the source
  // and the timeline advance together.
  const right = cloneLayer(original)
  right.id = idGen()
  right.t_start_us = atTUs
  right.t_end_us = original.t_end_us
  // Split does not re-derive the Motif content cap (no MotifCatalog reaches here;
  // `resolveMotifMaxDurUs` owns it), so a Motif's src_in_us is not rebased.
  if (hasSourceWindow(right.params) || right.params.kind === 'Motif' || right.params.kind === 'ImageOverlay')
    writeSourceWindow(right.params, contentAt(original.params, exactTime(splitOffset)), sourceOut(original));
  const rightProgress='transform' in right.params && right.params.transform.position.mode==='Path'?right.params.transform.position.progress:null
  forEachAnimatedF64(right.params, (a) => { if(a===rightProgress || 'time_map' in original.params) shiftKeyframes(a,-splitOffset); else splitTrackHalf(a, splitOffset, true) })
  forEachAnimatedRgba(right.params, (a) => 'time_map' in original.params ? shiftKeyframes(a, -splitOffset) : splitTrackHalf(a, splitOffset, true))
  for (const effect of right.effects) for (const track of Object.values(effect.params)) shiftKeyframes(track, -splitOffset)

  // LEFT half — [original.t_start, atTUs].
  const left = cloneLayer(original)
  left.t_end_us = atTUs
  if (hasSourceWindow(left.params) || left.params.kind === 'Motif' || left.params.kind === 'ImageOverlay')
    writeSourceWindow(left.params, sourceIn(original.params), contentAt(original.params, exactTime(splitOffset)));
  const leftProgress='transform' in left.params && left.params.transform.position.mode==='Path'?left.params.transform.position.progress:null
  forEachAnimatedF64(left.params, (a) => { if(a!==leftProgress && !('time_map' in original.params)) splitTrackHalf(a, splitOffset, false) })
  forEachAnimatedRgba(left.params, (a) => { if (!('time_map' in original.params)) splitTrackHalf(a, splitOffset, false) })

  if (keep === 'right') { left.id = right.id; right.id = id }
  track.layers[li] = left
  track.layers.splice(li + 1, 0, right)
  return { left: left.id, right: right.id }
}

/** Split with link spanning fan-out, partitioning the link at the cut. The
 *  target's halves; `applySplitLinked` has every member's. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeLink: boolean): SplitHalves {
  return applySplitLinked(p, idGen, id, atTUsRaw, escapeLink, 'left')[0]
}

/** Split with link spanning fan-out, partitioning the link at the cut. Returns
 *  the halves of every layer the cut went through, the target's first. The side
 *  holding the original ids keeps the link's id; the other side's members, when
 *  two or more, form a new link. */
export function applySplitLinked(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeLink: boolean, keep: SplitKeep): SplitHalves[] {
  // Pre-flight on the target.
  const target = requireLayer(p, id)
  const c = target.comp
  if (target.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: target.track.id })
  const tgt = target.layer
  // Snapped for the pre-flight + containment tests; each spanning sibling is cut
  // at this same `atTUs`.
  const atTUs = snapOnGrid(atTUsRaw, frameGrid(c.fps))
  if (atTUs <= tgt.t_start_us || atTUs >= tgt.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })

  // Spanning siblings: members whose interval strictly contains atTUs (sorted order).
  // linkSiblingsExcluding returns SORTED members — id-allocation order matches Rust OrdSet.
  const spanning: Uuid[] = escapeLink ? [] : linkSiblingsExcluding(c, id).filter((s) => {
    const sl = locateLayerIn(c, s); if (!sl) return false
    return sl.layer.t_start_us < atTUs && atTUs < sl.layer.t_end_us
  })
  if (!escapeLink) checkLinkLock(c, id, [id, ...spanning])

  const link = c.links.find((g) => g.members.includes(id))

  // Split target FIRST (id-allocation order: the target's fresh half id comes first).
  const halvesOf = new Map<Uuid, SplitHalves>([[id, splitSingleLayer(p, idGen, id, atTUs, keep)]])

  // Allocate all layer halves before allocating the new link.
  for (const sid of spanning) halvesOf.set(sid, splitSingleLayer(p, idGen, sid, atTUs, keep))
  // Link override keeps the original membership and leaves the fresh half free;
  // unsplit siblings must not bridge the cut back to that half.
  if (link && !escapeLink) {
    const left: Uuid[] = []
    const right: Uuid[] = []
    for (const member of link.members) {
      const halves = halvesOf.get(member)
      if (halves !== undefined) {
        left.push(halves.left)
        right.push(halves.right)
      } else {
        const loc = locateLayerIn(c, member)
        if (loc) (loc.layer.t_start_us >= atTUs ? right : left).push(member)
      }
    }
    const [kept, fresh] = keep === 'left' ? [left, right] : [right, left]
    if (kept.length >= 2) link.members = kept.sort()
    else c.links.splice(c.links.indexOf(link), 1)
    if (fresh.length >= 2) c.links.push({ id: idGen(), members: fresh.sort() })
  }

  return [...halvesOf.values()]
}

/** User-authored batch: validate every cut before splitting; snap, sort and
 *  deduplicate so unsorted/repeated input never cuts the same segment twice.
 *  Unlike detector-derived cuts, invalid endpoints are errors, not skipped. */
export function applySplitLayerBatch(p: Project, idGen: IdGen, id: Uuid, rawCuts: number[], escapeLink: boolean): { layer_ids: Uuid[]; at_t_us: number[] } {
  const { comp, layer } = requireLayer(p, id)
  const grid = frameGrid(comp.fps)
  const cuts = [...new Set(rawCuts.map((at) => snapOnGrid(at, grid)))].sort((a, b) => a - b)
  for (const at of cuts) {
    if (at <= layer.t_start_us || at >= layer.t_end_us)
      throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: at })
  }
  const ids: Uuid[] = []
  let currentId = id
  for (const at of cuts) {
    const { left, right } = applySplitLayer(p, idGen, currentId, at, escapeLink)
    ids.push(left)
    currentId = right
  }
  ids.push(currentId)
  return { layer_ids: ids, at_t_us: cuts }
}

/** Validate the set of segments a multi-split should delete in its own commit,
 *  against the `cuts + 1` segments that split will produce. Indices are 0-based
 *  in timeline order and counted BEFORE any `drop_short_us` pruning, so a caller
 *  can name them off the cut list alone instead of predicting which segments the
 *  length filter is about to take.
 *
 *  Naming EVERY segment is refused: erasing the whole clip is `delete_layers`,
 *  and an apply that answered "keep nothing" by deleting what it was applied to
 *  would be a destructive reading of a request that never said delete.
 *
 *  A result rather than a throw, because the two callers refuse in different
 *  shapes — the dispatch returns a `CommandError`, the hybrid channel throws a
 *  JSON string — and the same rule written out at both would be free to drift. */
export function parseDiscardSegments(
  raw: unknown,
  segmentCount: number,
): { ok: true; value: number[] } | { ok: false; detail: string } {
  if (!Array.isArray(raw))
    return { ok: false, detail: `discard_segments must be an array of segment indices, got ${typeof raw}` }
  const seen = new Set<number>()
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
      return { ok: false, detail: `discard_segments[${i}] is ${String(v)} — every entry must be a non-negative integer` }
    if (v >= segmentCount)
      return { ok: false, detail: `discard_segments[${i}] (${v}) is out of range — the split produces ${segmentCount} segment(s), numbered 0..${segmentCount - 1}` }
    if (seen.has(v))
      return { ok: false, detail: `discard_segments[${i}] (${v}) is named twice` }
    seen.add(v)
  }
  if (seen.size === segmentCount)
    return { ok: false, detail: `discard_segments names all ${segmentCount} segment(s) — discarding every segment is a delete, not an apply` }
  return { ok: true, value: [...seen] }
}
