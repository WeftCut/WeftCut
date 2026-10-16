// apps/desktop/src/main/state/reviewBaseline.test.ts
// The Review baseline History owns: initialize / re-pin / keep, attribution,
// approve all, revert all, preference patches, reset (spec .scratch/agent-review/spec.md
// Part B — Review baseline, Attribution; ADR 0115; ticket 05).
import { describe, it, expect, vi } from 'vitest'
import { createActor, type ActorHandle } from './actor'
import { History, type Actor } from './history'
import { seededGen } from './ids'
import { blankProject, type Uuid } from './model'
import { root } from './__tests__/fixtures/project'
import { entityKey } from './reviewEntities'
import type { EntityKey } from '../../shared/review'

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
    expect(c).toMatchObject({ class: 'modified', id: entityKey('Composition', a.snapshot().root_id), details: [{ type: 'aspect', aspect: 'placement' }], ranges: [] })
  })
})

describe('Review baseline — approve all', () => {
  it('folds everything in; records nothing, emits no change and ignores the history lock', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    const x = color(a, tA, 0, S, AGENT)
    color(a, tA, 2 * S, 3 * S)
    a.lockHistory('agent at work')
    const status = a.historyStatus()
    const events = vi.fn()
    a.subscribe(events)
    a.approveReviewAll()
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    expect(a.historyStatus()).toEqual(status)
    expect(events).not.toHaveBeenCalled()
    // After approve all a later user edit is a user change, not unreviewed.
    label(a, x, 'mine')
    expect(ids(a)).toEqual({ unreviewed: [], user: [L(x)] })
  })

  it('takes the user\'s own differences with the agent\'s: the baseline is the whole current state', () => {
    const { a, tA, tB } = setup()
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    color(a, tB, 0, S)
    expect(a.reviewState().user).toHaveLength(1)
    a.approveReviewAll()
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
  })

  it('with no baseline nothing happens', () => {
    const { a } = setup()
    a.approveReviewAll()
    expect(a.reviewState().has_baseline).toBe(false)
  })
})

describe('Review baseline — revert all', () => {
  const lastOp = (a: ActorHandle) => a.historyView(1).ops[0].op_id

  it('restores the baseline as one recorded commit, the user\'s differences included; undo lists the same changes again', () => {
    const { a, tA, tB } = setup()
    const kept = color(a, tA, 0, S)
    a.pinReviewBaseline()
    const x = color(a, tA, 2 * S, 3 * S, AGENT)
    label(a, kept, 'agent', AGENT)
    const mine = color(a, tB, 0, S)
    const before = ids(a)
    const len = a.historyStatus().len
    a.revertReviewAll()
    expect(a.historyStatus().len).toBe(len + 1)
    expect(a.historyView(1).ops[0]).toMatchObject({ actor: { kind: 'User' }, label_key: 'history.review.revert' })
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
    const layers = root(a.snapshot()).tracks.flatMap((t) => t.layers)
    expect(layers.map((l) => l.id)).toEqual([kept])
    expect(layers[0].label ?? null).toBeNull()
    ok(a.dispatch('undo', {}))
    expect(ids(a)).toEqual(before)
    expect(new Set(before.unreviewed)).toEqual(new Set([L(x), L(kept)]))
    expect(before.user).toEqual([L(mine)])
  })

  it('reads the agent ops it took back as reverted, as a checkpoint restore does', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S)
    const userOp = lastOp(a)
    a.pinReviewBaseline()
    color(a, tA, 2 * S, 3 * S, AGENT)
    const agentOp = lastOp(a)
    a.revertReviewAll()
    expect(a.historyEffects([userOp, agentOp])).toEqual(['applied', 'reverted'])
  })

  it('leaves the baseline where it is, so the next work session re-pins', () => {
    const { a, tA } = setup()
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    const rev = a.reviewRevision()
    a.revertReviewAll()
    expect(a.reviewRevision()).toBe(rev)
    expect(a.pinReviewBaseline()).toBe(true)
  })

  it('is refused under the history lock and without a baseline, recording nothing', () => {
    const { a, tA } = setup()
    expect(() => a.revertReviewAll()).toThrow(/InvalidArgument/)
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    a.lockHistory('agent at work')
    const status = a.historyStatus()
    expect(() => a.revertReviewAll()).toThrow(/HistoryLocked/)
    expect(a.historyStatus()).toEqual(status)
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

  it('an fps re-snap reaches the approved baseline as it does every snapshot: no change', () => {
    const { a } = setup()
    a.pinReviewBaseline()
    ok(a.dispatch('add_marker', { t_us: 100_000 }, AGENT))
    a.approveReviewAll()
    // No layer anywhere, so the rate is free; the marker re-snaps to 24 fps in
    // every snapshot and in the base alike.
    ok(a.dispatch('set_composition', { fps: { num: 24, den: 1 } }))
    expect(root(a.snapshot()).markers[0].t_us).not.toBe(100_000)
    expect(ids(a)).toEqual({ unreviewed: [], user: [] })
  })
})

describe('Review baseline — content revision', () => {
  it('moves only when what the state lists does', () => {
    const { a, tA, tB } = setup()
    a.pinReviewBaseline()
    color(a, tA, 0, S, AGENT)
    const y = color(a, tB, 0, S)
    const first = a.reviewState().content_revision
    expect(a.reviewState().content_revision).toBe(first)
    const withUser = a.reviewState().content_revision_with_user
    // The user's clip is still "added, 1 s long": a new state, the same lists.
    label(a, y, 'renamed')
    expect([a.reviewState().content_revision, a.reviewState().content_revision_with_user]).toEqual([first, withUser])
    // Moved, it is a different user change — nothing a reader of the
    // unreviewed list alone reads.
    ok(a.dispatch('move_layer', { layer: y, to_track: tB, t_start_us: 2 * S, escape_link: false }))
    expect(a.reviewState().content_revision).toBe(first)
    expect(a.reviewState().content_revision_with_user).toBeGreaterThan(withUser)
    ok(a.dispatch('update_layer', { layer: y, patch: { label: 'theirs' } }, AGENT))
    expect(a.reviewState().content_revision).toBeGreaterThan(first)
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

  it('a reset lets go of the memo, and with it the previous project\'s snapshots', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, 'op0')
    h.record({ op_id: 'op1', actor: AGENT, timestamp: '<TS>', summary: 's', label_key: 'k', affected: [], snapshot: { ...p0 } })
    h.reviewState()
    const memo = () => (h as unknown as { reviewMemo: unknown }).reviewMemo
    expect(memo()).not.toBeNull()
    h.reset(blankProject(gen, 'next'), { kind: 'User' }, 'op2')
    expect(memo()).toBeNull()
    expect(h.reviewState().has_baseline).toBe(false)
    expect(memo()).toBeNull()
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

// Per-activity highlight (ticket 07): what recorded ops did, each against its
// predecessor snapshot — independent of the baseline and of the cursor.
describe('opDiff — what one call did', () => {
  const lastOp = (a: ActorHandle) => a.historyView(a.historyCapacity()).ops.at(-1)!.op_id

  it('diffs an op against its predecessor, not against the baseline or the current state', () => {
    const { a, tA } = setup()
    const before = color(a, tA, 0, S, AGENT)
    const x = color(a, tA, 2 * S, 3 * S, AGENT)
    const op = lastOp(a)
    label(a, before, 'later', AGENT)
    expect(a.reviewOpDiff([op])).toMatchObject({ available: true, reverted: false, changes: [{ id: L(x), class: 'added' }] })
  })

  it('draws what a call did on the current timeline, not where it was then', () => {
    const { a, tA } = setup()
    const first = color(a, tA, 0, 2 * S)
    color(a, tA, 4 * S, 5 * S, AGENT)
    const addX = lastOp(a)
    const gone = color(a, tA, 6 * S, 7 * S)
    color(a, tA, 7 * S, 8 * S)
    ok(a.dispatch('delete_layers', { layers: [gone] }, AGENT))
    const lift = lastOp(a)
    // A later ripple pulls everything 2 s earlier.
    ok(a.dispatch('ripple_delete_layers', { layers: [first] }))
    const span = (op: string) => a.reviewOpDiff([op]).changes[0]!.ranges.map((r) => [r.t_start_us, r.t_end_us])
    expect(span(addX)).toEqual([[2 * S, 3 * S]])
    expect(span(lift)).toEqual([])
    expect(a.reviewOpDiff([lift]).changes[0].before_ranges).toMatchObject([{ t_start_us: 6 * S, t_end_us: 7 * S }])
  })

  it('folds adjacent ops of one call into one diff and unions separate runs', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S, AGENT)
    const add = lastOp(a)
    label(a, x, 'named', AGENT)
    const rename = lastOp(a)
    const y = color(a, tA, 2 * S, 3 * S) // someone else's op in between
    label(a, y, 'y', AGENT)
    const later = lastOp(a)
    // Add-then-rename reads as one `added`; the later rename is its own run.
    const d = a.reviewOpDiff([add, rename, later])
    expect(d.changes.map((c) => [c.id, c.class])).toEqual([[L(x), 'added'], [L(y), 'modified']])
  })

  it('an undone op still describes what it did, flagged reverted', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S, AGENT)
    const op = lastOp(a)
    ok(a.dispatch('undo', {}))
    expect(a.reviewOpDiff([op])).toMatchObject({ available: true, reverted: true, changes: [{ id: L(x), class: 'added' }] })
  })

  it('a checkpoint restore op diffs the state it replaced against the restored one', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S)
    const cp = a.checkpoint('before')
    label(a, x, 'edited')
    const y = color(a, tA, 2 * S, 3 * S)
    ok(a.dispatch('restore_checkpoint', { checkpoint_id: cp }, AGENT))
    const d = a.reviewOpDiff([lastOp(a)])
    expect(d.available).toBe(true)
    expect(d.changes.map((c) => [c.id, c.class]).sort()).toEqual([[L(x), 'modified'], [L(y), 'removed']])
  })

  it('a ripple activity lists removed and moved entities independently', () => {
    const { a, tA } = setup()
    const gone = color(a, tA, 0, S), tail = color(a, tA, S, 2 * S)
    ok(a.dispatch('ripple_delete_layers', { layers: [gone] }, AGENT))
    const op = lastOp(a)
    const result = a.reviewOpDiff([op])
    expect(new Set(result.changes.map(c => c.id))).toEqual(new Set([L(gone), L(tail)]))
    expect(result.changes.find(c => c.id === L(gone))!.ranges).toEqual([])
  })

  it('activity decorations use the surviving entity in its current Group', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 2 * S, 3 * S)
    label(a, x, 'Updated', AGENT)
    const op = lastOp(a)
    const group = ok(a.dispatch('groups_create', { layers: [x], label: 'Container' })) as { layer_id: Uuid; composition_id: Uuid }
    const result = a.reviewOpDiff([op])
    expect(result.changes[0]).toMatchObject({
      details: [{ type: 'label' }],
      before_ranges: [{ composition_id: a.snapshot().root_id, t_start_us: 2 * S }],
      ranges: [{ composition_id: group.composition_id, t_start_us: 0 }],
    })
    expect(result.decorations).toMatchObject([{ layer_id: group.layer_id, change_ids: [L(x)] }])
  })

  it('is unavailable once an op leaves the history window, or was never on it', () => {
    const { a, tA } = setup()
    const x = color(a, tA, 0, S, AGENT)
    const op = lastOp(a)
    expect(a.reviewOpDiff([op, 'not-an-op'])).toEqual({ available: false, reverted: false, changes: [], decorations: [] })
    expect(a.reviewOpDiff([])).toMatchObject({ available: false })
    // Its predecessor goes first: as the oldest stored entry it has nothing to diff against.
    for (let i = 0; i < a.historyCapacity() - 1; i++) label(a, x, `n${i}`)
    expect(a.historyView(1).evicted).toBe(1)
    expect(a.reviewOpDiff([op])).toMatchObject({ available: false, changes: [] })
    label(a, x, 'gone')
    expect(a.reviewOpDiff([op])).toMatchObject({ available: false, changes: [] })
  })

  it('an undone op truncated off the redo tail is no longer available', () => {
    const { a, tA } = setup()
    color(a, tA, 0, S, AGENT)
    const op = lastOp(a)
    ok(a.dispatch('undo', {}))
    color(a, tA, 2 * S, 3 * S)
    expect(a.reviewOpDiff([op]).available).toBe(false)
  })
})
