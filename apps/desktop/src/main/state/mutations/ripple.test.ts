// The ripple's matrix at the two levels the planner cannot reach: the SWEEP
// (endpoints written, tracks re-sorted, duration autofitted) and the COMMIT
// (reconcile dropping a deleted participant's transition and a deleted anchor's
// markers, validate as the last door, one undo). The arithmetic itself belongs
// to `renderer/ripple/plan.ts` and is pinned there; what is re-checked here is
// that the edit is the plan, and that a refusal is worth nothing.
//
// Times are built through `timeUsAtGridIndex`, never multiplied out: at 30 fps a
// frame is 33 333.33… µs, and a hand-written "one frame" is off grid often
// enough to make a landing assert lie about which side rounded.
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Composition, type Layer, type Project, type Uuid } from '../model'
import { createActor, type ActorHandle, type DispatchResult } from '../actor'
import { applyAddLayer, applyAddMarker, colorParams } from './add'
import { applyDurationAutofit } from './helpers'
import { applyLinksCreate } from './links'
import { audioParams, mediaItemTemplate, videoClipParams } from './media'
import { applyAddTransition } from './transitions'
import { applyRippleDeleteLayers } from './ripple'
import { AUDIO_GRID, frameGrid, timeUsAtGridIndex } from '../snap'
import { isCommandFailure, type CommandError } from '../errors'
import { groupedProject, root, withGroup } from '../__tests__/fixtures/project'

const FPS = { num: 30, den: 1 }
const FRAME = frameGrid(FPS)
const RED = { r: 255, g: 0, b: 0, a: 255 }
const BLUE = { r: 0, g: 128, b: 255, a: 255 }
const VIDEO = '00000000-0000-0000-0000-0000000000bb'
const SOUND = '00000000-0000-0000-0000-0000000000cc'
const CROSSFADE = { kind: 'Crossfade' as const }

/** Canonical µs of frame `i` / of second `n` / of 48 kHz sample `i`. */
const f = (i: number) => timeUsAtGridIndex(i, FRAME)
const sec = (n: number) => f(n * 30)
const smp = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID)

/** An IdGen that reports how many ids it handed out — the id-burn convention (a
 *  refused path consumes ZERO) is otherwise invisible. */
function countingGen(): { gen: IdGen; burned: () => number } {
  const inner = seededGen()
  let n = 0
  return { gen: () => { n += 1; return inner() }, burned: () => n }
}

interface Fx {
  p: Project
  gen: IdGen
  aRoll: Uuid
  bRoll: Uuid
  burned: () => number
  /** The actor over the very project built above — for everything the COMMIT
   *  owns. Called once the fixture is finished, since `initial` is read then. */
  open: () => ActorHandle
}

function fx(name = 'ripple'): Fx {
  const { gen, burned } = countingGen()
  const p = blankProject(gen, name)
  p.media_pool[VIDEO] = mediaItemTemplate(VIDEO, 'Video', 600_000_000)
  p.media_pool[SOUND] = mediaItemTemplate(SOUND, 'Audio', 600_000_000)
  return {
    p, gen, burned,
    aRoll: root(p).tracks[0].id,
    bRoll: root(p).tracks[1].id,
    open: () => createActor({ initial: p, idGen: gen, clock: () => '<TS>' }),
  }
}

const color = (x: Fx, track: Uuid, t0: number, t1: number): Uuid =>
  applyAddLayer(x.p, x.gen, track, colorParams(RED, 1920, 1080), t0, t1)
const clip = (x: Fx, track: Uuid, t0: number, t1: number): Uuid =>
  applyAddLayer(x.p, x.gen, track, videoClipParams(VIDEO, 0, t1 - t0), t0, t1)
const sound = (x: Fx, track: Uuid, t0: number, t1: number): Uuid =>
  applyAddLayer(x.p, x.gen, track, audioParams(SOUND, 0, t1 - t0), t0, t1)

function layerOf(c: Composition, id: Uuid): Layer {
  for (const t of c.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error(`no layer ${id}`)
}
const spanOf = (c: Composition, id: Uuid): number[] => {
  const l = layerOf(c, id)
  return [l.t_start_us, l.t_end_us]
}
const idsOn = (c: Composition, track: Uuid): Uuid[] => c.tracks.find((t) => t.id === track)!.layers.map((l) => l.id)
const ripple = (actor: ActorHandle, layers: Uuid[]): DispatchResult => actor.dispatch('ripple_delete_layers', { layers })

/** The refusal payload of a direct mutation call. */
function refusalOf(fn: () => void): Record<string, unknown> {
  try { fn() } catch (e) { if (isCommandFailure(e)) return e.err as unknown as Record<string, unknown>; throw e }
  throw new Error('expected a CommandFailure')
}

/** A ripple that must refuse, with the two things EVERY pre-write refusal owes:
 *  the project untouched (reference-identical, so not one field moved) and not
 *  one id spent. */
function refuses(x: Fx, actor: ActorHandle, layers: Uuid[], error: CommandError): void {
  const before = actor.snapshot()
  const len = actor.historyStatus().len
  const ids = x.burned()
  expect(ripple(actor, layers)).toEqual({ ok: false, error })
  expect(actor.snapshot()).toBe(before)
  expect(actor.historyStatus().len).toBe(len)
  expect(x.burned()).toBe(ids)
}

// ── the sweep ────────────────────────────────────────────────────────────────

describe('applyRippleDeleteLayers closes the span the deletion vacated', () => {
  it('pulls every downstream layer on every track left and lets the composition shrink with them', () => {
    const x = fx()
    const a = color(x, x.aRoll, sec(0), sec(2))
    const b = color(x, x.aRoll, sec(2), sec(4))
    const c = color(x, x.aRoll, sec(4), sec(6))
    const p1 = color(x, x.bRoll, sec(0), sec(1))
    const q = color(x, x.bRoll, sec(5), sec(7))
    expect(root(x.p).duration_us).toBe(sec(7))

    expect(applyRippleDeleteLayers(x.p, [b])).toEqual({ deleted: [b], moved: [c, q], prunedTracks: [] })
    const rc = root(x.p)
    expect(spanOf(rc, a)).toEqual([sec(0), sec(2)])      // upstream untouched
    expect(spanOf(rc, p1)).toEqual([sec(0), sec(1)])     // upstream on the other lane too
    expect(spanOf(rc, c)).toEqual([sec(2), sec(4)])      // shifted by the hole's length
    expect(spanOf(rc, q)).toEqual([sec(3), sec(5)])      // a different lane, the same delta
    expect(idsOn(rc, x.aRoll)).toEqual([a, c])           // still ordered by t_start_us
    expect(rc.duration_us).toBe(sec(5))
  })

  it('leaves a gap that already sat beside the deleted layer open — it moves left, it does not close', () => {
    const x = fx()
    color(x, x.aRoll, sec(0), sec(2))
    const b = color(x, x.aRoll, sec(3), sec(5))
    const c = color(x, x.aRoll, sec(7), sec(9))
    applyRippleDeleteLayers(x.p, [b])
    expect(spanOf(root(x.p), c)).toEqual([sec(5), sec(7)])
  })

  it('accumulates two non-adjacent deletions: the layer between them shifts once, the tail twice', () => {
    const x = fx()
    const a = color(x, x.aRoll, sec(0), sec(1))
    const b = color(x, x.aRoll, sec(1), sec(2))
    const c = color(x, x.aRoll, sec(2), sec(3))
    const d = color(x, x.aRoll, sec(3), sec(4))
    const e = color(x, x.aRoll, sec(4), sec(5))
    expect(applyRippleDeleteLayers(x.p, [b, d]).deleted).toEqual([b, d])
    const rc = root(x.p)
    expect(spanOf(rc, a)).toEqual([sec(0), sec(1)])
    expect(spanOf(rc, c)).toEqual([sec(1), sec(2)])
    expect(spanOf(rc, e)).toEqual([sec(2), sec(3)])
    expect(rc.duration_us).toBe(sec(3))
  })

  it('lands each mover on ITS OWN lattice — audio exact, visual on the nearest frame', () => {
    // A 10 000-sample hole is 208 333 µs, which is 6¼ frames: the visual mover
    // cannot land on the audio answer and must not try to.
    const x = fx()
    const a1 = sound(x, x.bRoll, smp(0), smp(10_000))
    const a2 = sound(x, x.bRoll, smp(10_000), smp(20_000))
    const v = color(x, x.aRoll, f(30), f(60))
    applyRippleDeleteLayers(x.p, [a1])
    const rc = root(x.p)
    expect(spanOf(rc, a2)).toEqual([smp(0), smp(10_000)])
    expect(spanOf(rc, v)).toEqual([f(24), f(54)])
  })

  it('shrinks an unpinned composition to the new high-water mark and leaves a pinned one at its length', () => {
    const loose = fx()
    color(loose, loose.aRoll, sec(0), sec(2))
    const looseTail = color(loose, loose.aRoll, sec(2), sec(4))
    applyRippleDeleteLayers(loose.p, [looseTail])
    expect(root(loose.p).duration_us).toBe(sec(2))

    const pinned = fx()
    color(pinned, pinned.aRoll, sec(0), sec(2))
    const pinnedTail = color(pinned, pinned.aRoll, sec(2), sec(4))
    root(pinned.p).duration_pinned = true
    root(pinned.p).duration_us = sec(10)
    applyRippleDeleteLayers(pinned.p, [pinnedTail])
    expect(root(pinned.p).duration_us).toBe(sec(10))
  })
})

// ── links ────────────────────────────────────────────────────────────────────

describe('applyRippleDeleteLayers over a link', () => {
  /** The A/V pair every timeline has: picture on the A roll, its sound on the
   *  B roll, the two co-starting and linked. */
  function pair(): { x: Fx; v1: Uuid; v2: Uuid; a1: Uuid; a2: Uuid } {
    const x = fx()
    const v1 = color(x, x.aRoll, sec(0), sec(2))
    const v2 = color(x, x.aRoll, sec(2), sec(4))
    const a1 = sound(x, x.bRoll, sec(0), sec(2))
    const a2 = sound(x, x.bRoll, sec(2), sec(4))
    applyLinksCreate(x.p, x.gen, [v1, a1], null, false)
    return { x, v1, v2, a1, a2 }
  }

  it('merges a linked V+A pair into one hole, so each partner lane shifts exactly once', () => {
    const { x, v1, v2, a1, a2 } = pair()
    const r = applyRippleDeleteLayers(x.p, [v1, a1])
    expect(r.moved).toEqual([v2, a2])
    const rc = root(x.p)
    expect(spanOf(rc, v2)).toEqual([sec(0), sec(2)])
    expect(spanOf(rc, a2)).toEqual([sec(0), sec(2)])
    expect(rc.links).toEqual([]) // the link dissolved below two members
    expect(rc.duration_us).toBe(sec(2))
  })

  it('names the co-starting partner when only the picture is selected', () => {
    const { x, v1, a1 } = pair()
    expect(refusalOf(() => applyRippleDeleteLayers(x.p, [v1])))
      .toEqual({ error: 'RippleInsideHole', layer: a1, hole: { s: sec(0), e: sec(2) } })
  })
})

// ── the commit: reconcile, validate, history ─────────────────────────────────

describe('dispatch: ripple_delete_layers and its transitions', () => {
  it("drops the transition whose INCOMING layer went, and lands the next clip on the outgoing one's exit frame", () => {
    // A [0,10) with B [10,13) pulled left to [9,12) by a 1 s overlap add, then
    // C at [12,15). B's footprint is only [10,12): the second before it belongs
    // to the transition, and shifting C by B's whole length would land it on A.
    const x = fx()
    const a = color(x, x.aRoll, sec(0), sec(10))
    const b = color(x, x.aRoll, sec(10), sec(13))
    applyAddTransition(x.p, x.gen, a, b, sec(1), CROSSFADE)
    const c = color(x, x.aRoll, sec(12), sec(15))
    const actor = x.open()

    expect(ripple(actor, [b]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, a)).toEqual([sec(0), sec(10)])
    expect(spanOf(rc, c)).toEqual([sec(10), sec(13)])
    expect(rc.transitions).toEqual([])
  })

  it('drops the transition whose OUTGOING layer went, closing only what that layer still held', () => {
    // B [10,20) with C pulled left to [19,25): the last second of B is the
    // transition's, so the hole is [10,19) and C lands at [10,16).
    const x = fx()
    const b = color(x, x.aRoll, sec(10), sec(20))
    const c = color(x, x.aRoll, sec(20), sec(26))
    applyAddTransition(x.p, x.gen, b, c, sec(1), CROSSFADE)
    const actor = x.open()

    expect(ripple(actor, [b]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, c)).toEqual([sec(10), sec(16)])
    expect(rc.transitions).toEqual([])
  })

  it('moves nothing when the deleted layer sat entirely inside its transition partner', () => {
    const x = fx()
    const a = color(x, x.aRoll, sec(0), sec(10))
    const b = color(x, x.aRoll, sec(10), sec(12))
    applyAddTransition(x.p, x.gen, a, b, sec(2), CROSSFADE) // B → [8,10): nothing of it is its own
    const c = color(x, x.aRoll, sec(10), sec(12))
    const actor = x.open()

    expect(ripple(actor, [b]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, a)).toEqual([sec(0), sec(10)])
    expect(spanOf(rc, c)).toEqual([sec(10), sec(12)])
    expect(rc.transitions).toEqual([])
  })

  it('carries a fully downstream transition through a whole-frame shift untouched', () => {
    const x = fx()
    const head = color(x, x.aRoll, sec(0), sec(2))
    const b1 = color(x, x.aRoll, sec(4), sec(6))
    const b2 = color(x, x.aRoll, sec(6), sec(8))
    const tid = applyAddTransition(x.p, x.gen, b1, b2, sec(1), CROSSFADE).id
    const actor = x.open()

    expect(ripple(actor, [head]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, b1)).toEqual([sec(2), sec(4)])
    expect(spanOf(rc, b2)).toEqual([sec(3), sec(5)])
    expect(rc.transitions).toMatchObject([{ id: tid, duration_us: sec(1), extended_us: 0 }])
  })

  it('re-derives a downstream transition\'s duration when the landing changes its microseconds', () => {
    // The fractional case the equality `overlap === duration_us` cannot survive
    // on its own: one frame at 30 fps is 33 333 µs between frames 2 and 3 but
    // 33 334 µs between frames 1 and 2, so a shift that keeps the frame COUNT
    // still moves the number. Without the re-derivation reconcile would drop a
    // transition the ripple never touched.
    const x = fx()
    const head = color(x, x.aRoll, f(0), f(1))
    const a = color(x, x.aRoll, f(1), f(3))
    const b = color(x, x.aRoll, f(3), f(5))
    const tid = applyAddTransition(x.p, x.gen, a, b, f(1), CROSSFADE).id
    expect(root(x.p).transitions).toMatchObject([{ duration_us: f(1), extended_us: 0 }])
    const actor = x.open()

    expect(ripple(actor, [head]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, a)).toEqual([f(0), f(2)])
    expect(spanOf(rc, b)).toEqual([f(1), f(3)])
    const tr = rc.transitions.find((t) => t.id === tid)!
    expect(tr.duration_us).toBe(f(2) - f(1)) // 33 334 µs, one more than it was stored with
    expect(tr.duration_us).toBe(layerOf(rc, a).t_end_us - layerOf(rc, b).t_start_us)
    // Nothing was borrowed, so nothing is borrowed afterwards: the duration
    // gained a microsecond, the borrow did not gain a phantom one.
    expect(tr.extended_us).toBe(0)
  })

  it('re-measures a borrowed tail as the same frame count, so removing the transition afterwards restores an on-grid cut', () => {
    // Full borrow on frames 1–3 → 3–5: the outgoing layer extends one frame past
    // the hard cut, `extended_us === duration_us`. After a one-frame shift the
    // duration's microseconds change; the borrow must still be the WHOLE overlap,
    // and the hard cut `remove_transition` restores must be a lattice point.
    const x = fx()
    const head = color(x, x.aRoll, f(0), f(1))
    const a = color(x, x.aRoll, f(1), f(3))
    const b = color(x, x.aRoll, f(3), f(5))
    const tid = applyAddTransition(x.p, x.gen, a, b, f(1), CROSSFADE, 'extend').id
    expect(spanOf(root(x.p), a)).toEqual([f(1), f(4)])
    expect(root(x.p).transitions).toMatchObject([{ duration_us: f(4) - f(3), extended_us: f(4) - f(3) }])
    const actor = x.open()

    expect(ripple(actor, [head]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, a)).toEqual([f(0), f(3)])
    expect(spanOf(rc, b)).toEqual([f(2), f(4)])
    const tr = rc.transitions.find((t) => t.id === tid)!
    expect(tr.duration_us).toBe(f(3) - f(2))
    expect(tr.extended_us).toBe(tr.duration_us)

    expect(actor.dispatch('remove_transition', { transition: tid }).ok).toBe(true)
    const after = root(actor.snapshot())
    expect(after.transitions).toEqual([])
    expect(spanOf(after, a)).toEqual([f(0), f(2)]) // the borrowed frame handed back, end on the grid
    expect(spanOf(after, b)).toEqual([f(2), f(4)]) // a full borrow moves the incoming layer by nothing
  })
})

describe('dispatch: ripple_delete_layers and its markers', () => {
  it('leaves a free marker where it is, carries an anchored one with its clip, and drops the deleted clip\'s', () => {
    const x = fx()
    const a = clip(x, x.aRoll, sec(0), sec(2))
    const b = clip(x, x.aRoll, sec(2), sec(4))
    const c = clip(x, x.aRoll, sec(4), sec(6))
    const free = applyAddMarker(x.p, x.gen, sec(5), null, 'free', BLUE)
    const onC = applyAddMarker(x.p, x.gen, sec(5), null, 'on C', BLUE, null, '', { layer: c, src_us: sec(1) })
    applyAddMarker(x.p, x.gen, sec(3), null, 'on B', BLUE, null, '', { layer: b, src_us: sec(1) })
    const actor = x.open()

    expect(ripple(actor, [b]).ok).toBe(true)
    const rc = root(actor.snapshot())
    expect(spanOf(rc, a)).toEqual([sec(0), sec(2)])
    // The anchored survivor's `t_us` is re-derived off its clip's new position;
    // the free one marks the composition's own time and does not follow content.
    expect(rc.markers.map((m) => [m.id, m.t_us])).toEqual([[onC, sec(3)], [free, sec(5)]])
  })
})

describe('dispatch: ripple_delete_layers inside a Group', () => {
  /** A Group holding `spans` back to back on its A roll, placed in the root by
   *  `withGroup` (whose window is `[0, max(duration, 1 s))`). */
  function grouped(spans: Array<[number, number]>): { p: Project; gen: IdGen; groupId: Uuid; refLayerId: Uuid; inner: Uuid[] } {
    const gen = seededGen()
    const inner: Uuid[] = []
    const { p, groupId, refLayerId } = withGroup(blankProject(gen, 'grp'), gen, (g, view) => {
      for (const [t0, t1] of spans) inner.push(applyAddLayer(view, gen, g.tracks[0].id, colorParams(RED, 1920, 1080), t0, t1))
    })
    return { p, gen, groupId, refLayerId, inner }
  }

  it('shrinks the Group and leaves the parent clip that references it exactly as it was', () => {
    const { p, gen, groupId, refLayerId, inner } = grouped([[sec(0), sec(1)], [sec(1), sec(2)], [sec(2), sec(3)]])
    const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    const refBefore = structuredClone(layerOf(root(actor.snapshot()), refLayerId))

    expect(ripple(actor, [inner[1]]).ok).toBe(true)
    const s = actor.snapshot()
    // The window now overhangs the Group by a second — tolerated in state and
    // clamped at the gesture (ADR 0052 §6), never repaired by a ripple below.
    expect(layerOf(root(s), refLayerId)).toEqual(refBefore)
    expect(root(s).duration_us).toBe(sec(3))
    expect(spanOf(s.compositions[groupId], inner[2])).toEqual([sec(1), sec(2)])
    expect(s.compositions[groupId].duration_us).toBe(sec(2))
  })

  it('shifts a Group clip in the root as one body, reaching nothing inside it', () => {
    const { p, gen, groupId, refLayerId, inner } = grouped([[sec(0), sec(1)]])
    const ref = layerOf(root(p), refLayerId)
    ref.t_start_us = sec(2)
    ref.t_end_us = sec(3)
    const head = applyAddLayer(p, gen, root(p).tracks[0].id, colorParams(RED, 1920, 1080), sec(0), sec(1))
    applyDurationAutofit(root(p))
    const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
    const paramsBefore = structuredClone(layerOf(root(actor.snapshot()), refLayerId).params)

    expect(ripple(actor, [head]).ok).toBe(true)
    const s = actor.snapshot()
    expect(spanOf(root(s), refLayerId)).toEqual([sec(1), sec(2)])
    expect(layerOf(root(s), refLayerId).params).toEqual(paramsBefore)
    expect(spanOf(s.compositions[groupId], inner[0])).toEqual([sec(0), sec(1)])
  })
})

// ── the refusals: named, and worth nothing ───────────────────────────────────

describe('dispatch: ripple_delete_layers refuses rather than making room', () => {
  /** A [0,2) B [2,4) C [4,6) on the A roll — the clip to cut is always B. */
  function threeUp(): { x: Fx; a: Uuid; b: Uuid; c: Uuid } {
    const x = fx()
    return {
      x,
      a: color(x, x.aRoll, sec(0), sec(2)),
      b: color(x, x.aRoll, sec(2), sec(4)),
      c: color(x, x.aRoll, sec(4), sec(6)),
    }
  }

  it('names a B-roll clip that starts inside the span, and succeeds once it joins the selection', () => {
    const x = fx()
    color(x, x.aRoll, sec(0), sec(2))
    const b = color(x, x.aRoll, sec(2), sec(6))
    const c = color(x, x.aRoll, sec(6), sec(8))
    const bRollClip = color(x, x.bRoll, sec(3), sec(4))
    const actor = x.open()

    refuses(x, actor, [b], { error: 'RippleInsideHole', layer: bRollClip, hole: { s: sec(2), e: sec(6) } })
    // The remedy composes: the two holes merge and the ripple is exactly right.
    expect(ripple(actor, [b, bRollClip]).ok).toBe(true)
    expect(spanOf(root(actor.snapshot()), c)).toEqual([sec(2), sec(4)])
  })

  it('names both clips when a mover would land on a title spanning the cut', () => {
    const { x, b } = threeUp()
    const title = color(x, x.bRoll, sec(0), sec(5))
    const tail = color(x, x.bRoll, sec(6), sec(7))
    const actor = x.open()
    refuses(x, actor, [b], { error: 'RippleCollision', moving: tail, blocking: title, track: x.bRoll })
  })

  it('names a link with members on both sides of the cut', () => {
    const { x, b } = threeUp()
    const head = color(x, x.bRoll, sec(0), sec(1))
    const tail = color(x, x.bRoll, sec(5), sec(6))
    const link = applyLinksCreate(x.p, x.gen, [head, tail], null, false)
    const actor = x.open()
    refuses(x, actor, [b], { error: 'RippleLinkStraddles', link, hole: { s: sec(2), e: sec(4) } })
  })

  it('names a locked lane only when something on it would have to move', () => {
    const { x, b, c } = threeUp()
    const stuck = color(x, x.bRoll, sec(5), sec(6))
    const actor = x.open()
    expect(actor.dispatch('update_track_flags', { track: x.bRoll, patch: { locked: true } }).ok).toBe(true)
    refuses(x, actor, [b], { error: 'TrackLocked', track: x.bRoll })

    // The same lane, locked, holding nothing downstream: the ripple runs.
    const quiet = fx()
    color(quiet, quiet.aRoll, sec(0), sec(2))
    const cut = color(quiet, quiet.aRoll, sec(2), sec(4))
    const survivor = color(quiet, quiet.aRoll, sec(4), sec(6))
    const upstream = color(quiet, quiet.bRoll, sec(0), sec(1))
    const quietActor = quiet.open()
    expect(quietActor.dispatch('update_track_flags', { track: quiet.bRoll, patch: { locked: true } }).ok).toBe(true)
    expect(ripple(quietActor, [cut]).ok).toBe(true)
    const rc = root(quietActor.snapshot())
    expect(spanOf(rc, survivor)).toEqual([sec(2), sec(4)])
    expect(spanOf(rc, upstream)).toEqual([sec(0), sec(1)])
    // The refused half above left `stuck` and `c` untouched.
    expect(spanOf(root(actor.snapshot()), stuck)).toEqual([sec(5), sec(6)])
    expect(spanOf(root(actor.snapshot()), c)).toEqual([sec(4), sec(6)])
  })

  it('names a locked layer that would have to move', () => {
    const { x, b, c } = threeUp()
    layerOf(root(x.p), c).locked = true
    const actor = x.open()
    refuses(x, actor, [b], { error: 'RippleLockedLayer', layer: c })
  })

  it('refuses a set spanning two compositions, and an empty one', () => {
    const g = groupedProject()
    const actor = createActor({ initial: g.p, idGen: g.idGen, clock: () => '<TS>' })
    const before = actor.snapshot()
    expect(ripple(actor, [g.innerId, g.refLayerId])).toEqual({
      ok: false, error: { error: 'CrossCompositionSet', layer: g.refLayerId, composition: before.root_id, expected: g.groupId },
    })
    expect(ripple(actor, [])).toEqual({
      ok: false, error: { error: 'InvalidArgument', field: 'layers', detail: 'at least one layer is required' },
    })
    expect(actor.snapshot()).toBe(before)
  })
})

// ── one gesture, one entry ───────────────────────────────────────────────────

describe('dispatch: ripple_delete_layers records one entry that one undo unwinds', () => {
  it('restores layers, positions, transitions and markers together', () => {
    const x = fx()
    const head = color(x, x.aRoll, sec(0), sec(2))
    const b1 = color(x, x.aRoll, sec(4), sec(6))
    const b2 = color(x, x.aRoll, sec(6), sec(8))
    applyAddTransition(x.p, x.gen, b1, b2, sec(1), CROSSFADE)
    const anchored = clip(x, x.bRoll, sec(4), sec(6))
    applyAddMarker(x.p, x.gen, sec(5), null, 'on the B roll', BLUE, null, '', { layer: anchored, src_us: sec(1) })
    const actor = x.open()

    const before = JSON.stringify(actor.snapshot())
    const len = actor.historyStatus().len
    expect(ripple(actor, [head]).ok).toBe(true)
    expect(actor.historyStatus().len - len).toBe(1)
    expect(actor.historyView(1).ops[0]).toMatchObject({ summary: 'Ripple deleted layers', label_key: 'history.layer.ripple_delete' })
    expect(JSON.stringify(actor.snapshot())).not.toBe(before)

    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })

  it('spends one entry on a set spanning two lanes, and deletes a duplicated id once', () => {
    const x = fx()
    const onA = color(x, x.aRoll, sec(0), sec(2))
    const onB = color(x, x.bRoll, sec(0), sec(2))
    const survivor = color(x, x.aRoll, sec(2), sec(4))
    const actor = x.open()
    const len = actor.historyStatus().len

    expect(ripple(actor, [onA, onB, onA]).ok).toBe(true)
    expect(actor.historyStatus().len - len).toBe(1)
    const rc = root(actor.snapshot())
    expect(rc.tracks.flatMap((t) => t.layers).map((l) => l.id)).toEqual([survivor])
    expect(spanOf(rc, survivor)).toEqual([sec(0), sec(2)])
  })
})
