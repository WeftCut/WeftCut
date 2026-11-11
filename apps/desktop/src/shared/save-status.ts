// apps/desktop/src/shared/save-status.ts
//
// Whether the open project is reaching disk, as the user is told (docs/data-model.md
// § Saving). Main owns the state (main/state/autosave.ts decides it,
// ts-actor-host.ts publishes it); the renderer pulls it on mount and takes every
// change pushed after, like the other main-owned mirrors.

/** `settings.autosave_interval_secs` bounds how long edits may stay unsaved while
 *  they keep arriving faster than the quiet window (a long agent run), and how
 *  long saving may keep failing before the user is told. Internal: not exposed
 *  in the UI or MCP. A missing or invalid value falls back to the default; the
 *  clamp keeps a hand-edited project.json from disabling the bound or turning
 *  every edit into a write (`autosaveMaxWaitMs`). */
export const AUTOSAVE_INTERVAL_DEFAULT_SECS = 60
export const AUTOSAVE_INTERVAL_MIN_SECS = 5
export const AUTOSAVE_INTERVAL_MAX_SECS = 300

/** Main → renderer push of every change; payload `SaveStatus`. */
export const SAVE_STATUS_EVENT = 'project:save-status'
/** `backend:invoke` pull of the current `SaveStatus`, for a renderer that
 *  mounts (or reloads) after the last push. */
export const SAVE_STATUS_CHANNEL = 'project_save_status'

/** `failing`: edits have been unsaved for at least the autosave interval and the
 *  latest write of project.json failed. Anything short of that is `ok`, a
 *  failure a later cycle fixes in time included. `revision` only grows, so a
 *  late pull cannot overwrite a newer push. */
export type SaveStatus =
  | { state: 'ok'; revision: number }
  | {
    state: 'failing'
    revision: number
    /** ISO time of the first edit not on disk. */
    since: string
    /** ISO time of this project's last successful write in this session. */
    last_saved_at: string | null
    /** The failed write's errno code (`ENOSPC`, `EACCES` …); null when the
     *  failure carried none. */
    code: string | null
    /** The project.json that could not be written, and its folder. */
    path: string
    dir: string
  }
