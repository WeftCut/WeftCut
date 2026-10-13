// apps/desktop/src/main/state/reviewBaseline.test.ts
// The Review baseline History owns: initialize / re-pin / keep, attribution,
// approval, preference patches, reset (spec .scratch/agent-review/spec.md
// Part B — Review baseline, Attribution; ADR 0115; ticket 05).
import { describe, it, expect, vi } from 'vitest'
import { createActor, type ActorHandle } from './actor'
import { History, type Actor } from './history'
import { seededGen } from './ids'
import { blankProject, type Uuid } from './model'
import { root } from './__tests__/fixtures/project'
import { entityKey, type EntityKey } from './reviewDiff'

const S = 1_000_000
const AV = '00000000-0000-0000-0000-0000000000ab'
const AGENT: Actor = { kind: 'Agent', client: 'claude' }

function setup() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'review'), idGen: gen, clock: () => '<TS>' })
  const [tA, tB] = root(a.snapshot()).tracks.map((t) => t.id)
  return { a, tA, tB }
}
function ok(r: ReturnType<ActorHandle['dispatch']>): unknown { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value }
const color = (a: ActorHandle, track: Uuid, s: number, e: number, by?: Actor) =>
  ok(a.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e }, by)) as Uuid
const label = (a: ActorHandle, layer: Uuid, text: string, by?: Actor) => ok(a.dispatch('update_layer', { layer, patch: { label: text } }, by))
const L = (id: Uuid): EntityKey => entityKey('Layer', id)
const ids = (a: ActorHandle) => {
  const s = a.reviewState()
  return { unreviewed: s.unreviewed.map((c) => c.id), user: s.user.map((c) => c.id) }
}

describe('Review baseline — initialization', () => {
  it('there is no baseline until an agent commits; user edits alone never create one', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    expect(a.reviewState()).toMatchObject({ has_baseline: false, unreviewed: [], user: [] })
  })

  it('the first Agent commit initializes the baseline from the snapshot before it', () => {
    const { a, tA } = setup()
    const mine = color(a, tA, 0, S)
    const theirs = color(a, tA, 2 * S, 3 * S, AGENT)
    expect(a.reviewState().has_baseline).toBe(true)
    // The user's earlier layer is IN the baseline; only the agent's differs.
    expect(ids(a)).toEqual({ unreviewed: [L(theirs)], user: [] })
    expect(ids(a).unreviewed).not.toContain(L(mine))
  })

  it('a work session begin pins the baseline to its Pre-agent checkpoint snapshot', () => {
    const { a, tA } = setup()
    const cp = a.checkpoint('Pre-agent: tidy', AGENT)
    const x = color(a, tA, 0, S) // after the checkpoint, before the pin
    expect(a.pinReviewBaseline(cp)).toBe(true)
    // Pinned to the checkpoint, not to the current state: x is a user change.
    expect(ids(a)).toEqual({ unreviewed: [], user: [L(x)] })
  })

  it('re-pins on a later session begin only when nothing is unreviewed', () => {
    const { a, tA } = setup()
    expect(a.pinReviewBaseline()).toBe(true)
    const u = color(a, tA, 0, S)
    // Only a user change pending: a new session re-pins and folds it in.
    expect(a.pinReviewBaseline()).toBe(true)
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    const g = color(a, tA, 2 * S, 3 * S, AGENT)
    // Unreviewed agent work pending: the next session keeps accumulating.
    expect(a.pinReviewBaseline()).toBe(false)
    label(a, u, 'later')
    expect(ids(a)).toEqual({ unreviewed: [L(g)], user: [L(u)] })
    // An agent change undone back to the baseline is no longer unreviewed.
    ok(a.dispatch('undo', {})) // the label
    ok(a.dispatch('undo', {})) // the agent's layer
    expect(a.pinReviewBaseline()).toBe(true)
  })
})

describe('Review baseline — attribution', () => {
  it('an agent edit then a user edit of the same layer stays an unreviewed change', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    a.pinReviewBaseline()
    label(a, x, 'agent', AGENT)
    label(a, x, 'user')
    expect(ids(a)).toEqual({ unreviewed: [L(x)], user: [] })
  })

  it('a user-only edit is a user change, hidden from the unreviewed list', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    a.pinReviewBaseline()
    label(a, x, 'user')
    expect(ids(a)).toEqual({ unreviewed: [], user: [L(x)] })
  })

  it('undo needs no attribution: an agent change undone back to the baseline disappears', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    ok(a.dispatch('undo', {}))
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
  })

  it('a checkpoint restore by an agent is attributed to the agent; by the user, to the user', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    const cp = a.checkpoint('before')
    label(a, x, 'edited')
    a.pinReviewBaseline()
    // Restored by the user: the label reverts, a user change.
    ok(a.dispatch('restore_checkpoint', { checkpoint_id: cp }))
    expect(ids(a)).toEqual({ unreviewed: [], user: [L(x)] })
    a.approveReviewAll()
    label(a, x, 'edited again')
    a.approveReviewAll()
    // Restored by an agent: the same revert is unreviewed.
    ok(a.dispatch('restore_checkpoint', { checkpoint_id: cp }, AGENT))
    expect(ids(a)).toEqual({ unreviewed: [L(x)], user: [] })
  })

  it('a track reorder by an agent is an unreviewed placement change of the composition', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    ok(a.dispatch('move_track', { track: tA, new_position: 1 }, AGENT))
    const [c] = a.reviewState().unreviewed
    expect(c).toMatchObject({ class: 'modified', kind: 'Composition', keys: [entityKey('Composition', a.snapshot().root_id)], aspects: ['placement'], ranges: [] })
  })
})

describe('Review baseline — approval', () => {
  it('approving one change leaves the rest; a later agent edit reappears; editing back to the approved value removes it', () => {
    const { a, tA, tB } = setup()
    a.pinReviewBaseline()
    const x = color(a, tA, 0, S, AGENT)
    const y = color(a, tB, 0, S, AGENT)
    expect(a.approveReview({ change_ids: [L(x)] })).toBe(1)
    expect(ids(a)).toEqual({ unreviewed: [L(y)], user: [] })
    label(a, x, 'first', AGENT)
    a.approveReview({ keys: [L(x)] }) // the approved value is now labelled 'first'
    expect(ids(a).unreviewed).toEqual([L(y)])
    label(a, x, 'renamed', AGENT)
    expect(a.reviewState().unreviewed.find((c) => c.id === L(x))).toMatchObject({ class: 'modified', aspects: ['label'] })
    label(a, x, 'first') // back to the approved value — by the user, even
    expect(ids(a)).toEqual({ unreviewed: [L(y)], user: [] })
  })

  it('an approved removal (ABSENT) and an edit back to the baseline value', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    a.pinReviewBaseline()
    ok(a.dispatch('delete_layers', { layers: [x] }, AGENT))
    expect(ids(a).unreviewed).toEqual([L(x)])
    a.approveReview({ keys: [L(x)] })
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    ok(a.dispatch('undo', {})) // the layer is back: differs from the approved removal
    expect(ids(a)).toEqual({ unreviewed: [], user: [L(x)] })
  })

  it('a shift group approves as a unit, even when asked by one member key', () => {
    const { a, tA, tB } = setup()
    const x = color(a, tA, 0, S)
    const y = color(a, tB, 2 * S, 3 * S)
    const z = color(a, tA, 5 * S, 6 * S)
    a.pinReviewBaseline()
    ok(a.dispatch('shift_layers', { layers: [x, y], delta_us: S }, AGENT))
    label(a, z, 'z', AGENT)
    const shift = a.reviewState().unreviewed.find((c) => c.class === 'shifted')!
    expect(shift.keys).toEqual([L(x), L(y)].sort())
    expect(a.approveReview({ keys: [L(y)] })).toBe(1)
    expect(ids(a)).toEqual({ unreviewed: [L(z)], user: [] })
  })

  it('approve all folds everything in; approvals record nothing, emit no change and ignore the history lock', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    const x = color(a, tA, 0, S, AGENT)
    color(a, tA, 2 * S, 3 * S)
    a.lockHistory('agent at work')
    const status = a.historyStatus()
    const events = vi.fn()
    a.subscribe(events)
    a.approveReview({ change_ids: [L(x)] })
    a.approveReviewAll()
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    expect(a.historyStatus()).toEqual(status)
    expect(events).not.toHaveBeenCalled()
    // After approve all a later user edit is a user change, not unreviewed.
    label(a, x, 'mine')
    expect(ids(a)).toEqual({ unreviewed: [], user: [L(x)] })
  })

  it('unknown ids and keys are ignored; with no baseline nothing happens', () => {
    const { a, tA } = setup()
    expect(a.approveReview({ change_ids: ['Layer:nope'] })).toBe(0)
    a.approveReviewAll()
    expect(a.reviewState().has_baseline).toBe(false)
    color(a, tA, 0, S, AGENT)
    expect(a.approveReview({ change_ids: ['Layer:nope'], keys: ['Marker:nope'] })).toBe(0)
    expect(a.reviewState().unreviewed).toHaveLength(1)
  })
})

describe('Review baseline — preference patches, checkpoints, reset', () => {
  it('preference patches never create changes and are carried into the base', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    a.pinReviewBaseline()
    ok(a.dispatch('update_track_flags', { track: tA, patch: { muted: true, solo: true, locked: true, enabled: false } }))
    ok(a.dispatch('update_role_flags', { role: 'dialogue', patch: { muted: true } }))
    ok(a.dispatch('set_composition', { width: 1280, height: 720, background: { r: 9, g: 9, b: 9, a: 255 } }))
    ok(a.dispatch('update_project_settings', { patch: { prefer_proxies: true } }))
    ok(a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 20 * S, with_audio: false }))
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    // …also as an agent's: unrecorded patches carry no attribution.
    ok(a.dispatch('update_track_flags', { track: tA, patch: { muted: false } }, AGENT))
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
  })

  it('the base receives every *Everywhere patch, like a checkpoint', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, 'op0')
    const p1 = { ...p0, metadata: { ...p0.metadata, name: 'agent edit' } }
    h.record({ op_id: 'op1', actor: AGENT, timestamp: '<TS>', summary: 's', label_key: 'k', affected: [], snapshot: p1 })
    expect(h.reviewBaseline()!.base).toBe(p0)
    const settings = { ...p0.settings, prefer_proxies: true }
    h.replaceSettingsEverywhere(settings)
    h.replaceMediaPoolEverywhere({})
    h.replaceCompositionEverywhere((p) => ({ ...p, metadata: { ...p.metadata, name: 'patched' } }))
    const base = h.reviewBaseline()!.base
    expect(base.settings).toEqual(settings)
    expect(base.media_pool).toEqual({})
    expect(base.metadata.name).toBe('patched')
  })

  it('deleting the session checkpoint does not disturb the baseline', () => {
    const { a, tA } = setup()
    const cp = a.checkpoint('Pre-agent: work', AGENT)
    a.pinReviewBaseline(cp)
    const x = color(a, tA, 0, S, AGENT)
    a.deleteCheckpoint(cp)
    expect(ids(a)).toEqual({ unreviewed: [L(x)], user: [] })
  })

  it('opening a project (replace_state) clears it; the revision only increases', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    const rev = a.reviewState().baseline_revision
    a.replaceState(a.snapshot())
    const after = a.reviewState()
    expect(after).toMatchObject({ has_baseline: false, unreviewed: [], user: [] })
    expect(after.baseline_revision).toBeGreaterThan(rev)
  })

  it('known caveat: an fps re-snap does not reach approved overlay values — it surfaces as a user change only', () => {
    const { a } = setup()
    a.pinReviewBaseline()
    const m = ok(a.dispatch('add_marker', { t_us: 100_000 }, AGENT)) as Uuid
    a.approveReview({ keys: [entityKey('Marker', m)] })
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    // No layer anywhere, so the rate is free; the marker re-snaps to 24 fps in
    // every snapshot and in the base, but not in the approved overlay.
    ok(a.dispatch('set_composition', { fps: { num: 24, den: 1 } }))
    const moved = root(a.snapshot()).markers[0].t_us
    expect(moved).not.toBe(100_000)
    expect(ids(a)).toEqual({ unreviewed: [], user: [entityKey('Marker', m)] })
  })
})

describe('Review baseline — memo and notification', () => {
  it('the review state is memoized until the baseline or the project changes', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    const s1 = a.reviewState()
    expect(a.reviewState()).toBe(s1)
    color(a, tA, 2 * S, 3 * S)
    const s2 = a.reviewState()
    expect(s2).not.toBe(s1)
    a.approveReviewAll()
    expect(a.reviewState()).not.toBe(s2)
  })

  it('subscribers hear baseline changes (initialize, attribution, approval, reset), not user commits', () => {
    const { a, tA } = setup()
    const heard = vi.fn()
    a.subscribeReview(heard)
    color(a, tA, 0, S)
    expect(heard).not.toHaveBeenCalled()
    const x = color(a, tA, 2 * S, 3 * S, AGENT) // initialize + attribute: one bump
    expect(heard).toHaveBeenCalledTimes(1)
    label(a, x, 'user')
    expect(heard).toHaveBeenCalledTimes(1)
    a.approveReviewAll()
    a.replaceState(a.snapshot())
    expect(heard.mock.calls.map(([r]) => r)).toEqual([1, 2, 3])
  })
})
