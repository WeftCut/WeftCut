// apps/desktop/src/shared/review.ts
//
// Wire types of agent review (spec `.scratch/agent-review/spec.md` Part B;
// ADR 0115): the entity-level changes between the Review baseline and the
// current project, and the IPC view the renderer reads. Main computes them
// (main/state/reviewDiff.ts, History's baseline); the renderer only displays.

export type EntityKind = 'Composition' | 'Track' | 'Layer' | 'Marker' | 'Transition' | 'Link'
/** `Layer:<id>`, `Marker:<id>` … — stable across snapshots, unique project-wide. */
export type EntityKey = `${EntityKind}:${string}`

/** The key of entity `id` of `kind`. */
export function entityKey(kind: EntityKind, id: string): EntityKey { return `${kind}:${id}` }

/** The kind and id an entity key names; the id may itself hold colons. */
export function parseEntityKey(key: EntityKey): { kind: EntityKind; id: string } {
  const at = key.indexOf(':')
  return { kind: key.slice(0, at) as EntityKind, id: key.slice(at + 1) }
}

/** Net structural differences, without operation or causal inference. */
export type ChangeClass = 'added' | 'removed' | 'modified'
export type ChangeAspect = 'placement' | 'timing' | 'retime' | 'params' | 'effects' | 'keyframes' | 'label' | 'flags'
export interface TimeRange { composition_id: string; t_start_us: number; t_end_us: number }
/** A range on one track (`track_id` null for a marker or transition). */
export interface PlacedRange extends TimeRange { track_id: string | null }

/** What a change did, as facts rather than words (ADR 0115): main derives them
 *  from the two snapshots; the renderer words them (`changes.detail.*`) in the
 *  editor's own vocabulary — the inspector's param names, the effect catalog's
 *  names — never an MCP tool's. Durations are timeline microseconds. */
export type ChangeDetail =
  /** Added or removed: the entity's length (a removed one's, as it was). */
  | { type: 'length'; duration_us: number }
  /** Direct values in each side's composition or source clock. */
  | { type: 'time'; field: 'start' | 'end' | 'source_start' | 'source_end'; from_us: number; to_us: number }
  /** This layer's window edge changed: negative removes, positive extends.
   *  Measured in timeline microseconds; never describes another entity. */
  | { type: 'trim'; side: 'start' | 'end'; delta_us: number }
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
  /** The entity's key (`Layer:<id>`…): stable across snapshots, independent of
   *  displacement and surrounding content. Each change describes exactly one
   *  entity, never expanded to related entities. */
  id: EntityKey
  class: ChangeClass
  /** The composition the change is listed under (current side, else baseline);
   *  null for a Composition entity. */
  composition_id: string | null
  /** Measured changes to this entity, without an inferred cause. Empty for
   *  added/removed except a length; every compared difference has one. */
  details: ChangeDetail[]
  /** A removed entity's own name in the baseline (label, media or text name);
   *  absent when it had none. The current project cannot name it any more. */
  before_name?: string
  /** Historical footprints in the comparison baseline. Never current coordinates. */
  before_ranges?: PlacedRange[]
  /** Current footprints by entity identity. Removed entities have none. */
  ranges: PlacedRange[]
}

/** The kind of entity a change describes. */
export function changeKind(change: Pick<Change, 'id'>): EntityKind {
  return parseEntityKey(change.id).kind
}

/** A Group layer that shows a composition containing changes ("contains
 *  changes"), at the Group layer's own footprint in its composition. Only
 *  changes with a place on that composition's timeline count — a layer,
 *  marker or transition; a track or link inside has none (a new Group's own
 *  tracks would otherwise count as changes in it). */
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
 *  (the Changes tab's "show my changes"); its count always is.
 *  `held_content`: the `content_revision` of the view the caller holds, read
 *  with the same `include_user` — when the lists are still those, the answer
 *  is a `ReviewViewUnchanged` instead of the lists again. */
export interface ReviewViewArgs { include_user?: boolean; held_content?: number }

/** What the review surfaces read (`review_view`). */
export interface ReviewView {
  version: ReviewVersion
  /** Moves whenever what this view lists does — the unreviewed list, the
   *  decorations, the user-only list when asked for — and only then; within
   *  one session (`version.session`) and one `include_user`, equal means the
   *  same lists. */
  content_revision: number
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

/** A `review_view` answer to a caller that holds the current lists
 *  (`held_content`): the fresh version and counts, nothing to rebuild. A
 *  commit that touched nothing reviewed — the common one — costs the
 *  renderer no list and no highlight. */
export interface ReviewViewUnchanged {
  unchanged: true
  version: ReviewVersion
  content_revision: number
  has_baseline: boolean
  user_count: number
}

/** `review_approve_all` / `review_revert_all` arguments. `version` is the
 *  view the user acted on: main acts only while it is still the current one,
 *  so a commit landing between what the user saw and their click is never
 *  approved or reverted unseen. */
export interface ReviewActionArgs extends ReviewViewArgs { version: ReviewVersion }

/** What a review action answers: whether it was applied — false when
 *  `version` is no longer the current view, and then nothing happened — and
 *  the fresh view either way. */
export interface ReviewActionResult { applied: boolean; view: ReviewView }

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
