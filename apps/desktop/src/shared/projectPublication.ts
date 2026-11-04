import type { SnapshotPatch } from './snapshotPatch'

/** Renderer publication identity, scoped to one main-process lifetime.
 * A session changes when the workspace is replaced (even by the same project).
 * Revision advances on every published actor change, including undo and jobs.
 * Neither number is a persisted project version or a history cursor. */
export interface ProjectVersion { session: number; revision: number }

/** A complete, atomically versioned projection. Null means actually closed. */
export interface ProjectPublication<T> { version: ProjectVersion; summary: T | null }

/** What `project_publication` answers. `viewId` names this answer; a later read
 * names it as its base to receive the difference from it instead of the whole
 * projection (ADR 0157). A reader that names no base, or one main no longer
 * remembers, receives the whole projection. */
export type ProjectPublicationReply<T> =
  | (ProjectPublication<T> & { viewId: number })
  | { version: ProjectVersion; viewId: number; base: number; patches: SnapshotPatch[] }

/** The argument naming the answer a reader holds. */
export const PUBLICATION_BASE_ARG = 'base'

/** Existing command value plus a view barrier. A receipt may include concurrent
 * commits completed while an async operation ran; it never claims persistence. */
export interface PublishedResult<T> { value: T; publication: ProjectVersion | null }
