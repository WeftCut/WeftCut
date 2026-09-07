/// Ripple delete's arithmetic: what a deletion actually vacates, and where every
/// remaining layer lands once that span is closed.
///
/// ONE pure function, for the reason `grid.ts` is one lattice implementation: the
/// mutation applies this plan and the renderer runs the same call against its
/// mirror to grey the row and name the reason, so the promise the UI makes and the
/// edit the actor performs are the same number — and the same refusal.
///
/// Owns: the hole per deleted layer, the merge into disjoint spans, the four
/// pre-mutation refusals, and the landings. Does NOT own the edit — deleting
/// layers, dissolving links, dropping a deleted participant's transition, duration
/// autofit and the last-door validate all belong to the mutation. Refusals are
/// returned as values here; only the mutation throws.
///
/// Renderer-side, for the boundary `grid.ts` records: main may import a pure
/// renderer module, the renderer may never import `main/state`. The views are
/// structural so the actor's `Composition` and the mirror's `CompositionSummary`
/// each adapt through a one-screen mapper instead of this file learning either.
///
/// ADR 0062.
import { layerOverlapClass, shiftOnGrids, type OverlapClass } from '../grid'
import type { CommandError, Rational, TimeUs, Uuid } from '../../shared/commandErrors'

export interface RippleLayerView {
  id: Uuid
  t_start_us: TimeUs
  t_end_us: TimeUs
  locked: boolean
  kind: string
}

export interface RippleTrackView {
  id: Uuid
  locked: boolean
  layers: readonly RippleLayerView[]
}

export interface RippleView {
  fps: Rational
  tracks: readonly RippleTrackView[]
  links: readonly { id: Uuid; members: readonly Uuid[] }[]
  transitions: readonly { from_layer: Uuid; to_layer: Uuid; duration_us: TimeUs }[]
}

/** A span being closed, half-open `[s, e)` — the same convention the overlap rule
 *  uses, so a layer starting exactly at `e` is downstream and not inside. */
export interface RippleHole { s: TimeUs; e: TimeUs }

/** Both endpoints, never a landing plus a duration: a duration is the difference
 *  of two lattice points and is not itself one (see `shiftOnGrids`). */
export interface RippleMove { layer: Uuid; track: Uuid; t_start_us: TimeUs; t_end_us: TimeUs }

export type RipplePlan =
  | { ok: true; holes: RippleHole[]; moves: RippleMove[] }
  | { ok: false; refusal: CommandError }

/** A layer with the two things every step below asks of it: which lane it is on
 *  and which class it competes in. */
interface Placed {
  layer: RippleLayerView
  track: RippleTrackView
  cls: OverlapClass
}

/** A remaining layer as the collision scan sees it: where it ends up. */
interface Landed {
  id: Uuid
  cls: OverlapClass
  start: TimeUs
  end: TimeUs
  moved: boolean
}

/** Canonical unordered layer-pair key for the authorized-overlap map — the same
 *  shape validate's own scan keys its map on. */
function pairKey(a: Uuid, b: Uuid): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * The plan for deleting `deleted` and closing what it vacates, or the refusal
 * that says why not. Pure: `view` is never mutated and nothing is written.
 *
 * The ten steps run in the order they are numbered, and the order is load-bearing
 * twice over. The inside-hole scan precedes the straddle scan, so every remaining
 * link member reaching the straddle test is already known to sit strictly before
 * `s` or at/after `e`. And both precede the landings, so a refusal never depends
 * on arithmetic that a refusal would have invalidated.
 */
export function planRipple(view: RippleView, deleted: readonly Uuid[]): RipplePlan {
  const index = new Map<Uuid, Placed>()
  for (const track of view.tracks)
    for (const layer of track.layers)
      index.set(layer.id, { layer, track, cls: layerOverlapClass(layer) })

  // 1 — dedupe, and refuse an id that names nothing before measuring anything.
  const doomed = new Set<Uuid>()
  const doomedPlaced: Placed[] = []
  for (const id of deleted) {
    const placed = index.get(id)
    if (placed === undefined) return { ok: false, refusal: { error: 'LayerNotFound', layer: id } }
    if (doomed.has(id)) continue
    doomed.add(id)
    doomedPlaced.push(placed)
  }

  // 2 — everything that survives, in track then timeline order. Every later step
  // walks this list, so its order is what makes each refusal deterministic.
  const remaining: Placed[] = []
  for (const track of view.tracks)
    for (const layer of track.layers)
      if (!doomed.has(layer.id)) remaining.push({ layer, track, cls: layerOverlapClass(layer) })

  // 3 — the hole a deleted layer actually vacated: its own footprint, clipped to
  // the same-class neighbours that REMAIN on its own lane. Not `[t_start, t_end)`:
  // a transition overlaps two clips on one track, so a plain length lands the
  // downstream clip on its new predecessor's tail (an incoming participant) or
  // leaves a gap the transition already borrowed (an outgoing one). With no
  // transition the clip's neighbours abut its own edges and the rule degrades to
  // "shift by the layer's length". A gap that already sat beside the layer is
  // NOT closed — it moves left with everything after it.
  const raw: RippleHole[] = []
  for (const d of doomedPlaced) {
    let prevEnd = -Infinity
    let nextStart = Infinity
    for (const other of remaining) {
      if (other.track.id !== d.track.id || other.cls !== d.cls) continue
      if (other.layer.t_start_us < d.layer.t_start_us) prevEnd = Math.max(prevEnd, other.layer.t_end_us)
      else nextStart = Math.min(nextStart, other.layer.t_start_us)
    }
    const s = Math.max(d.layer.t_start_us, prevEnd)
    const e = Math.min(d.layer.t_end_us, nextStart)
    // Empty when a partner's transition already covers the whole clip: nothing
    // was vacated, so nothing moves.
    if (e > s) raw.push({ s, e })
  }

  // 4 — merge across ALL tracks into disjoint ascending spans. Touching counts as
  // overlapping (`h.s <= last.e`), which is what makes a linked V+A pair one hole
  // and one shift, and two adjacent deleted slices one longer hole — the same
  // answer applying them one at a time would have reached.
  const holes: RippleHole[] = []
  for (const h of [...raw].sort((a, b) => a.s - b.s)) {
    const last = holes[holes.length - 1]
    if (last !== undefined && h.s <= last.e) last.e = Math.max(last.e, h.e)
    else holes.push({ s: h.s, e: h.e })
  }

  // 5 — the hole must be clean. A layer that merely reaches into the span from
  // before `s` is anchored ahead of the cut and stays; one that STARTS inside it
  // has nowhere honest to go, so the ripple names it and stops. Earliest hole
  // first, and within a hole the earliest offender, so the sentence points at the
  // first thing that goes wrong in time.
  for (const h of holes) {
    let offender: RippleLayerView | null = null
    for (const r of remaining) {
      if (r.layer.t_start_us < h.s || r.layer.t_start_us >= h.e) continue
      if (offender === null || r.layer.t_start_us < offender.t_start_us) offender = r.layer
    }
    if (offender !== null)
      return { ok: false, refusal: { error: 'RippleInsideHole', layer: offender.id, hole: { s: h.s, e: h.e } } }
  }

  // 6 — a link is "these move together", so a link with a member on each side of
  // a hole has no landing that honours it. Members inside `deleted` are ignored:
  // they are gone, and a link left below two members dissolves as it does for a
  // plain delete.
  for (const h of holes) {
    for (const link of view.links) {
      let before = false
      let after = false
      for (const member of link.members) {
        if (doomed.has(member)) continue
        const placed = index.get(member)
        if (placed === undefined) continue
        if (placed.layer.t_start_us < h.s) before = true
        else if (placed.layer.t_start_us >= h.e) after = true
      }
      if (before && after)
        return { ok: false, refusal: { error: 'RippleLinkStraddles', link: link.id, hole: { s: h.s, e: h.e } } }
    }
  }

  // 7 — a layer's delta is the SUM of the holes entirely to its left, and the
  // landing is ONE `shiftOnGrids` call per distinct delta rather than one snap per
  // hole applied right to left. Summing is not merely cheaper, it is the
  // formulation step 4 already committed to: two touching holes merged into one
  // must land everything downstream exactly where the two separate holes would
  // have, and only a single snap of the total does that — re-snapping after each
  // hole rounds twice and the merged and unmerged answers drift apart. Each mover
  // still snaps on ITS OWN lattice inside `shiftOnGrids`, so a sample-lattice
  // deletion lands audio exactly and visual movers on the nearest frame.
  const deltaOf = new Map<Uuid, number>()
  const byDelta = new Map<number, Placed[]>()
  for (const r of remaining) {
    let delta = 0
    for (const h of holes) if (h.e <= r.layer.t_start_us) delta += h.e - h.s
    if (delta === 0) continue
    deltaOf.set(r.layer.id, delta)
    const bucket = byDelta.get(delta)
    if (bucket === undefined) byDelta.set(delta, [r])
    else bucket.push(r)
  }
  const landings = new Map<Uuid, { tStartUs: number; tEndUs: number }>()
  for (const [delta, members] of byDelta) {
    const shifted = shiftOnGrids(
      members.map((m) => ({ id: m.layer.id, kind: m.layer.kind, tStartUs: m.layer.t_start_us, tEndUs: m.layer.t_end_us })),
      -delta,
      view.fps,
    )
    for (const [id, at] of shifted) landings.set(id, at)
  }

  // 8 — the lenient lock reading: only a layer that would actually shift blocks,
  // so a locked lane holding nothing downstream does not disable the ripple.
  // Track before layer, in two passes rather than one interleaved scan: "unlock
  // the lane" is the coarser remedy and clears every locked layer on it at once,
  // so it is the sentence worth showing first.
  for (const r of remaining)
    if (deltaOf.has(r.layer.id) && r.track.locked)
      return { ok: false, refusal: { error: 'TrackLocked', track: r.track.id } }
  for (const r of remaining)
    if (deltaOf.has(r.layer.id) && r.layer.locked)
      return { ok: false, refusal: { error: 'RippleLockedLayer', layer: r.layer.id } }

  // 9 — the post-move layout, checked by validate's own rule so a plan and the
  // validator cannot disagree: per track, per class, half-open, and a transition
  // authorizes EXACTLY its overlap. The authorization survives only a UNIFORM
  // shift — participants that moved by different amounts (or one that did not
  // move at all) no longer hold the geometry the transition is defined by, and
  // validate would reject the result. The system never makes room.
  //
  // What a uniformly shifted pair authorizes is the overlap it LANDS with, not the
  // stored `duration_us`. A duration is the distance between two lattice points,
  // and at a fractional rate that distance depends on where the pair sits (one
  // frame at 30 fps is 33 333 µs or 33 334 µs by position), so a shift that keeps
  // the frame count can still change the microseconds by one. The mutation
  // re-derives the stored duration from the same landing; refusing here would
  // block a ripple for a rounding artefact and call it a collision.
  const authorized = new Map<string, number>()
  for (const t of view.transitions) {
    if (doomed.has(t.from_layer) || doomed.has(t.to_layer)) continue
    const from = index.get(t.from_layer)
    const to = index.get(t.to_layer)
    if (from === undefined || to === undefined) continue
    const fromDelta = deltaOf.get(t.from_layer) ?? 0
    if (fromDelta !== (deltaOf.get(t.to_layer) ?? 0)) continue
    if (fromDelta === 0) { authorized.set(pairKey(t.from_layer, t.to_layer), t.duration_us); continue }
    const fromEnd = landings.get(t.from_layer)?.tEndUs ?? from.layer.t_end_us
    const toStart = landings.get(t.to_layer)?.tStartUs ?? to.layer.t_start_us
    authorized.set(pairKey(t.from_layer, t.to_layer), fromEnd - toStart)
  }
  for (const track of view.tracks) {
    const after: Landed[] = []
    for (const r of remaining) {
      if (r.track.id !== track.id) continue
      const at = landings.get(r.layer.id)
      after.push({
        id: r.layer.id,
        cls: r.cls,
        start: at?.tStartUs ?? r.layer.t_start_us,
        end: at?.tEndUs ?? r.layer.t_end_us,
        moved: deltaOf.has(r.layer.id),
      })
    }
    after.sort((a, b) => a.start - b.start)
    // The longest-REACHING predecessor of each class, not the nearest: a long clip
    // starting before a short one is the layer a landing can still hit.
    let prevVisual: Landed | null = null
    let prevAudio: Landed | null = null
    for (const l of after) {
      const prev = l.cls === 'visual' ? prevVisual : prevAudio
      if (prev !== null && l.start < prev.end) {
        const overlap = prev.end - l.start
        if ((authorized.get(pairKey(prev.id, l.id)) ?? 0) !== overlap) {
          // `moving` is the layer that shifted; with both shifted it is the
          // later-starting one, which the sort has already put in `l`.
          const moving = l.moved || !prev.moved ? l : prev
          const blocking = moving === l ? prev : l
          return { ok: false, refusal: { error: 'RippleCollision', moving: moving.id, blocking: blocking.id, track: track.id } }
        }
      }
      if (l.cls === 'visual') prevVisual = prevVisual !== null && prevVisual.end >= l.end ? prevVisual : l
      else prevAudio = prevAudio !== null && prevAudio.end >= l.end ? prevAudio : l
    }
  }

  // 10 — a mover starts at or after some hole's `e` and shifts by at most the
  // holes to its left, so it lands at or after that hole's `s`, which is >= 0.
  // Unreachable by construction, and an assert rather than a clamp precisely
  // because a clamp would quietly ship the layout that proved the reasoning
  // wrong. Not a CommandError: no caller can act on it.
  for (const [id, at] of landings)
    if (at.tStartUs < 0) throw new Error(`planRipple: layer ${id} landed at ${at.tStartUs} µs, before composition time 0`)

  const moves: RippleMove[] = []
  for (const r of remaining) {
    const at = landings.get(r.layer.id)
    if (at === undefined) continue
    moves.push({ layer: r.layer.id, track: r.track.id, t_start_us: at.tStartUs, t_end_us: at.tEndUs })
  }
  return { ok: true, holes, moves }
}
