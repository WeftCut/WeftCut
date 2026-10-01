// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Keyframe, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { gridForLayerKind, snapOnGrid } from '../snap'
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

/** Single-layer split (link-unaware). Returns {left,right};
 *  left reuses the original id, right gets a fresh one and is inserted at li+1. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number): { left: Uuid; right: Uuid } {
  const { comp: c, track, layer: original, layerIndex: li } = requireLayer(p, id)
  // The cut resolves on THIS layer's grid, not the composition's — so a linked A/V
  // split cuts the audio on the nearest sample boundary while the video cuts on the
  // frame boundary (spec R2-D6). Locate first: the grid depends on `params.kind`.
  const atTUs = snapOnGrid(atTUsRaw, gridForLayerKind(original.params.kind, c.fps))
  if (atTUs <= original.t_start_us || atTUs >= original.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })
  const splitOffset = atTUs - original.t_start_us

  // RIGHT half — fresh id, [atTUs, original.t_end]. A source window (media or a
  // Group's composition) is divided at the same offset: at speed 1 the source
  // and the timeline advance together.
  const right = cloneLayer(original)
  right.id = idGen()
  right.t_start_us = atTUs
  right.t_end_us = original.t_end_us
  // Split does not re-derive the Motif content cap (no MotifCatalog reaches here;
  // `resolveMotifMaxDurUs` owns it), so a Motif's src_in_us is not rebased.
  const rightCapped = false
  if (hasSourceWindow(right.params)) right.params.src_in_us += splitOffset
  else if (right.params.kind === 'Motif' && rightCapped) right.params.src_in_us += splitOffset
  const rightProgress='transform' in right.params && right.params.transform.position.mode==='Path'?right.params.transform.position.progress:null
  forEachAnimatedF64(right.params, (a) => { if(a===rightProgress) shiftKeyframes(a,-splitOffset); else splitTrackHalf(a, splitOffset, true) })
  forEachAnimatedRgba(right.params, (a) => splitTrackHalf(a, splitOffset, true))

  // LEFT half — reuses original id, [original.t_start, atTUs].
  const left = cloneLayer(original)
  left.t_end_us = atTUs
  if (hasSourceWindow(left.params)) left.params.src_out_us = left.params.src_in_us + splitOffset
  const leftProgress='transform' in left.params && left.params.transform.position.mode==='Path'?left.params.transform.position.progress:null
  forEachAnimatedF64(left.params, (a) => { if(a!==leftProgress) splitTrackHalf(a, splitOffset, false) })
  forEachAnimatedRgba(left.params, (a) => splitTrackHalf(a, splitOffset, false))

  track.layers[li] = left
  track.layers.splice(li + 1, 0, right)
  return { left: id, right: right.id }
}

/** Split with link spanning fan-out, partitioning the link at the cut. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeLink: boolean): { left: Uuid; right: Uuid } {
  // Pre-flight on the target.
  const target = requireLayer(p, id)
  const c = target.comp
  if (target.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: target.track.id })
  const tgt = target.layer
  // Snapped on the TARGET's grid for the pre-flight + containment tests; each
  // spanning sibling then re-snaps `atTUs` on its own grid inside splitSingleLayer.
  const atTUs = snapOnGrid(atTUsRaw, gridForLayerKind(tgt.params.kind, c.fps))
  if (atTUs <= tgt.t_start_us || atTUs >= tgt.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })

  // Spanning siblings: members whose interval strictly contains atTUs (sorted order).
  // linkSiblingsExcluding returns SORTED members — id-allocation order matches Rust OrdSet.
  const spanning: Uuid[] = escapeLink ? [] : linkSiblingsExcluding(c, id).filter((s) => {
    const sl = locateLayerIn(c, s); if (!sl) return false
    return sl.layer.t_start_us < atTUs && atTUs < sl.layer.t_end_us
  })
  if (!escapeLink) checkLinkLock(c, id, [id, ...spanning])

  const link = c.links.find((g) => g.members.includes(id))

  // Split target FIRST (id-allocation order: target right-half id comes first).
  const targetHalves = splitSingleLayer(p, idGen, id, atTUs)
  const rightByLeft = new Map<Uuid, Uuid>([[id, targetHalves.right]])

  // Allocate all layer halves before allocating the new right-side link.
  for (const sid of spanning) {
    const { right: rightId } = splitSingleLayer(p, idGen, sid, atTUs)
    rightByLeft.set(sid, rightId)
  }
  // Link override keeps the original membership and leaves the new half free;
  // unsplit siblings must not bridge the cut back to that half.
  if (link && !escapeLink) {
    const left: Uuid[] = []
    const right: Uuid[] = []
    for (const member of link.members) {
      const half = rightByLeft.get(member)
      if (half !== undefined) {
        left.push(member)
        right.push(half)
      } else {
        const loc = locateLayerIn(c, member)
        if (loc) (loc.layer.t_start_us >= atTUs ? right : left).push(member)
      }
    }
    if (left.length >= 2) link.members = left.sort()
    else c.links.splice(c.links.indexOf(link), 1)
    if (right.length >= 2) c.links.push({ id: idGen(), members: right.sort() })
  }

  return targetHalves
}

/** User-authored batch: validate every cut before splitting; snap, sort and
 *  deduplicate so unsorted/repeated input never cuts the same segment twice.
 *  Unlike detector-derived cuts, invalid endpoints are errors, not skipped. */
export function applySplitLayerBatch(p: Project, idGen: IdGen, id: Uuid, rawCuts: number[], escapeLink: boolean): { layer_ids: Uuid[]; at_t_us: number[] } {
  const { comp, layer } = requireLayer(p, id)
  const grid = gridForLayerKind(layer.params.kind, comp.fps)
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
