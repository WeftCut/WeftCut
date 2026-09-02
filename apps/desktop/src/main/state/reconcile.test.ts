// apps/desktop/src/main/state/reconcile.test.ts
//
// Reconcile-on-commit (Policy B): ordinary edits stay transition-blind; the
// commit pipeline drops any transition whose invariant the edit broke, inside
// the SAME recorded commit, with one status-log row per drop and NO shrink-back
// of the outgoing layer. Exercised through the real actor dispatch path so the
// full apply → reconcile → validate → record → log order is under test.
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Layer, Marker, Project } from './model'
import { createActor, type ActorLogEntry } from './actor'
import { reconcileMarkers, reconcileTransitions, validate } from './validate'
import { ValidationFailure } from './errors'
import { buildProjectSummary, markerHibernating } from './summary'
import { applyAddLayer, applyAddMarker, colorParams } from './mutations/add'
import { mediaItemTemplate, videoClipParams } from './mutations/media'
import { applyAddTransition } from './mutations/transitions'
import { root, withGroup } from './__tests__/fixtures/project'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const color = () => colorParams(RED, 1920, 1080)

function val(r: { ok: true; value: unknown } | { ok: false; error: unknown }): string {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value as string
}
function layerOf(p: Project, id: string): Layer {
  for (const t of root(p).tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error(`layer ${id} not found`)
}

/** Actor with a captured log seam and A1=[0,2M] → A2=[2M,4M] + a 1M crossfade
 *  on @A. The add is PINNED to placement 'extend' (A1's tail extends to 3M;
 *  overlap [2M,3M] === duration) so the truth-table rows below keep their
 *  authored geometry under the overlap-default add — the table's semantics are
 *  what this file gates, not the add's placement. */
function withTransition() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'rt')
  const logged: ActorLogEntry[] = []
  const actor = createActor({ initial, idGen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
  const aRoll = root(initial).tracks[0].id
  const bRoll = root(initial).tracks[1].id
  const a1 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
  const a2 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
  const tid = val(actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000, placement: 'extend' }))
  return { actor, logged, aRoll, bRoll, a1, a2, tid }
}

describe('reconcile-on-commit: exemption for the transition commands themselves', () => {
  it('add_transition is not eaten by its own commit (invariant holds by construction); no log row', () => {
    const { actor, logged, a1, a2, tid } = withTransition()
    expect(root(actor.snapshot()).transitions.map((t) => t.id)).toEqual([tid])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000)
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(2_000_000)
    expect(logged).toEqual([])
  })
})

describe('reconcile-on-commit: drops', () => {
  it('participant delete drops the transition in the same commit; NO shrink-back of the outgoing layer', () => {
    const { actor, logged, a1, a2 } = withTransition()
    expect(actor.dispatch('delete_layer', { layer: a2 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    // The outgoing layer keeps its extended tail — reconcile removal never
    // shrinks back (only explicit remove_transition does).
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000)
    expect(logged).toHaveLength(1)
  })

  it('trim of from.t_end drops it; geometry is exactly what the edit made it', () => {
    const { actor, logged, a1, tid } = withTransition()
    expect(actor.dispatch('trim_layer', { layer: a1, edge: 'out', new_t_us: 2_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(2_000_000) // trim result, no extra shrink
    expect(logged).toHaveLength(1)
    expect(logged[0].message).toContain('Transition removed: edit broke its overlap')
    expect(logged[0].message).toContain(tid)
    expect(logged[0].details).toMatchObject({ kind: 'TransitionReconcileDrop', transition: tid })
  })

  it('trim of to.t_start (past the overlap) drops it; from-layer untouched', () => {
    const { actor, logged, a1, a2 } = withTransition()
    expect(actor.dispatch('trim_layer', { layer: a2, edge: 'in', new_t_us: 3_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(3_000_000)
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000) // no shrink-back
    expect(logged).toHaveLength(1)
  })

  it('move-apart of the to layer drops it (DurationMismatch reason)', () => {
    const { actor, logged, aRoll, a2 } = withTransition()
    expect(actor.dispatch('move_layer', { layer: a2, to_track: aRoll, t_start_us: 6_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(6_000_000)
    expect(logged).toHaveLength(1)
    expect((logged[0].details as { reason: { rule: string } }).reason.rule).toBe('TransitionDurationMismatch')
  })

  it('move of the from layer to another track drops it (CrossTrack reason)', () => {
    const { actor, logged, bRoll, a1 } = withTransition()
    expect(actor.dispatch('move_layer', { layer: a1, to_track: bRoll, t_start_us: 0 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(logged).toHaveLength(1)
    expect((logged[0].details as { reason: { rule: string } }).reason.rule).toBe('TransitionCrossTrack')
  })

  it('one commit dropping TWO transitions emits one log row per drop', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'rt2')
    const logged: ActorLogEntry[] = []
    const actor = createActor({ initial, idGen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
    const aRoll = root(initial).tracks[0].id
    const l1 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
    const l2 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    const l3 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 4_000_000, t_end_us: 6_000_000 }))
    const t1 = val(actor.dispatch('add_transition', { from: l1, to: l2, duration_us: 1_000_000, placement: 'extend' })) // l1 → 3M
    const t2 = val(actor.dispatch('add_transition', { from: l2, to: l3, duration_us: 1_000_000, placement: 'extend' })) // l2 → 5M
    expect(root(actor.snapshot()).transitions).toHaveLength(2)
    expect(actor.dispatch('delete_layer', { layer: l2 }).ok).toBe(true) // shared participant
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(logged).toHaveLength(2)
    expect(logged.map((e) => (e.details as { transition: string }).transition).sort()).toEqual([t1, t2].sort())
    for (const e of logged) {
      expect(e.level).toBe('info')
      expect(e.category).toEqual({ kind: 'Project' })
      expect((e.details as { reason: { rule: string } }).reason.rule).toBe('TransitionLayerMissing')
    }
  })
})

describe('reconcile-on-commit: splits', () => {
  it('split of the to participant beyond the overlap: the transition SURVIVES on the left half', () => {
    const { actor, logged, a2, tid } = withTransition()
    const r = actor.dispatch('split_layer', { layer: a2, at_t_us: 3_500_000, escape_link: false })
    expect(r.ok).toBe(true)
    expect(root(actor.snapshot()).transitions.map((t) => t.id)).toEqual([tid])
    expect(layerOf(actor.snapshot(), a2).t_end_us).toBe(3_500_000) // left half keeps the id
    expect(logged).toEqual([])
  })

  it('split of the from participant is rejected atomically: the dropped transition no longer authorizes the residual overlap', () => {
    // Split preserves covered intervals: the right half [1M,3M] still physically
    // overlaps the incoming layer's head by exactly the transition duration, but
    // the transition rides the LEFT half's id, so reconcile drops it and validate
    // then rejects the now-unauthorized overlap → the whole commit rolls back.
    // Honest Policy-B outcome: a from-side split can never be mopped up by a
    // remove-only reconcile (only geometry edits could legalize it).
    const { actor, logged, a1, tid } = withTransition()
    const before = actor.snapshot()
    const r = actor.dispatch('split_layer', { layer: a1, at_t_us: 1_000_000, escape_link: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.error).toBe('ValidationFailed')
      expect((r.error as { error: 'ValidationFailed'; detail: { rule: string } }).detail.rule).toBe('LayerOverlap')
    }
    expect(actor.snapshot()).toBe(before) // state untouched — drop never landed
    expect(root(actor.snapshot()).transitions.map((t) => t.id)).toEqual([tid])
    expect(logged).toEqual([]) // rejected commit logs nothing
  })

  it('split of the to participant inside the overlap is likewise rejected atomically', () => {
    const { actor, a2, tid } = withTransition()
    const r = actor.dispatch('split_layer', { layer: a2, at_t_us: 2_500_000, escape_link: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe('ValidationFailed')
    expect(root(actor.snapshot()).transitions.map((t) => t.id)).toEqual([tid])
  })
})

describe('reconcile-on-commit: survival + atomic undo', () => {
  it('transition SURVIVES a link move of both participants (overlap preserved)', () => {
    const { actor, logged, aRoll, a1, a2, tid } = withTransition()
    expect(actor.dispatch('links_create', { layers: [a1, a2], label: null, reassign: false }).ok).toBe(true)
    expect(actor.dispatch('move_layer', { layer: a1, to_track: aRoll, t_start_us: 5_000_000, escape_link: false }).ok).toBe(true)
    expect(layerOf(actor.snapshot(), a1).t_start_us).toBe(5_000_000)
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(8_000_000)
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(7_000_000) // sibling shifted by the same delta
    expect(root(actor.snapshot()).transitions.map((t) => t.id)).toEqual([tid]) // overlap still 1M
    expect(logged).toEqual([])
  })

  it('ONE undo restores both the edit and the transition (drop rides the same snapshot)', () => {
    const { actor, a1, tid } = withTransition()
    expect(actor.dispatch('trim_layer', { layer: a1, edge: 'out', new_t_us: 2_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(actor.dispatch('undo', {}).ok).toBe(true) // single step
    expect(root(actor.snapshot()).transitions.map((t) => t.id)).toEqual([tid])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000)
    // and redo re-applies edit + drop together
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(2_000_000)
  })

  it('an actor without a log seam still reconciles (emitLog optional)', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'rt3')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const aRoll = root(initial).tracks[0].id
    const a1 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
    const a2 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    val(actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 }))
    expect(actor.dispatch('delete_layer', { layer: a2 }).ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
  })
})

describe('reconcileTransitions (direct, plain object)', () => {
  it('removes in place, returns {id, from, to, reason} per drop, keeps healthy transitions', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const track = root(p).tracks[0].id
    const l1 = applyAddLayer(p, gen, track, color(), 0, 2_000_000)
    const l2 = applyAddLayer(p, gen, track, color(), 2_000_000, 4_000_000)
    const l3 = applyAddLayer(p, gen, track, color(), 4_000_000, 6_000_000)
    const t1 = applyAddTransition(p, gen, l1, l2, 1_000_000, { kind: 'Crossfade' }, 'extend').id // l1 → 3M
    const t2 = applyAddTransition(p, gen, l2, l3, 1_000_000, { kind: 'Crossfade' }, 'extend').id // l2 → 5M
    expect(reconcileTransitions(p)).toEqual([]) // both healthy → no-op
    // Break t1 only: hand-shrink l1's tail (edit-shaped geometry change).
    const l1Obj = root(p).tracks[0].layers.find((l) => l.id === l1)!
    l1Obj.t_end_us = 2_000_000
    const drops = reconcileTransitions(p)
    expect(drops).toEqual([{
      id: t1, from_layer: l1, to_layer: l2,
      reason: { rule: 'TransitionDurationMismatch', transition: t1, duration: 1_000_000, overlap: 0 },
    }])
    expect(root(p).transitions.map((t) => t.id)).toEqual([t2]) // t2 untouched
    expect(l1Obj.t_end_us).toBe(2_000_000) // no shrink-back
  })
})

// ── Anchored markers ─────────────────────────────────────────────────────────
// The same Policy B one entity over: `reconcileMarkers` re-derives an anchored
// marker's `t_us` from its layer's source window on EVERY commit, drops the
// marker when the clip it named leaves the project, and does neither while the
// mark points at source the layer no longer shows.

const MEDIA = '00000000-0000-0000-0000-0000000000aa'

/** A project with a 10 s video in the pool and one clip on the A roll at
 *  `[1 s, 3 s)` showing source `[2 s, 4 s)`, plus the markers `marks` describes.
 *  A `srcUs` builds an ANCHORED marker on that clip, placed at the time the
 *  reconcile would derive; a bare `tUs` builds a free one. Markers are authored
 *  before the actor exists because attaching is not yet a command — the model
 *  carries the anchor, so `applyAddMarker` is the whole surface it needs.
 *
 *  30 fps, and every time below is a whole frame: a mark at source `s` sits at
 *  `1 s + (s − 2 s)`. */
function anchoredFixture(marks: Array<{ srcUs?: number; tUs?: number; endTUs?: number | null; label?: string }> = [{ srcUs: 3_000_000 }]) {
  const gen = seededGen()
  const p = blankProject(gen, 'mk')
  p.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10_000_000)
  const aRoll = root(p).tracks[0].id
  const clip = applyAddLayer(p, gen, aRoll, videoClipParams(MEDIA, 2_000_000, 4_000_000), 1_000_000, 3_000_000)
  const ids = marks.map((m, i) => {
    const src = m.srcUs
    const t = typeof src === 'number' ? 1_000_000 + src - 2_000_000 : (m.tUs as number)
    return applyAddMarker(p, gen, t, m.endTUs ?? null, m.label ?? `m${i}`, RED, null, '',
      typeof src === 'number' ? { layer: clip, src_us: src } : null)
  })
  const logged: ActorLogEntry[] = []
  const actor = createActor({ initial: p, idGen: gen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
  return { p, gen, actor, logged, aRoll, clip, ids }
}
const markersOf = (p: Project): Marker[] => root(p).markers
function markerAt(p: Project, id: string): Marker {
  const m = markersOf(p).find((x) => x.id === id)
  if (!m) throw new Error(`marker ${id} not found`)
  return m
}
const asleep = (p: Project, id: string): boolean => markerHibernating(root(p), markerAt(p, id))
function videoLayer(p: Project, id: string) {
  const l = root(p).tracks[0].layers.find((x) => x.id === id)
  if (!l || l.params.kind !== 'VideoClip') throw new Error(`video layer ${id} not found`)
  return { layer: l, params: l.params }
}

describe('reconcileMarkers (direct, plain object): the policy table', () => {
  it('a free marker is never touched, whatever the clips under it do', () => {
    const { p, clip } = anchoredFixture([{ tUs: 500_000 }])
    videoLayer(p, clip).layer.t_start_us = 2_000_000
    expect(reconcileMarkers(p)).toEqual([])
    expect(markersOf(p)[0]).toMatchObject({ t_us: 500_000, anchor: null })
  })

  it('an anchored marker inside its layer window re-derives t_us from the layer that moved', () => {
    const { p, clip, ids } = anchoredFixture()
    const { layer } = videoLayer(p, clip)
    layer.t_start_us = 5_000_000
    layer.t_end_us = 7_000_000
    expect(reconcileMarkers(p)).toEqual([])
    expect(markerAt(p, ids[0]).t_us).toBe(6_000_000) // 5 s + (3 s − 2 s)
  })

  it('a src_us outside [src_in_us, src_out_us) HIBERNATES: t_us frozen, anchor kept, nothing dropped', () => {
    const { p, clip, ids } = anchoredFixture()
    const { layer, params } = videoLayer(p, clip)
    params.src_in_us = 3_500_000 // trimmed past the mark
    layer.t_start_us = 2_500_000
    expect(reconcileMarkers(p)).toEqual([])
    expect(markerAt(p, ids[0])).toMatchObject({ t_us: 2_000_000, anchor: { layer: clip, src_us: 3_000_000 } })
    expect(asleep(p, ids[0])).toBe(true)
  })

  it('the window is half-open, so a mark exactly on src_out_us is already asleep', () => {
    const { p, ids } = anchoredFixture([{ srcUs: 4_000_000 }])
    expect(asleep(p, ids[0])).toBe(true)
    const before = markerAt(p, ids[0]).t_us
    expect(reconcileMarkers(p)).toEqual([])
    expect(markerAt(p, ids[0]).t_us).toBe(before)
  })

  it('an anchor layer gone from the whole project DROPS the marker and reports it', () => {
    const { p, clip, ids } = anchoredFixture([{ srcUs: 3_000_000, label: 'cut 1' }, { tUs: 500_000 }])
    root(p).tracks[0].layers = []
    expect(reconcileMarkers(p)).toEqual([{ id: ids[0], composition: root(p).id, layer: clip, label: 'cut 1' }])
    expect(markersOf(p).map((m) => m.id)).toEqual([ids[1]]) // the free marker survives
  })

  it('an anchor layer that merely MOVED to another composition is kept, not dropped — validate is what must shout', () => {
    const { p, gen, clip, ids } = anchoredFixture()
    const layer = root(p).tracks[0].layers.pop()!
    const { p: withG, groupId } = withGroup(p, gen)
    withG.compositions[groupId].tracks[0].layers.push(layer)
    expect(reconcileMarkers(withG)).toEqual([]) // the layer is alive, so nothing is dropped
    expect(withG.compositions[withG.root_id].markers[0]).toMatchObject({ id: ids[0], t_us: 2_000_000, anchor: { layer: clip } })
    try { validate(withG); throw new Error('expected a validation failure') }
    catch (e) { expect(e instanceof ValidationFailure && e.err.rule).toBe('MarkerAnchorNotInComposition') }
  })

  it('a re-derived marker crossing another lands in the right slot, keeping markers sorted by t_us', () => {
    const { p, clip, ids } = anchoredFixture([{ srcUs: 3_000_000 }, { tUs: 2_500_000 }])
    expect(markersOf(p).map((m) => m.id)).toEqual([ids[0], ids[1]]) // 2 s, then 2.5 s
    videoLayer(p, clip).layer.t_start_us = 2_000_000
    expect(reconcileMarkers(p)).toEqual([])
    expect(markersOf(p).map((m) => m.t_us)).toEqual([2_500_000, 3_000_000])
    expect(markersOf(p).map((m) => m.id)).toEqual([ids[1], ids[0]])
  })

  it('a region carries its end by the same delta, so the span the user drew survives the follow', () => {
    const { p, clip, ids } = anchoredFixture([{ srcUs: 3_000_000, endTUs: 2_500_000 }])
    videoLayer(p, clip).layer.t_start_us = 2_000_000
    expect(reconcileMarkers(p)).toEqual([])
    expect(markerAt(p, ids[0])).toMatchObject({ t_us: 3_000_000, end_t_us: 3_500_000 })
  })
})

describe('reconcile-on-commit: anchored markers follow their clip', () => {
  it('a move carries the anchored markers by the same delta and leaves free ones where they were', () => {
    const { actor, aRoll, clip, ids } = anchoredFixture([{ srcUs: 3_000_000 }, { tUs: 500_000 }])
    expect(actor.dispatch('move_layer', { layer: clip, to_track: aRoll, t_start_us: 5_000_000 }).ok).toBe(true)
    expect(markerAt(actor.snapshot(), ids[0]).t_us).toBe(6_000_000)
    expect(markerAt(actor.snapshot(), ids[1]).t_us).toBe(500_000)
  })

  it('a head trim that keeps showing the mark does not move it — the window edge and the layer start travel together', () => {
    const { actor, clip, ids } = anchoredFixture()
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'in', new_t_us: 1_500_000 }).ok).toBe(true)
    expect(asleep(actor.snapshot(), ids[0])).toBe(false)
    expect(markerAt(actor.snapshot(), ids[0]).t_us).toBe(2_000_000)
  })

  it('a tail trim into a region narrows the shown end to the clip end and keeps the drawn span, so re-extending shows it whole', () => {
    // Region [1.5 s, 2.5 s) on the clip [1 s, 3 s); the trim ends the clip at 2 s, inside it.
    const { actor, clip, ids } = anchoredFixture([{ srcUs: 2_500_000, endTUs: 2_500_000 }])
    const shownEnd = (): number | null => {
      const p = actor.snapshot()
      const summary = buildProjectSummary(p, actor.historyStatus(), () => true)
      return summary.compositions[p.root_id].markers.find((m) => m.id === ids[0])!.end_t_us
    }
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'out', new_t_us: 2_000_000 }).ok).toBe(true)
    expect(asleep(actor.snapshot(), ids[0])).toBe(false)
    expect(shownEnd()).toBe(2_000_000)
    expect(markerAt(actor.snapshot(), ids[0]).end_t_us).toBe(2_500_000)
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'out', new_t_us: 3_000_000 }).ok).toBe(true)
    expect(shownEnd()).toBe(2_500_000)
  })

  it('trimming the IN point past a mark hibernates it; re-extending revives it on the exact frame it named', () => {
    const { actor, clip, ids } = anchoredFixture()
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'in', new_t_us: 2_500_000 }).ok).toBe(true)
    expect(asleep(actor.snapshot(), ids[0])).toBe(true)
    expect(markerAt(actor.snapshot(), ids[0])).toMatchObject({ t_us: 2_000_000, anchor: { src_us: 3_000_000 } })
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'in', new_t_us: 1_000_000 }).ok).toBe(true)
    expect(asleep(actor.snapshot(), ids[0])).toBe(false)
    expect(markerAt(actor.snapshot(), ids[0]).t_us).toBe(2_000_000)
  })

  it('a hibernating mark is inert to the edits an awake one follows, and undo restores it awake', () => {
    const { actor, aRoll, clip, ids } = anchoredFixture()
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'out', new_t_us: 1_500_000 }).ok).toBe(true) // src_out → 2.5 s
    expect(asleep(actor.snapshot(), ids[0])).toBe(true)
    expect(actor.dispatch('move_layer', { layer: clip, to_track: aRoll, t_start_us: 5_000_000 }).ok).toBe(true)
    expect(markerAt(actor.snapshot(), ids[0]).t_us).toBe(2_000_000) // an awake marker would have gone to 6 s
    expect(actor.dispatch('trim_layer', { layer: clip, edge: 'out', new_t_us: 7_000_000 }).ok).toBe(true)
    expect(markerAt(actor.snapshot(), ids[0]).t_us).toBe(6_000_000) // revived where its source now plays
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(asleep(actor.snapshot(), ids[0])).toBe(true)
  })

  it('a split leaves the mark’s source in the RIGHT half, so the anchor — which rides the left half’s id — hibernates', () => {
    const { actor, clip, ids } = anchoredFixture()
    expect(actor.dispatch('split_layer', { layer: clip, at_t_us: 1_500_000, escape_link: false }).ok).toBe(true)
    expect(root(actor.snapshot()).tracks[0].layers[0].id).toBe(clip) // left half keeps the id
    expect(asleep(actor.snapshot(), ids[0])).toBe(true)
    expect(markerAt(actor.snapshot(), ids[0])).toMatchObject({ t_us: 2_000_000, anchor: { layer: clip, src_us: 3_000_000 } })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(asleep(actor.snapshot(), ids[0])).toBe(false)
    expect(markerAt(actor.snapshot(), ids[0]).t_us).toBe(2_000_000)
  })

  it('deleting a clip takes its anchored markers in the SAME commit, names them in the status log, and ONE undo restores both', () => {
    const { actor, logged, clip, ids } = anchoredFixture([{ srcUs: 3_000_000, label: 'cut 1' }, { tUs: 500_000 }])
    expect(actor.dispatch('delete_layer', { layer: clip }).ok).toBe(true)
    expect(markersOf(actor.snapshot()).map((m) => m.id)).toEqual([ids[1]]) // the free marker stays
    expect(logged).toHaveLength(1)
    expect(logged[0].level).toBe('info')
    expect(logged[0].category).toEqual({ kind: 'Project' })
    expect(logged[0].message).toContain('Marker removed')
    expect(logged[0].message).toContain('cut 1')
    expect(logged[0].details).toMatchObject({ kind: 'MarkerReconcileDrop', marker: ids[0], layer: clip, label: 'cut 1' })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(root(actor.snapshot()).tracks[0].layers.map((l) => l.id)).toEqual([clip])
    expect(markersOf(actor.snapshot()).map((m) => m.id)).toEqual([ids[1], ids[0]])
  })

  it('pre-composing a clip carries its anchored markers into the Group and leaves free ones in the film', () => {
    const { actor, clip, ids } = anchoredFixture([{ srcUs: 3_000_000 }, { tUs: 500_000 }])
    const r = actor.dispatch('groups_create', { layers: [clip] })
    expect(r.ok).toBe(true)
    const groupId = (r as { ok: true; value: { composition_id: string } }).value.composition_id
    const inner = actor.snapshot().compositions[groupId]
    expect(inner.markers.map((m) => m.id)).toEqual([ids[0]])
    // The member shifted to composition time 0, and the SAME commit re-derived
    // the mark there: 0 + (3 s − 2 s).
    expect(inner.markers[0].t_us).toBe(1_000_000)
    expect(markersOf(actor.snapshot()).map((m) => m.id)).toEqual([ids[1]])
  })
})
