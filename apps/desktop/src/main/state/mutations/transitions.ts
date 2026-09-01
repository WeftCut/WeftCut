import type { Composition, Layer, Project, Transition, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { frameIndexRound, gridForLayerKind, shiftOnGrids, snapOnGrid, timeUsAtFrame } from '../snap'
import { applyDurationAutofit, hasSourceWindow, locateLayerIn, pickFreeOverlayTrack, requireLayer, sourceDurationUs } from './helpers'
import { applyAddTrack } from './add'
import { checkLinkLock, linkSiblingsExcluding, indexLinks } from './links'

// ── Geometry vocabulary (ADR 0048 — extended_us provenance and inverse-op routing) ──
// A = from_layer (outgoing), B = to_layer (incoming); the window is
// [B.t_start_us, A.t_end_us]; d = duration_us = A.end − B.start (validate's
// overlap === duration equality); e = extended_us with 0 ≤ e ≤ d STORED (an
// explicit update may TARGET e′ < 0 — the deliberate tail trim past S — but
// what lands is clamped back to 0 because the trim moves S itself); and
// S = A.end − e is A's SACRED end — the exit frame the user cut, always a
// canonical frame boundary. Endpoint moves are computed in FRAME INDICES
// between canonical boundaries (never bare rate-derived µs — see
// wholeFrameDurationUs for why fractional rates forbid that) and only the
// resulting canonical-boundary distances are applied as µs deltas.
//
// A transition's participants share a track, so they share a composition: every
// helper below takes that composition, located once from a participant.

/** Extend t_end_us (and src_out_us for kinds with a source window) by deltaUs.
 *  Used by the transition mutations to borrow outgoing-tail handle material —
 *  the only writes that grow `extended_us`.
 *
 *  Raw µs, deliberately: the caller derives the delta as the distance between
 *  two canonical frame boundaries, so adding it keeps a canonical `t_end_us`
 *  canonical. A rate-derived "n frames in µs" would not. */
export function extendLayerTEnd(layer: Layer, deltaUs: number): void {
  layer.t_end_us += deltaUs
  if (hasSourceWindow(layer.params)) layer.params.src_out_us += deltaUs
}

/** Inverse of extendLayerTEnd; saturates at 0. Used by the transition mutations
 *  to return borrowed handle material (never more than `extended_us`, so a
 *  pre-positioned overlap's real content is never trimmed). */
export function shrinkLayerTEnd(layer: Layer, deltaUs: number): void {
  layer.t_end_us = Math.max(layer.t_end_us - deltaUs, 0)
  if (hasSourceWindow(layer.params)) layer.params.src_out_us = Math.max(layer.params.src_out_us - deltaUs, 0)
}

/** Tail handle: source content remaining past src_out_us, in µs — media past
 *  the clip's out point, or a Group's composition past its window. Free-duration
 *  kinds (Image/Text/Motif/Color) are unlimited. A null/undefined (or missing-
 *  media) duration means unknowable → unlimited too, mirroring how the
 *  SrcRangeExceedsMedia validation only fires when duration is non-null. */
function tailHandleUs(p: Project, layer: Layer): number {
  const pa = layer.params
  if (!hasSourceWindow(pa)) return Infinity
  const dur = sourceDurationUs(p, pa)
  if (dur === null) return Infinity
  return Math.max(dur - pa.src_out_us, 0)
}

/** A requested span as a whole number of composition frames. FAILS a request
 *  under half a frame (precise, pre-id-mint) rather than collapsing to a
 *  zero-length transition. */
function requestedFrames(c: Composition, requestedUs: number, field: string): number {
  const { num, den } = c.fps
  // A span and an absolute time share the same index arithmetic, so the round
  // INDEX policy doubles as "how many frames long is this".
  const frames = frameIndexRound(requestedUs, num, den)
  if (frames < 1)
    throw new CommandFailure({ error: 'InvalidArgument', field,
      detail: `${requestedUs}µs is under half a frame at ${num}/${den} fps; a transition spans at least 1 composition frame` })
  return frames
}

/** A transition duration rounded to a whole number of composition frames, in µs,
 *  measured FROM `cutUs` (the incoming layer's head, where the overlap starts).
 *
 *  Anchored at the cut rather than derived from the rate alone because at
 *  fractional rates `canonical(k) + canonical(n) != canonical(k + n)` — at
 *  30000/1001 they differ by up to 1 µs — so a bare "n frames in µs" would push
 *  the outgoing layer's `t_end_us` off the grid or break validate's
 *  `overlap === duration_us`; both cannot hold. The distance between two
 *  canonical boundaries satisfies both at once. */
function wholeFrameDurationUs(c: Composition, cutUs: number, requestedUs: number): number {
  const { num, den } = c.fps
  const frames = requestedFrames(c, requestedUs, 'duration_us')
  return timeUsAtFrame(frameIndexRound(cutUs, num, den) + frames, num, den) - cutUs
}

/** TrackLocked for a transition op's home lane, by index. Transitions are the
 *  one mutation family whose subject (the transition record) is not a layer,
 *  so the move/trim/split lock convention lands here as a whole-command gate:
 *  add/update/remove all retime, borrow, or re-authorize rendering on the
 *  participants' shared lane, and a kind-only patch is no exception — locked
 *  means untouchable, not merely un-retimable. Linked siblings on OTHER lanes
 *  keep their own gate (checkLinkLock via incomingMoveSet). */
function checkTransitionTrackLock(c: Composition, trackIdx: number): void {
  if (c.tracks[trackIdx].locked)
    throw new CommandFailure({ error: 'TrackLocked', track: c.tracks[trackIdx].id })
}

/** Audio participants are rejected here (precise, pre-id-mint error); validate's
 *  TransitionUnsupportedLayerKind rule is the backstop no path can bypass. */
function rejectAudioParticipant(layer: Layer): void {
  if (layer.params.kind === 'Audio')
    throw new CommandFailure({ error: 'TransitionUnsupportedLayerKind', layer: layer.id, kind: layer.params.kind })
}

/** Where each member of `memberIds` lands under a `deltaUs` shift — the shared
 *  arithmetic (`renderer/grid.ts`), fed from this composition. Both the write
 *  and the pre-check that guards it read this one map, so they cannot round
 *  apart. An unlocatable member simply has no entry. */
function shiftedSpans(c: Composition, memberIds: readonly Uuid[], deltaUs: number): Map<Uuid, { tStartUs: number; tEndUs: number }> {
  return shiftOnGrids(
    memberIds.flatMap((id) => {
      const loc = locateLayerIn(c, id)
      return loc ? [{ id, kind: loc.layer.params.kind, tStartUs: loc.layer.t_start_us, tEndUs: loc.layer.t_end_us }] : []
    }),
    deltaUs, c.fps,
  )
}

/** Shift a moving set (the incoming layer + its link siblings) by ONE µs delta,
 *  each member landing on its OWN lattice, and re-insert each at its track's
 *  sorted position — the applyMoveLayer discipline verbatim.
 *
 *  Not "the same as move.ts" by convention — literally the same function
 *  (`shiftOnGrids`, `renderer/grid.ts`), which owns the reason a member snaps
 *  on ITS OWN grid: on the frame grid a linked audio member would be dragged to
 *  the nearest video frame on every duration edit and a deliberately slipped
 *  sync offset would silently go with it. An unlocatable member is skipped, the
 *  move loop's own tolerance for a stale id. */
function shiftLayerSet(c: Composition, memberIds: readonly Uuid[], deltaUs: number): void {
  if (deltaUs === 0) return
  const landings = shiftedSpans(c, memberIds, deltaUs)
  // Located again per member, deliberately: the splice below invalidates any
  // index taken during the pass above, and re-locating is the loop's existing
  // tolerance for a member that has since gone.
  for (const id of memberIds) {
    const loc = locateLayerIn(c, id)
    if (!loc) continue
    const track = loc.track
    const l = track.layers.splice(loc.layerIndex, 1)[0]
    const landed = landings.get(id)!
    l.t_start_us = landed.tStartUs
    l.t_end_us = landed.tEndUs
    const at = track.layers.findIndex((x) => x.t_start_us > l.t_start_us)
    track.layers.splice(at < 0 ? track.layers.length : at, 0, l)
  }
}

/** The moving set for the incoming layer's shift: B + its link siblings, with
 *  the link-lock check up front (before ANY mutation, so a plain-object caller
 *  sees a clean refusal too — inside commit the discarded draft makes ordering
 *  moot, but the mutation tests run on plain objects). */
function incomingMoveSet(c: Composition, toLayer: Uuid): Uuid[] {
  const siblings = linkSiblingsExcluding(c, toLayer)
  if (siblings.length > 0) checkLinkLock(c, toLayer, [toLayer, ...siblings])
  return [toLayer, ...siblings]
}

/** One sibling relocation performed by an overlap-placement add: `layer` left
 *  `from_track` for `to_track` because its shifted span collided with a
 *  non-moving layer; `spawned` marks a lane minted for the landing. Primitive
 *  fields only — the actor arm carries these OUT of the immer recipe (a draft
 *  reference would be revoked) and into LogBus rows. */
export interface TransitionBounce { layer: Uuid; from_track: Uuid; to_track: Uuid; spawned: boolean }

/** Bounce pass for an overlap add's moved LINK SIBLINGS (ADR 0042: no free
 *  lane, so make one). Runs AFTER the shift: a sibling whose lane now holds a
 *  NON-moving layer of its own overlap class (audio vs visual — the lane law)
 *  over its span moves to the first free overlay lane, spawning one when none
 *  exists. Members of the moving set never collide with each other (same
 *  delta, same relative order), so only non-movers are scanned. One sibling at
 *  a time against CURRENT state, so an earlier bounce's landing blocks a later
 *  one from claiming the same lane. The incoming layer itself never bounces —
 *  an unauthorized overlap from ITS move is a whole-commit validate refusal.
 *  No pruneEmptiedTrack: the blocking layer that caused the bounce stays on
 *  the vacated lane, so a bounce can never empty it. */
function bounceCollidingSiblings(p: Project, c: Composition, idGen: IdGen, memberIds: readonly Uuid[], toLayer: Uuid, out: TransitionBounce[]): void {
  const moving = new Set(memberIds)
  for (const id of memberIds) {
    if (id === toLayer) continue
    const loc = locateLayerIn(c, id)
    if (!loc) continue
    const track = loc.track
    const l = loc.layer
    const cls = l.params.kind === 'Audio' ? 'audio' : 'visual'
    const collides = track.layers.some((other) =>
      !moving.has(other.id) && (other.params.kind === 'Audio' ? 'audio' : 'visual') === cls
      && other.t_start_us < l.t_end_us && l.t_start_us < other.t_end_us)
    if (!collides) continue
    const free = pickFreeOverlayTrack(c, l.t_start_us, l.t_end_us)
    // A track id minted for the landing is acceptable pre-transition-id use —
    // the same discipline as applyMoveLayersToNewTrack's lane mint.
    const destId = free ?? applyAddTrack(p, idGen, null, undefined, c.id)
    const dest = c.tracks.find((t) => t.id === destId)!
    track.layers.splice(track.layers.findIndex((x) => x.id === id), 1)
    const at = dest.layers.findIndex((x) => x.t_start_us > l.t_start_us)
    dest.layers.splice(at < 0 ? dest.layers.length : at, 0, l)
    out.push({ layer: id, from_track: track.id, to_track: destId, spawned: free === null })
  }
}

/** A transition with the composition that holds it, or TransitionNotFound. */
function requireTransition(p: Project, id: Uuid): { comp: Composition; transition: Transition; index: number } {
  for (const c of Object.values(p.compositions)) {
    const index = c.transitions.findIndex((t) => t.id === id)
    if (index >= 0) return { comp: c, transition: c.transitions[index], index }
  }
  throw new CommandFailure({ error: 'TransitionNotFound', transition: id })
}

/** add_transition. Both layers must live on the SAME track. Cases:
 *
 *  - exact-adjacent cut, `placement: 'overlap'` (the default): the incoming
 *    layer (and its link siblings) moves LEFT by the frame-rounded duration —
 *    both participants play exactly their trimmed ranges; `extended_us = 0`.
 *    Colliding shifted siblings bounce lanes (bounceCollidingSiblings); the
 *    vacated span stays a gap (no ripple).
 *  - exact-adjacent cut, `placement: 'extend'`: the explicit tail borrow —
 *    pre-checked
 *    against the outgoing tail handle, positions untouched;
 *    `extended_us = duration`.
 *  - pre-overlapped by exactly duration: classifies as overlap under BOTH
 *    placements — nothing moves, `extended_us = 0`.
 *  - anything else: TransitionLayersNotAdjacent.
 *
 *  Every refusal is pre-id-mint (LayerNotFound / TrackLocked /
 *  TransitionUnsupportedLayerKind / TransitionInsufficientHandle /
 *  TransitionLayersNotAdjacent / the overlap branch's
 *  TransitionDurationOutOfRange, TransitionParticipantsShareLink,
 *  NegativeLayerStart and link-lock refusals burn no id); the transition id is
 *  minted after them all but BEFORE commit's validate — a downstream
 *  ValidationFailed burns it (the keystone landmine). A bounce-spawned track id
 *  is minted before the transition id by design. */
export function applyAddTransition(
  p: Project, idGen: IdGen, fromLayer: Uuid, toLayer: Uuid, durationUs: number,
  kind: Transition['kind'], placement: 'overlap' | 'extend' = 'overlap',
): { id: Uuid; bounces: TransitionBounce[] } {
  const from = requireLayer(p, fromLayer)
  const c = from.comp
  const trackIdx = from.trackIndex
  const toIdx = from.track.layers.findIndex((l) => l.id === toLayer)
  if (toIdx < 0) throw new CommandFailure({ error: 'LayerNotFound', layer: toLayer })
  // Same-track invariant ⇒ ONE lock check covers both participants: every
  // branch below retimes or borrows content on this lane (even the
  // pre-overlapped one authorizes new rendering over it), and a locked lane is
  // untouchable by any mutation (the move/trim/split convention).
  checkTransitionTrackLock(c, trackIdx)

  const fromLayerObj = from.layer
  const toLayerObj = from.track.layers[toIdx]
  rejectAudioParticipant(fromLayerObj)
  rejectAudioParticipant(toLayerObj)

  const fromEnd = fromLayerObj.t_end_us
  const toStart = toLayerObj.t_start_us
  const curOverlap = Math.max(fromEnd - toStart, 0)
  const bounces: TransitionBounce[] = []
  let durUs: number
  let extendedUs: number
  if (curOverlap === 0 && fromEnd === toStart) {
    if (placement === 'extend') {
      durUs = wholeFrameDurationUs(c, toStart, durationUs)
      const available = tailHandleUs(p, fromLayerObj)
      if (available < durUs)
        throw new CommandFailure({ error: 'TransitionInsufficientHandle', layer: fromLayer, available_us: available })
      extendLayerTEnd(fromLayerObj, durUs)
      extendedUs = durUs // the whole overlap is borrowed tail
    } else {
      // The window is [B.start′, C] with the cut C = A.end already canonical, so
      // the duration is measured BACKWARD from the cut: B.start′ is the canonical
      // boundary `frames` below it and d is that distance. Same fractional-rate
      // why as wholeFrameDurationUs, mirrored — at 1001-denominator rates a bare
      // "n frames in µs" differs from the boundary distance by up to 1 µs, which
      // would put B.start′ off the grid or break validate's overlap === duration.
      const { num, den } = c.fps
      const frames = requestedFrames(c, durationUs, 'duration_us')
      const newStartUs = timeUsAtFrame(frameIndexRound(fromEnd, num, den) - frames, num, den)
      durUs = fromEnd - newStartUs
      // d ≤ min(len_A, len_B): both participants must exist for the whole window
      // (layer spans in µs; NO tail-handle check — no source material is touched).
      // This bound also keeps B.start′ ≥ A.start ≥ 0, so B itself can never cross
      // t = 0 below. `transition: null` — refused before any id exists.
      const maxDur = Math.min(fromEnd - fromLayerObj.t_start_us, toLayerObj.t_end_us - toStart)
      if (durUs > maxDur)
        throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'TransitionDurationOutOfRange', transition: null, duration: durUs } })
      // Participants sharing a link: moving B would drag A along and the
      // overlap never opens. Structured refusal, never a silent extend fallback.
      const linkIdx = indexLinks(c.links)
      const fromLink = linkIdx.get(fromLayer)
      if (fromLink !== undefined && fromLink === linkIdx.get(toLayer))
        throw new CommandFailure({ error: 'TransitionParticipantsShareLink', from: fromLayer, to: toLayer })
      const moveSet = incomingMoveSet(c, toLayer) // link-lock refusal inside
      // Zero-cross pre-check over the whole moving set, mirroring shiftLayerSet's
      // own-lattice snap: B cannot cross (see maxDur), but an earlier-starting
      // link sibling can. Pre-mint and pre-mutation, like every refusal here.
      for (const id of moveSet) {
        const loc = locateLayerIn(c, id)
        if (!loc) continue
        const l = loc.layer
        const destStart = snapOnGrid(l.t_start_us - durUs, gridForLayerKind(l.params.kind, c.fps))
        if (destStart < 0)
          throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'NegativeLayerStart', layer: id, t_start: destStart } })
      }
      shiftLayerSet(c, moveSet, -durUs)
      bounceCollidingSiblings(p, c, idGen, moveSet, toLayer, bounces)
      extendedUs = 0
    }
    applyDurationAutofit(c) // both adjacent branches retime an edge (A.end grows / B's set moves)
  } else {
    durUs = wholeFrameDurationUs(c, toStart, durationUs)
    if (curOverlap === durUs) { extendedUs = 0 /* pre-positioned; pure placement — overlap under BOTH placements; nothing moves, no autofit */ }
    else throw new CommandFailure({ error: 'TransitionLayersNotAdjacent', from: fromLayer, to: toLayer, duration: durUs })
  }

  const id = idGen() // after ALL checks, before commit's validate (keystone)
  c.transitions.push({ id, from_layer: fromLayer, to_layer: toLayer, duration_us: durUs, kind, extended_us: extendedUs })
  return { id, bounces }
}

/** update_transition — patch { duration_us?, kind?, extended_us? } on one
 *  transition (direction rides inside kind). Patch semantics so the actor
 *  exposes it as ONE recorded command (one undo step). Mints no ids. A locked
 *  home lane refuses the whole patch (TrackLocked, kind-only included).
 *
 *  The targets (d′, e′) fully determine both window edges, anchored on A's
 *  sacred end S: A.end′ = S + e′ frames and B.start′ = A.end′ − d′ frames, all
 *  on canonical boundaries. An explicit NEGATIVE e′ is legal and aims A.end′
 *  LEFT of S — return all borrow, then trim A's real tail by the remainder
 *  (the chip's right edge dragged past S, spec D6); it is the only operation
 *  that moves the sacred end. Requested µs values round to whole frames first,
 *  so a request that rounds to the current values stays a full no-op. When
 *  `extended_us` is OMITTED the routing is sanctity-preferring (ADR 0048):
 *  growth never borrows (e′ = e, B moves left); shrink returns borrowed handle
 *  first (e′ = max(0, e − Δd)) and moves B right by the remainder. Only an
 *  explicit `extended_us` can grow the borrow, and ONLY that path (e′ > e)
 *  gets the tail-handle pre-check — shrinking and pure-placement growth touch
 *  no source material.
 *
 *  B's move takes its link siblings along on their own lattices (shiftLayerSet).
 *  Collisions from B's move and a negative B start are deliberately NOT checked
 *  here: commit's validate is the backstop (LayerOverlap / NegativeLayerStart →
 *  whole-commit refusal) — no clamping, no bouncing. A following transition
 *  B→C that B's move breaks is dropped by commit's reconcile (Policy B), the
 *  designed outcome.
 *
 *  Kind change is a pure field swap, never geometry. */
export function applyUpdateTransition(p: Project, transitionId: Uuid, patch: { duration_us?: number; kind?: Transition['kind']; extended_us?: number }): void {
  const { comp: c, transition: tr } = requireTransition(p, transitionId)
  // Whole-command lock gate, kind-only patches included (see
  // checkTransitionTrackLock). Either participant locates the shared lane; a
  // healthy state always has both (reconcile drops orphans on every commit).
  const gateLoc = locateLayerIn(c, tr.from_layer) ?? locateLayerIn(c, tr.to_layer)
  if (gateLoc) checkTransitionTrackLock(c, gateLoc.trackIndex)
  const requestedDur = patch.duration_us
  const requestedExt = patch.extended_us
  if (requestedDur !== undefined || requestedExt !== undefined) {
    if (requestedDur !== undefined && requestedDur <= 0)
      throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'TransitionDurationOutOfRange', transition: transitionId, duration: requestedDur } })
    const fromLoc = locateLayerIn(c, tr.from_layer)
    if (!fromLoc) throw new CommandFailure({ error: 'LayerNotFound', layer: tr.from_layer })
    const toLoc = locateLayerIn(c, tr.to_layer)
    if (!toLoc) throw new CommandFailure({ error: 'LayerNotFound', layer: tr.to_layer })
    const fromLayerObj = fromLoc.layer
    const toLayerObj = toLoc.layer
    const { num, den } = c.fps

    // Current geometry in frame indices. A.end and S are canonical boundaries
    // (S by the extended_us invariant), so the differences are exact counts.
    const endFrame = frameIndexRound(fromLayerObj.t_end_us, num, den)
    const sFrame = frameIndexRound(fromLayerObj.t_end_us - tr.extended_us, num, den)
    const eFrames = endFrame - sFrame
    const dFrames = endFrame - frameIndexRound(toLayerObj.t_start_us, num, den)

    const dTargetFrames = requestedDur !== undefined ? requestedFrames(c, requestedDur, 'duration_us') : dFrames
    let eTargetFrames: number
    if (requestedExt !== undefined) {
      // Explicit target: the only path that can GROW e, and — when negative —
      // the only path that can move the sacred end LEFT (the genuine tail trim;
      // the frame formulas below already land A.end′ at S + e′ for e′ < 0, and
      // shrinkLayerTEnd keeps src_out in sync). D5 routing never produces
      // either direction, so who touched A's material is always attributable to
      // a deliberate act. e′ ≤ d′ is a request-shape constraint on the
      // frame-rounded values the apply will use; the stored counter clamps at 0
      // below, so validate's structural rule stays intact.
      eTargetFrames = frameIndexRound(requestedExt, num, den)
      if (eTargetFrames > dTargetFrames)
        throw new CommandFailure({ error: 'InvalidArgument', field: 'extended_us', detail: `${requestedExt}µs exceeds the transition duration; extended_us is at most duration_us (a negative value is a deliberate tail trim)` })
    } else {
      // Sanctity-preferring routing (ADR 0048): growth keeps e′ = e; shrink returns
      // the borrow first and moves B right only for the remainder. Both stay in
      // [0, d′] by construction (e ≤ d, so e − (d − d′) ≤ d′).
      const deltaDFrames = dTargetFrames - dFrames
      eTargetFrames = deltaDFrames >= 0 ? eFrames : Math.max(0, eFrames + deltaDFrames)
    }

    const newEndUs = timeUsAtFrame(sFrame + eTargetFrames, num, den)
    const newStartUs = timeUsAtFrame(sFrame + eTargetFrames - dTargetFrames, num, den)
    const endDelta = newEndUs - fromLayerObj.t_end_us
    const startDelta = newStartUs - toLayerObj.t_start_us
    if (endDelta !== 0 || startDelta !== 0) {
      // Link-lock refusal before any write (see incomingMoveSet).
      const moveSet = startDelta !== 0 ? incomingMoveSet(c, tr.to_layer) : []
      if (endDelta > 0) {
        // e′ > e is the ONLY handle-consuming direction, so only it pre-checks.
        const available = tailHandleUs(p, fromLayerObj)
        if (available < endDelta)
          throw new CommandFailure({ error: 'TransitionInsufficientHandle', layer: tr.from_layer, available_us: available })
        extendLayerTEnd(fromLayerObj, endDelta)
      } else if (endDelta < 0) shrinkLayerTEnd(fromLayerObj, -endDelta)
      shiftLayerSet(c, moveSet, startDelta)
      tr.duration_us = newEndUs - newStartUs
      // Negative e′ (tail trim) stores 0, never a negative counter: the trim
      // moved the sacred end itself, so post-commit NOTHING is borrowed.
      tr.extended_us = Math.max(0, newEndUs - timeUsAtFrame(sFrame, num, den))
      applyDurationAutofit(c)
    }
  }
  if (patch.kind !== undefined) tr.kind = patch.kind
}

/** Destination-collision pre-check for remove's restore move: each moving
 *  member's shifted span (snapped exactly as shiftLayerSet will snap it) must
 *  not overlap any NON-moving layer of its own overlap class on its track.
 *  `shrunkFromEnd` substitutes the outgoing layer's post-restore end (S) so the
 *  incoming layer landing flush against it — the whole point of the restore —
 *  is not misread as a collision with the not-yet-shrunk tail. Throws the
 *  structured refusal naming the member that cannot land; the system never
 *  makes room (the user may have filled the vacated gap deliberately). */
function precheckRestoreCollision(c: Composition, memberIds: readonly Uuid[], deltaUs: number, fromLayer: Uuid, shrunkFromEnd: number | null): void {
  // The SAME call `shiftLayerSet` will make, not a re-derivation of it: a
  // pre-check that rounded differently from the write it guards would refuse
  // landings that fit and admit ones that do not.
  const landings = shiftedSpans(c, memberIds, deltaUs)
  const moving = new Set(memberIds)
  for (const id of memberIds) {
    const loc = locateLayerIn(c, id)
    if (!loc) continue
    const l = loc.layer
    const { tStartUs: destStart, tEndUs: destEnd } = landings.get(id)!
    const cls = l.params.kind === 'Audio' ? 'audio' : 'visual'
    for (const other of loc.track.layers) {
      if (moving.has(other.id)) continue
      if ((other.params.kind === 'Audio' ? 'audio' : 'visual') !== cls) continue
      const otherEnd = shrunkFromEnd !== null && other.id === fromLayer ? shrunkFromEnd : other.t_end_us
      if (destStart < otherEnd && other.t_start_us < destEnd)
        throw new CommandFailure({ error: 'TransitionRestoreCollision', layer: id })
    }
  }
}

/** remove_transition — remove by id and undo the transition's OWN geometry,
 *  routed by provenance: shrink the outgoing layer's tail by `extended_us`
 *  (back to its sacred end S — only borrowed material is returned, never real
 *  content of a pre-positioned overlap) and move the incoming layer RIGHT by
 *  `duration_us − extended_us` (its link siblings following on their own
 *  lattices), restoring adjacency exactly: B.start′ = S = A.end′. Since e ≤ d
 *  the move is never negative, so B cannot cross 0 here.
 *
 *  A locked home lane refuses first (TrackLocked), then the restore move is
 *  pre-checked for destination collisions (TransitionRestoreCollision) — both
 *  BEFORE anything mutates; an unlocatable from_layer/to_layer skips that half
 *  (tolerance for a participant a prior edit removed). Like update, a
 *  following B→C transition broken by B's move is commit-reconcile's designed
 *  drop. */
export function applyRemoveTransition(p: Project, transitionId: Uuid): void {
  const { comp: c, transition: tr, index: idx } = requireTransition(p, transitionId)
  const moveUs = tr.duration_us - tr.extended_us // ≥ 0: validate holds e ≤ d
  const fromLoc = locateLayerIn(c, tr.from_layer)
  const toLoc = locateLayerIn(c, tr.to_layer)
  // Whole-command lock gate on whichever participant halves still exist —
  // lock outranks the collision pre-check below (see checkTransitionTrackLock).
  for (const loc of [fromLoc, toLoc]) if (loc) checkTransitionTrackLock(c, loc.trackIndex)

  let moveSet: Uuid[] = []
  if (toLoc && moveUs > 0) {
    moveSet = incomingMoveSet(c, tr.to_layer)
    const shrunkFromEnd = fromLoc ? fromLoc.layer.t_end_us - tr.extended_us : null
    precheckRestoreCollision(c, moveSet, moveUs, tr.from_layer, shrunkFromEnd)
  }

  c.transitions.splice(idx, 1)
  if (fromLoc) shrinkLayerTEnd(fromLoc.layer, tr.extended_us)
  shiftLayerSet(c, moveSet, moveUs)
  applyDurationAutofit(c)
}
