// apps/desktop/src/main/state/history.ts
import type { MediaItem, Project, ProjectSettings, RoleMixSettings, Uuid } from './model'
import { HISTORY_SUMMARY, createLayerFlattener, resolveEntityLabels, restoredCheckpointSummary, type EntityLabel } from './history-labels'
import { diffProjects, groupDecorations, locateChanges } from './reviewDiff'
import { jsonEqual, touchedEntityKeys } from './reviewEntities'
import type { Change, EntityKey, GroupDecoration } from '../../shared/review'

export type Actor = { kind: 'User' } | { kind: 'Agent'; client: string }
export type EntityRef =
  | { kind: 'Track'; id: Uuid } | { kind: 'Layer'; id: Uuid } | { kind: 'Marker'; id: Uuid }

/** Mirrors `TrackFlagsPatch` in apps/desktop/native/src/state/project.rs —
 *  preference-shaped track toggles. null/absent = "don't touch". */
export interface TrackFlagsPatch { enabled?: boolean | null; muted?: boolean | null; solo?: boolean | null; locked?: boolean | null }

/** native/src/state/audio_role.rs:67 RoleFlagsPatch — the Mixer panel's M/S
 *  toggles. null/absent = "don't touch". Unrecorded (preference-shaped). */
export interface RoleFlagsPatch { muted?: boolean | null; solo?: boolean | null }

export interface HistoryEntry {
  op_id: Uuid; actor: Actor; timestamp: string; summary: string
  /** The `HistorySummary.key` whose `.text` is `summary` — recorded alongside it
   *  rather than looked up from it, so a reworded phrase cannot lose its key
   *  (history-labels.ts). */
  label_key: string
  /** i18n interpolation values for `label_key`; absent for the phrases that take
   *  none. The runtime data `summary` embeds inline travels here instead, so the
   *  panel can rebuild the row in its own language. */
  label_args?: Record<string, string | number>
  affected: EntityRef[]; snapshot: Project
}
interface NamedCheckpoint { id: Uuid; label: string; actor: Actor; created_at: string; snapshot: Project }
export interface HistoryEntrySummary {
  op_id: Uuid; actor: Actor; timestamp: string; summary: string; label_key: string
  label_args?: Record<string, string | number>
  affected: EntityRef[]
  /** Names for `affected`, PARALLEL to it (same length, same order), resolved
   *  against whichever STORED snapshot holds each ref — this entry's own for an
   *  add / update / move, its PREDECESSOR's for a delete (an entry stores the
   *  state AFTER its own op, so a delete's own snapshot is precisely the one
   *  that no longer holds it). See resolveEntityLabels. */
  entity_labels: EntityLabel[]
}
export interface HistoryView {
  ops: HistoryEntrySummary[]; cursor: number; len: number
  /** Absolute stack index of `ops[0]` (= `len - ops.length`). `ops` is the LAST
   *  `limit` entries, so `ops[i]`'s absolute index is `window_start + i` — the
   *  index `cursor` is stated in, and the only index `jumpTo` accepts.
   *
   *  Without it a windowed read is unreadable: `view(100)` over a 150-entry stack
   *  reports `cursor: 149` against a 100-element array, and `evicted: 0` while the
   *  first op returned is the 51st of the project. `window_start === 0 &&
   *  evicted === 0` is the ONLY combination that means "ops[0] is the start of the
   *  project"; `window_start > 0` means the window is narrower than the stack, and
   *  `evicted > 0` means the stack itself is narrower than the project. */
  window_start: number
  checkpoints: Array<{ id: Uuid; label: string; actor: Actor; created_at: string }>
  /** How many entries `record()` has dropped off the FRONT since the stack was
   *  seeded (0 until the cap is first exceeded; back to 0 after `reset()`).
   *
   *  The eviction does NOT spare the 'Initial' entry, so once it has run the top
   *  row is an ordinary op and nothing else on the wire distinguishes "this is
   *  the start of the project" from "everything before this was discarded" —
   *  which is exactly what decides whether jumping back there is safe. `len` is
   *  the LIVE stack length and cannot answer it. */
  evicted: number
  lock_reason?: string
}
/** One recorded op, named without its snapshot — a `HistoryView` row. */
export type HistoryOpRef = HistoryEntrySummary
export interface HistoryStatus {
  cursor: number; len: number; can_undo: boolean; can_redo: boolean; lock_reason?: string
  /** storedSnapshotsHoldLayer() — the fps rate lock's condition, carried here
   *  because only History can answer it and the settings UI has to disable the
   *  rate control BEFORE the user tries. Not part of the `HistoryView` wire
   *  shape: buildProjectSummary folds it into `composition.fps_locked`, where a
   *  consumer will actually look for it. */
  holds_layer_anywhere: boolean
}

const DEFAULT_CAP = 200

/** The Review baseline (ADR 0115; spec Part B): the state the user last
 *  accepted — one whole snapshot, patched by every `*Everywhere` preference
 *  patch exactly like a checkpoint, but never listed, deleted or named.
 *  `agentTouched` holds every entity an Agent-sourced recorded commit touched
 *  since. */
export interface ReviewBaseline {
  readonly base: Project
  readonly agentTouched: ReadonlySet<EntityKey>
}
/** `effects`: the op lineage `base` carries, so a revert to it reads its
 *  agent ops as reverted (effectStates), as a checkpoint restore does. */
interface MutableBaseline { base: Project; effects: ReadonlySet<Uuid>; agentTouched: Set<EntityKey> }

/** The baseline compared against `current()`: unreviewed changes (any key an
 *  agent touched) and user-only ones, plus Group decorations for both. */
export interface ReviewState {
  baseline_revision: number
  /** Moves whenever what a reader without the user-only list reads does —
   *  the unreviewed list, the decorations, whether there is a baseline — and
   *  only then: a commit that changes none of it keeps it. Only ever
   *  increases. */
  content_revision: number
  /** As `content_revision`, for a reader of the user-only list too. */
  content_revision_with_user: number
  has_baseline: boolean
  unreviewed: Change[]
  user: Change[]
  decorations: GroupDecoration[]
}

/** What a set of recorded ops did — `History.opDiff`, served as
 *  `review_activity_view` (shared/review.ts `ReviewActivityView`). */
export interface OpDiff {
  available: boolean
  reverted: boolean
  changes: Change[]
  decorations: GroupDecoration[]
}
const unavailableOpDiff = (): OpDiff => ({ available: false, reverted: false, changes: [], decorations: [] })

const sameChanges = (a: readonly Change[], b: readonly Change[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i] || jsonEqual(x, b[i]))

/** What a run of ops did — its predecessor snapshot against its last one —
 *  kept per pair of snapshots. Both are immutable, so the diff is too: a
 *  selected activity is re-read on every commit (its changes are placed on
 *  the current timeline), and only that placing depends on the commit. A
 *  snapshot rewritten by an `*Everywhere` patch is a new object, and diffs
 *  afresh. */
const runDiffs = new WeakMap<Project, WeakMap<Project, Change[]>>()
function runDiff(before: Project, after: Project): Change[] {
  let byAfter = runDiffs.get(before)
  if (!byAfter) runDiffs.set(before, byAfter = new WeakMap())
  let changes = byAfter.get(after)
  if (!changes) byAfter.set(after, changes = diffProjects(before, after))
  return changes
}

/** The 'Initial' entry's summary half — shared by the constructor and reset() so
 *  the seed row is spelled once. */
function seed(initial: Project): Pick<HistoryEntry, 'summary' | 'label_key' | 'affected' | 'snapshot'> {
  return { summary: HISTORY_SUMMARY.initial.text, label_key: HISTORY_SUMMARY.initial.key, affected: [], snapshot: initial }
}

/** Ids/timestamps are injected by the actor (which owns the deterministic
 *  counter) rather than minted here. */
export class History {
  private snapshots: HistoryEntry[] = []
  private cursor = 0
  private cap = DEFAULT_CAP
  private checkpoints = new Map<Uuid, NamedCheckpoint>()
  private lockReasonStr: string | null = null
  /** Front-evicted entry count — see HistoryView.evicted. */
  private evictedCount = 0
  // Runtime provenance, independent of serialized project data. Bounded IDs
  // make old, untraceable effects explicitly unknown rather than falsely undone.
  private effectLineage = new WeakMap<object, ReadonlySet<Uuid>>()
  private knownEffects = new Set<Uuid>()
  // Review baseline — null until a work session begins or an agent first
  // commits. Revision only ever increases (also across reset) so a consumer's
  // cached view can never be mistaken for a fresh one.
  private review: MutableBaseline | null = null
  private reviewRev = 0
  private reviewMemo: { rev: number; base: Project; current: Project; state: ReviewState } | null = null
  private reviewContent = 0
  private reviewContentWithUser = 0
  /** The last state handed out, for the content comparison. */
  private reviewLast: ReviewState | null = null
  private reviewListener: ((revision: number) => void) | null = null

  effectStates(ids: readonly Uuid[]): Array<'applied' | 'reverted' | 'unknown'> {
    const active = this.effectLineage.get(this.snapshots[this.cursor])
    return ids.map(id => !this.knownEffects.has(id) ? 'unknown' : active?.has(id) ? 'applied' : 'reverted')
  }

  constructor(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>') {
    this.snapshots.push({ op_id: opId, actor, timestamp, ...seed(initial) })
    this.cursor = 0
  }

  /** Discard the stack + checkpoints + lock, seed a fresh single 'Initial'
   *  entry. Used by replace_state on a
   *  project swap: the prior project's snapshots/checkpoints reference a
   *  different project_id and are incoherent against the new state. */
  reset(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>'): void {
    this.snapshots = [{ op_id: opId, actor, timestamp, ...seed(initial) }]
    this.cursor = 0
    this.checkpoints.clear()
    this.lockReasonStr = null
    this.evictedCount = 0 // a fresh stack has discarded nothing
    this.effectLineage = new WeakMap()
    this.knownEffects.clear()
    // A project opening's baseline goes with its history (ADR 0115), and so
    // do the memo and the last state holding the previous project's snapshots.
    this.reviewMemo = null
    this.reviewLast = null
    if (this.review !== null) { this.review = null; this.bumpReview() }
  }

  current(): Project { return this.snapshots[this.cursor].snapshot }

  record(entry: HistoryEntry, baseEffects = this.effectLineage.get(this.snapshots[this.cursor])): void {
    this.attribute(this.snapshots[this.cursor].snapshot, entry)
    this.knownEffects.add(entry.op_id)
    if (this.knownEffects.size > 4000) this.knownEffects.delete(this.knownEffects.values().next().value!)
    const effects = new Set([...baseEffects ?? []].filter(id => this.knownEffects.has(id)))
    effects.add(entry.op_id)
    this.effectLineage.set(entry, effects)
    this.snapshots = this.snapshots.slice(0, this.cursor + 1) // truncate redo tail
    this.snapshots.push(entry)
    while (this.snapshots.length > this.cap) { this.snapshots.shift(); this.evictedCount += 1 } // evict front
    this.cursor = this.snapshots.length - 1
  }

  /** The op at absolute stack index `index` — who made it and what it was —
   *  or null outside `[0, len)`. What undo and redo name when they answer. */
  entryAt(index: number): HistoryOpRef | null {
    const e = this.snapshots[index]
    if (!e) return null
    return {
      op_id: e.op_id, actor: e.actor, timestamp: e.timestamp, summary: e.summary, label_key: e.label_key, ...(e.label_args ? { label_args: e.label_args } : {}),
      affected: e.affected,
      entity_labels: resolveEntityLabels(e.snapshot, this.snapshots[index - 1]?.snapshot ?? null, e.affected, createLayerFlattener()),
    }
  }

  undo(): Project | null {
    if (this.cursor === 0) return null
    this.cursor -= 1
    return this.snapshots[this.cursor].snapshot
  }
  redo(): Project | null {
    if (this.cursor + 1 >= this.snapshots.length) return null
    this.cursor += 1
    return this.snapshots[this.cursor].snapshot
  }
  /** Random-access cursor move: `undo`/`redo` generalized to an arbitrary index.
   *  Returns `snapshots[index]`'s state — the state AFTER op `index` — or `null`
   *  for anything outside `[0, len)` (and for a non-integer index, which can only
   *  come from a malformed call).
   *
   *  Records NO entry, exactly like `undo`/`redo` (docs/features.md
   *  #undo-stack-scope): moving the cursor introduces no state from outside the
   *  stack, so there is nothing to record. A later `record()` therefore truncates
   *  the tail from here, which is the standard NLE "resume from the past". */
  jumpTo(index: number): Project | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.snapshots.length) return null
    this.cursor = index
    return this.snapshots[index].snapshot
  }
  canUndo(): boolean { return this.cursor > 0 }
  canRedo(): boolean { return this.cursor + 1 < this.snapshots.length }
  cursorIndex(): number { return this.cursor }
  len(): number { return this.snapshots.length }
  /** The stack cap — how many entries survive before `record()` evicts. Exposed
   *  so the history panel's "give me the whole stack" read can ask for exactly
   *  that many rows instead of hardcoding the number at the call site. */
  capacity(): number { return this.cap }

  lock(reason: string): void { this.lockReasonStr = reason }
  unlock(): void { this.lockReasonStr = null }
  lockReason(): string | null { return this.lockReasonStr }

  checkpoint(label: string, actor: Actor, id: Uuid, createdAt = '<TS>'): Uuid {
    this.checkpoints.set(id, { id, label, actor, created_at: createdAt, snapshot: this.current() })
    this.effectLineage.set(this.checkpoints.get(id)!, this.effectLineage.get(this.snapshots[this.cursor]) ?? new Set())
    return id
  }
  restoreCheckpoint(id: Uuid, opId: Uuid, timestamp: string, actor: Actor): Project | null {
    const cp = this.checkpoints.get(id)
    if (!cp) return null
    const s = restoredCheckpointSummary(cp.label)
    this.record({ op_id: opId, actor, timestamp, summary: s.text, label_key: s.key, label_args: s.label_args, affected: [], snapshot: cp.snapshot }, this.effectLineage.get(cp) ?? new Set())
    return cp.snapshot
  }
  listCheckpoints(): NamedCheckpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  }
  /** Presence peek. The actor checks this BEFORE minting the restore op_id, so
   *  a CheckpointNotFound restore burns zero ids. */
  hasCheckpoint(id: Uuid): boolean { return this.checkpoints.has(id) }
  /** Drop a checkpoint (and with it the full snapshot it pins); `false` when
   *  there was no such id. Deliberately uncapped on the create side: each
   *  checkpoint holds a whole Project, so the list would turn to landfill in one
   *  session without a delete — with one, a hard cap would only produce a dead
   *  end (spec decision 10). Cursor and stack untouched: a checkpoint is not a
   *  stack row. */
  deleteCheckpoint(id: Uuid): boolean { return this.checkpoints.delete(id) }

  // ── Review baseline (ADR 0115) ────────────────────────────────────────────

  /** Attribution: an Agent-sourced recorded commit (a checkpoint restore an
   *  agent performs included) adds every entity it touched to `agentTouched`,
   *  initializing the baseline from its predecessor when there is none yet.
   *  User commits add nothing — and remove nothing, so a user edit cannot
   *  launder an agent change. Undo/redo record nothing and need nothing: values
   *  are compared, so a change undone back to the baseline simply disappears. */
  private attribute(predecessor: Project, entry: HistoryEntry): void {
    if (entry.actor.kind !== 'Agent') return
    let changed = false
    if (this.review === null) { this.review = this.pinned(predecessor, this.effectLineage.get(this.snapshots[this.cursor])); changed = true }
    const touched = this.review.agentTouched
    for (const k of touchedEntityKeys(predecessor, entry.snapshot)) {
      if (!touched.has(k)) { touched.add(k); changed = true }
    }
    if (changed) this.bumpReview()
  }

  private bumpReview(): void {
    this.reviewRev += 1
    try { this.reviewListener?.(this.reviewRev) }
    catch (err) { console.warn('[history] review listener threw', err) }
  }

  /** One listener (the actor), told the new revision on every baseline change:
   *  initialize, re-pin, approval, attribution, reset. Not on `*Everywhere`
   *  patches — those already broadcast, and the review memo keys on the
   *  patched snapshots' identity. */
  onReviewChange(cb: ((revision: number) => void) | null): void { this.reviewListener = cb }
  reviewBaseline(): ReviewBaseline | null { return this.review }

  /** A fresh baseline at `base`: nothing touched since. */
  private pinned(base: Project, effects: ReadonlySet<Uuid> | undefined): MutableBaseline {
    return { base, effects: effects ?? new Set(), agentTouched: new Set() }
  }

  /** Work session begin: initialize from the checkpoint `checkpointId` (the
   *  session's `Pre-agent` one; the current state when absent or gone) when
   *  there is no baseline; re-pin to it only when nothing is unreviewed,
   *  otherwise keep accumulating. Returns whether the baseline now IS that
   *  state. */
  pinReviewBaseline(checkpointId?: Uuid): boolean {
    if (this.review !== null && this.reviewState().unreviewed.length > 0) return false
    const cp = checkpointId !== undefined ? this.checkpoints.get(checkpointId) : undefined
    this.review = cp ? this.pinned(cp.snapshot, this.effectLineage.get(cp)) : this.pinned(this.current(), this.effectLineage.get(this.snapshots[this.cursor]))
    this.bumpReview()
    return true
  }

  /** Approve all: the baseline becomes the current state — the user's own
   *  differences with the agent's. Records nothing and ignores the history
   *  lock (approval changes no project state). No-op without a baseline. */
  approveAll(): void {
    if (this.review === null) return
    this.review = this.pinned(this.current(), this.effectLineage.get(this.snapshots[this.cursor]))
    this.bumpReview()
  }

  /** Revert all: record the baseline as the current state — a checkpoint
   *  restore to it, the user's own differences going with the agent's. The
   *  baseline and what agents touched stay, so undoing the revert lists the
   *  same changes again. Null (and nothing recorded) without a baseline. */
  revertToReviewBaseline(opId: Uuid, timestamp: string, actor: Actor): Project | null {
    const review = this.review
    if (review === null) return null
    const s = HISTORY_SUMMARY.reviewRevert
    this.record({ op_id: opId, actor, timestamp, summary: s.text, label_key: s.key, affected: [], snapshot: review.base }, review.effects)
    return review.base
  }

  /** The baseline against the current state, memoized on (baseline revision,
   *  base and current snapshot identity) — computed only when asked. */
  reviewState(): ReviewState {
    const review = this.review
    const current = this.current()
    if (review === null) {
      this.reviewMemo = null
      return this.stamped({ baseline_revision: this.reviewRev, has_baseline: false, unreviewed: [], user: [], decorations: [] })
    }
    const m = this.reviewMemo
    if (m && m.rev === this.reviewRev && m.base === review.base && m.current === current) return m.state
    const changes = diffProjects(review.base, current)
    const unreviewed: Change[] = [], user: Change[] = []
    for (const c of changes) (review.agentTouched.has(c.id) ? unreviewed : user).push(c)
    const state = this.stamped({ baseline_revision: this.reviewRev, has_baseline: true, unreviewed, user, decorations: groupDecorations(changes, current) })
    this.reviewMemo = { rev: this.reviewRev, base: review.base, current, state }
    return state
  }

  /** The baseline revision alone, without computing the state. */
  reviewRevision(): number { return this.reviewRev }

  /** `state` with its content revision: the last one's when it lists the
   *  same, else the next. A change the diff kept is the very same object
   *  (`diffProjects`), so comparing lists is mostly by reference. */
  private stamped(state: Omit<ReviewState, 'content_revision' | 'content_revision_with_user'>): ReviewState {
    const last = this.reviewLast
    const sameListed = last !== null && last.has_baseline === state.has_baseline && sameChanges(last.unreviewed, state.unreviewed)
      && jsonEqual(last.decorations, state.decorations)
    if (!sameListed) this.reviewContent += 1
    if (!sameListed || !sameChanges(last!.user, state.user)) this.reviewContentWithUser += 1
    const out = { ...state, content_revision: this.reviewContent, content_revision_with_user: this.reviewContentWithUser }
    this.reviewLast = out
    return out
  }

  /** What the recorded ops `ids` did (spec Part B, per-activity highlight):
   *  each op's predecessor snapshot against its own, independent of the
   *  cursor and of the Review baseline — an undone op still describes what it
   *  did. Ops adjacent on the stack fold into one run diffed end to end (a
   *  call that adds a clip and then trims it reads as one `added`); separate
   *  runs union, a later run's change replacing an earlier one with the same
   *  id. `available` is false — and nothing else is returned — when any op is
   *  no longer on the stack (evicted, truncated off a redo tail, never
   *  recorded) or its predecessor is gone (the oldest stored entry). A
   *  partial picture would read as the whole call. `reverted`: every op is
   *  undone (effectStates). */
  opDiff(ids: readonly Uuid[]): OpDiff {
    const index = new Map(this.snapshots.map((e, i) => [e.op_id, i]))
    const at: number[] = []
    for (const id of new Set(ids)) {
      const i = index.get(id)
      if (i === undefined || i === 0) return unavailableOpDiff()
      at.push(i)
    }
    if (at.length === 0) return unavailableOpDiff()
    at.sort((a, b) => a - b)
    const current = this.current()
    const changes = new Map<string, Change>()
    for (let s = 0; s < at.length;) {
      let e = s
      while (e + 1 < at.length && at[e + 1] === at[e] + 1) e += 1
      const run = runDiff(this.snapshots[at[s] - 1].snapshot, this.snapshots[at[e]].snapshot)
      for (const c of run) { changes.delete(c.id); changes.set(c.id, c) }
      s = e + 1
    }
    const located = locateChanges([...changes.values()], current)
    return { available: true, reverted: this.effectStates(ids).every((x) => x === 'reverted'), changes: located, decorations: groupDecorations(located, current) }
  }

  /** Preference patch applied to ALL snapshots + checkpoints; cursor unchanged
   *  (project_settings_patch_convention). The track-flag variant is
   *  replaceTrackFlagsEverywhere, the audio-role-flag one
   *  replaceRoleFlagsEverywhere. */
  replaceSettingsEverywhere(settings: ProjectSettings): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, settings: { ...settings } }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, settings: { ...settings } }
    if (this.review) this.review.base = { ...this.review.base, settings: { ...settings } }
  }

  /** Patch one track's flags into EVERY snapshot + checkpoint where the track
   *  exists — in whichever composition holds it (a track id lives in exactly
   *  one); skip snapshots that lack it; cursor unchanged; never recorded
   *  (project_settings_patch_convention). Rebuilt by spread, never mutated in
   *  place: `createLayerFlattener` memoizes on snapshot identity. */
  replaceTrackFlagsEverywhere(trackId: Uuid, patch: TrackFlagsPatch): void {
    const patchTrack = (p: Project): Project => {
      for (const [cid, c] of Object.entries(p.compositions)) {
        const ti = c.tracks.findIndex((t) => t.id === trackId)
        if (ti < 0) continue
        const nt = { ...c.tracks[ti] }
        if (typeof patch.enabled === 'boolean') nt.enabled = patch.enabled
        if (typeof patch.muted === 'boolean') nt.muted = patch.muted
        if (typeof patch.solo === 'boolean') nt.solo = patch.solo
        if (typeof patch.locked === 'boolean') nt.locked = patch.locked
        return { ...p, compositions: { ...p.compositions, [cid]: { ...c, tracks: c.tracks.map((t, i) => (i === ti ? nt : t)) } } }
      }
      return p // the snapshot predates the track
    }
    for (const e of this.snapshots) e.snapshot = patchTrack(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = patchTrack(cp.snapshot)
    if (this.review) this.review.base = patchTrack(this.review.base)
  }

  /** Patch one audio role's mute/solo into EVERY snapshot + checkpoint.
   *  Roles ALWAYS exist (absent → RoleMixSettings default {gain_db:0,muted:false,solo:false}),
   *  so unlike tracks there is NO skip-when-absent branch: the patch applies unconditionally.
   *  gain_db is preserved (only mute/solo are preference-shaped). cursor unchanged; never
   *  recorded (project_settings_patch_convention). */
  replaceRoleFlagsEverywhere(role: string, patch: RoleFlagsPatch): void {
    const apply = (p: Project): Project => {
      const cur = p.audio_roles[role]
      const s: RoleMixSettings = { gain_db: cur?.gain_db ?? 0, muted: cur?.muted ?? false, solo: cur?.solo ?? false }
      if (typeof patch.muted === 'boolean') s.muted = patch.muted
      if (typeof patch.solo === 'boolean') s.solo = patch.solo
      return { ...p, audio_roles: { ...p.audio_roles, [role]: s } }
    }
    for (const e of this.snapshots) e.snapshot = apply(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = apply(cp.snapshot)
    if (this.review) this.review.base = apply(this.review.base)
  }

  /** Set `media_pool` on EVERY snapshot + checkpoint.
   *  Media imports live OUTSIDE the editing undo/redo stack, so the
   *  pool must be durable across undos/redos through unrelated edits (cursor
   *  unchanged; never recorded — project_settings_patch_convention). */
  replaceMediaPoolEverywhere(pool: Record<string, MediaItem>): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, media_pool: pool }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, media_pool: pool }
    if (this.review) this.review.base = { ...this.review.base, media_pool: pool }
  }

  /** The WHOLE composition envelope is preference-shaped (docs/features.md
   *  #undo-stack-scope), so `set_composition` never records and instead runs its
   *  patch over EVERY snapshot + checkpoint (cursor unchanged).
   *
   *  A transform, not a field copy, because two of the fields cannot be copied
   *  verbatim into an older snapshot: an fps change must re-snap THAT snapshot's
   *  own markers to the new grid, and a pinned `duration_us` must be floored at
   *  THAT snapshot's own content high-water mark or the older snapshot would
   *  strand a layer past the composition end. The actor supplies the transform
   *  (it owns the snap + autofit rules); History only fans it out. */
  replaceCompositionEverywhere(transform: (p: Project) => Project): void {
    for (const e of this.snapshots) e.snapshot = transform(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = transform(cp.snapshot)
    if (this.review) this.review.base = transform(this.review.base)
  }

  /** Does ANY stored snapshot or checkpoint hold a layer? The history-scope half
   *  of the fps rate lock — see docs/features.md #undo-stack-scope.
   *
   *  `snapshots` includes the cursor's own entry, so this subsumes the current
   *  state; the actor tests the current layer count first only to report WHICH
   *  scope blocked (`locked_by`). */
  storedSnapshotsHoldLayer(): boolean {
    // Every composition: the fps write this guards lands in all of them.
    const holds = (p: Project): boolean => Object.values(p.compositions).some((c) => c.tracks.some((t) => t.layers.length > 0))
    return this.snapshots.some((e) => holds(e.snapshot))
      || [...this.checkpoints.values()].some((cp) => holds(cp.snapshot))
  }

  view(limit: number): HistoryView {
    const total = this.snapshots.length
    const take = Math.min(limit, total)
    const start = total - take
    // entity_labels resolves against STORED snapshots, never current() — an entry
    // whose layer has since been deleted still names it. An entry stores the state
    // AFTER its own op, so a delete is nameable only from its PREDECESSOR; the
    // index is absolute because that predecessor may sit outside this window
    // (history-labels.ts owns the fallback chain).
    // One flattener for the WHOLE call: adjacent entries share snapshot objects
    // (entry i's `after` is entry i+1's `before`), so without the memo every
    // snapshot is flattened twice — synchronous main work on every commit while
    // the panel is open.
    const flatten = createLayerFlattener()
    const ops = this.snapshots.slice(start).map((e, i) => ({
      op_id: e.op_id, actor: e.actor, timestamp: e.timestamp, summary: e.summary, label_key: e.label_key,
      label_args: e.label_args, affected: e.affected,
      entity_labels: resolveEntityLabels(e.snapshot, this.snapshots[start + i - 1]?.snapshot ?? null, e.affected, flatten),
    }))
    const checkpoints = this.listCheckpoints().map((c) => ({ id: c.id, label: c.label, actor: c.actor, created_at: c.created_at }))
    const v: HistoryView = { ops, cursor: this.cursor, len: total, window_start: start, checkpoints, evicted: this.evictedCount }
    if (this.lockReasonStr !== null) v.lock_reason = this.lockReasonStr
    return v
  }
  status(): HistoryStatus {
    const s: HistoryStatus = {
      cursor: this.cursor, len: this.snapshots.length, can_undo: this.canUndo(), can_redo: this.canRedo(),
      holds_layer_anywhere: this.storedSnapshotsHoldLayer(),
    }
    if (this.lockReasonStr !== null) s.lock_reason = this.lockReasonStr
    return s
  }
}
