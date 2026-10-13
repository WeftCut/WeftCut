// apps/desktop/src/shared/review.ts
//
// Wire types of agent review (spec `.scratch/agent-review/spec.md` Part B;
// ADR 0115): the entity-level changes between the Review baseline and the
// current project, and the IPC view the renderer reads. Main computes them
// (main/state/reviewDiff.ts, History's baseline); the renderer only displays.

export type EntityKind = 'Composition' | 'Track' | 'Layer' | 'Marker' | 'Transition' | 'Link'
/** `Layer:<id>`, `Marker:<id>` … — stable across snapshots, unique project-wide. */
export type EntityKey = `${EntityKind}:${string}`

export type ChangeClass = 'added' | 'removed' | 'modified' | 'moved' | 'shifted'
export type ChangeAspect = 'placement' | 'timing' | 'retime' | 'params' | 'effects' | 'keyframes' | 'label' | 'flags'
export interface TimeRange { composition_id: string; t_start_us: number; t_end_us: number }
export interface EntityLocation { composition_id: string; track_id: string | null }

export interface Change {
  /** Stable for the same difference: the entity key, or `Shift:<composition>:<delta>`. */
  id: string
  class: ChangeClass
  /** The entity kind; a shift group mixing layers and markers reports `Layer`. */
  kind: EntityKind
  /** Every entity the change covers — approved as one unit. */
  keys: EntityKey[]
  /** What differs. Empty for added/removed/shifted; `moved` always carries
   *  `placement` plus whatever else changed with the move. */
  aspects: ChangeAspect[]
  /** The composition the change is listed under (current side, else baseline);
   *  null for a Composition entity. */
  composition_id: string | null
  /** Every composition the change lives in, either side. */
  composition_ids: string[]
  /** `moved`: baseline and current location. `removed`: `from` alone, the
   *  baseline location (where the editor timeline ghosts a removed layer). */
  from?: EntityLocation
  to?: EntityLocation
  /** `shifted` only: the translation, current − baseline. */
  delta_us?: number
  /** Union of baseline and current footprints, merged per composition; empty
   *  for listed-only changes (link, track, composition). */
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

/** What the review surfaces read (`review_view`). */
export interface ReviewView {
  /** The project publication this view was computed against (ADR 0114) plus
   *  the baseline revision — together the view's identity. `baseline_revision`
   *  increases on every baseline change (initialize, re-pin, approval,
   *  attribution, reset); it never goes back, not even across a project open. */
  version: { session: number; revision: number; baseline_revision: number }
  /** False until the first work session begins or an agent first edits. */
  has_baseline: boolean
  /** Differences an Agent-sourced commit touched since the baseline. */
  unreviewed: Change[]
  /** Differences only the user caused; hidden by default, never need approval. */
  user: Change[]
  /** Group layers containing changes of EITHER list; filter by `change_ids`
   *  against the list on screen. */
  decorations: GroupDecoration[]
}

/** `review_approve` arguments: change ids from the current view, and/or entity
 *  keys. A key approves the whole change that holds it (a shift group approves
 *  as a unit). Unknown ids/keys are ignored — the view may be stale. */
export interface ReviewApproveArgs { change_ids?: string[]; keys?: EntityKey[] }

/** Main → renderer: the baseline changed (approval, attribution, re-pin,
 *  reset). Project edits arrive as `project:changed`; a review surface
 *  refetches `review_view` on either. Coalesced per microtask. */
export const REVIEW_CHANGED_EVENT = 'review:changed'
export interface ReviewChangedPayload { baseline_revision: number }
