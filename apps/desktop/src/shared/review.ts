// apps/desktop/src/shared/review.ts
//
// Wire types of agent review (spec `.scratch/agent-review/spec.md` Part B;
// ADR 0115): the entity-level changes between the Review baseline and the
// current project, and the IPC view the renderer reads. Main computes them
// (main/state/reviewDiff.ts, History's baseline); the renderer only displays.

export type EntityKind = 'Composition' | 'Track' | 'Layer' | 'Marker' | 'Transition' | 'Link'
/** `Layer:<id>`, `Marker:<id>` … — stable across snapshots, unique project-wide. */
export type EntityKey = `${EntityKind}:${string}`

/** The kind and id an entity key names; the id may itself hold colons. */
export function parseEntityKey(key: EntityKey): { kind: EntityKind; id: string } {
  const at = key.indexOf(':')
  return { kind: key.slice(0, at) as EntityKind, id: key.slice(at + 1) }
}

/** Three, as a diff reads: what is new, what is gone, what differs. A move
 *  to another track or composition is a `modified` with `placement`; a pure
 *  translation in time is a `modified` with `timing` and `delta_us` — and,
 *  when it only went where another edit carried the content around it,
 *  `carried`, which no timeline marks (ADR 0115). */
export type ChangeClass = 'added' | 'removed' | 'modified'
export type ChangeAspect = 'placement' | 'timing' | 'retime' | 'params' | 'effects' | 'keyframes' | 'label' | 'flags'
export interface TimeRange { composition_id: string; t_start_us: number; t_end_us: number }
export interface EntityLocation { composition_id: string; track_id: string | null }
/** A range on one track (`track_id` null for a marker or transition). */
export interface PlacedRange extends TimeRange { track_id: string | null }

/** What a change did, as facts rather than words (ADR 0115): main derives them
 *  from the two snapshots; the renderer words them (`changes.detail.*`) in the
 *  editor's own vocabulary — the inspector's param names, the effect catalog's
 *  names — never an MCP tool's. Durations are timeline microseconds. */
export type ChangeDetail =
  /** Added or removed: the entity's length (a removed one's, as it was). */
  | { type: 'length'; duration_us: number }
  /** Material cut from (`delta_us` < 0) or added to (> 0) one end. */
  | { type: 'trim'; side: 'start' | 'end'; delta_us: number }
  /** Moved in time on its own: current − where the content around it was
   *  carried (the baseline place when nothing carried it). */
  | { type: 'shift'; delta_us: number }
  /** Same place, other source material: the source window moved by `delta_us`
   *  (> 0: later in the source). */
  | { type: 'slip'; delta_us: number }
  /** Moved to another track of the same composition. */
  | { type: 'track'; from: string | null; to: string | null }
  /** Moved to another composition. */
  | { type: 'composition'; from: string; to: string }
  /** Playback rate; null where it is not a constant rate. */
  | { type: 'speed'; from: number | null; to: number | null }
  /** Params whose value changed, by wire key (`opacity`, `x`…). */
  | { type: 'params'; keys: string[] }
  /** Params whose keyframes changed, by wire key. */
  | { type: 'keyframes'; keys: string[] }
  /** One effect, by its catalog type (`blur`…). */
  | { type: 'effect'; op: 'added' | 'removed' | 'changed'; effect: string }
  | { type: 'label' }
  | { type: 'enabled'; value: boolean }
  | { type: 'locked'; value: boolean }
  /** Any other difference, named by its aspect alone. */
  | { type: 'aspect'; aspect: ChangeAspect }

export interface Change {
  /** Stable for the same difference: the entity key; `Shift:<composition>:<delta>`
   *  for a translation group of its own, `Shift:<composition>:<delta>:<carrier id>`
   *  for a carried one. */
  id: string
  class: ChangeClass
  /** The entity kind; a shift group mixing layers and markers reports `Layer`. */
  kind: EntityKind
  /** Every entity the change covers — approved as one unit. */
  keys: EntityKey[]
  /** What differs. Empty for added/removed; `placement` for a move to another
   *  track or composition; `timing` alone for a translation (`delta_us`). */
  aspects: ChangeAspect[]
  /** The composition the change is listed under (current side, else baseline);
   *  null for a Composition entity. */
  composition_id: string | null
  /** Every composition the change lives in, either side. */
  composition_ids: string[]
  /** A move to another track or composition (`placement`): baseline and
   *  current location. `removed`: `from` alone, the baseline location (where
   *  the editor timeline ghosts a removed layer). */
  from?: EntityLocation
  to?: EntityLocation
  /** A translation only — the entities' timing moved, nothing else did —
   *  grouped per composition and delta into one change. Carried: how far the
   *  content carried them (current − baseline). Otherwise their OWN movement:
   *  current − where the content around them was carried. */
  delta_us?: number
  /** A translation that only went where another change carried the content
   *  around it — the clip before it on its track, the A-roll material under
   *  it, a marker's clip: a ripple closing up, an insert or a longer clip
   *  making room, a trim pulling the rest in. Listed and approved with that
   *  change; no timeline paints it, as a diff does not mark the lines a change
   *  above renumbered. */
  carried?: true
  /** The change that carried this one's movement, in the same list: a
   *  `carried` change's (approved with it, folded under its row), or a rider's
   *  (`carried_us`). */
  carried_by?: string
  /** A change that also differs in its own right but whose movement was
   *  carried by `carried_by`: how far. Its own row does not say it, the
   *  carrier's does; approving the carrier does not approve it. */
  carried_us?: number
  /** What it did, in order (`ChangeDetail`); empty for a listed-only change
   *  nothing more can be said of. */
  details: ChangeDetail[]
  /** A deliberate move (`placement`, a `shift` detail, or a non-carried
   *  `delta_us`): where each moved layer or marker was on the CURRENT
   *  timeline — its baseline place carried as far as the content around it
   *  went, the place its own movement is measured from. Drawn only while the
   *  change is focused. */
  was?: PlacedRange[]
  /** Where the change is on the CURRENT timeline, merged per composition: the
   *  current footprints; for a removed entity its baseline footprint carried
   *  over by the content around it — the seam a ripple delete left (main's
   *  `removedRangeNow`). Empty for listed-only changes (link, track,
   *  composition). */
  ranges: TimeRange[]
}

/** A Group layer that shows a composition containing changes ("contains
 *  changes"), at the Group layer's own footprint in its composition. */
export interface GroupDecoration {
  layer_id: string
  composition_id: string
  t_start_us: number
  t_end_us: number
  /** Ids of the changes it contains, directly or through nested Groups. */
  change_ids: string[]
}

/** The project publication a view was computed against (ADR 0114) plus the
 *  baseline revision — together the view's identity. `baseline_revision`
 *  increases on every baseline change (initialize, re-pin, approval,
 *  attribution, reset); it never goes back, not even across a project open. */
export interface ReviewVersion { session: number; revision: number; baseline_revision: number }

/** `review_view` arguments. The user-only list is sent only when asked for
 *  (the Changes tab's "show my changes"); its count always is. */
export interface ReviewViewArgs { include_user?: boolean }

/** What the review surfaces read (`review_view`). */
export interface ReviewView {
  version: ReviewVersion
  /** False until the first work session begins or an agent first edits. */
  has_baseline: boolean
  /** Differences an Agent-sourced commit touched since the baseline. */
  unreviewed: Change[]
  /** Differences only the user caused; hidden by default, never need approval.
   *  Empty unless the request asked for them (`include_user`). */
  user: Change[]
  /** How many user-only differences there are, listed or not. */
  user_count: number
  /** Group layers containing changes of EITHER list; filter by `change_ids`
   *  against the list on screen. */
  decorations: GroupDecoration[]
}

/** `review_approve_all` arguments. `version` is the view the user acted on:
 *  main approves only while it is still the current one, so a commit landing
 *  between what the user saw and their click is never approved unseen. */
export interface ReviewApproveAllArgs extends ReviewViewArgs { version: ReviewVersion }

/** `review_approve` arguments: change ids from the view the user acted on,
 *  and/or entity keys. A key approves the whole change that holds it (a shift
 *  group approves as a unit). Unknown ids/keys are ignored. */
export interface ReviewApproveArgs extends ReviewApproveAllArgs { change_ids?: string[]; keys?: EntityKey[] }

/** What an approval answers: whether it was applied — false when `version`
 *  is no longer the current view, and then nothing was approved — and the
 *  fresh view either way. */
export interface ReviewApproveResult { applied: boolean; view: ReviewView }

/** `review_activity_view` arguments: the history op ids of one activity row
 *  (`AgentActivity.history_ids`). */
export interface ReviewActivityArgs { history_ids: string[] }

/** What one agent call did (`review_activity_view`; spec Part B, per-activity
 *  highlight): each op's predecessor snapshot against its own, adjacent ops
 *  folded into one diff. Independent of the Review baseline and of the undo
 *  cursor. `available` is false — with no changes — once any op has left the
 *  history window (ADR 0065's provenance horizon is wider than the stack, so
 *  an activity can outlive its snapshots). `reverted`: every op is undone;
 *  the changes still describe what the call did, not the current state. */
export interface ReviewActivityView {
  available: boolean
  reverted: boolean
  changes: Change[]
  decorations: GroupDecoration[]
}

/** Main → renderer: the baseline changed (approval, attribution, re-pin,
 *  reset). Project edits arrive as `project:changed`; a review surface
 *  refetches `review_view` on either. Coalesced per microtask. */
export const REVIEW_CHANGED_EVENT = 'review:changed'
export interface ReviewChangedPayload { baseline_revision: number }
