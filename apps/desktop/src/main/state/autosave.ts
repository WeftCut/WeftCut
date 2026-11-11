// apps/desktop/src/main/state/autosave.ts
//
// Auto-save subscriber + periodic Backups/ snapshots. Per docs/data-model.md the
// workspace is the truth: every actor commit lands on disk as project.json, no
// explicit Save. This module decides *when* to write: after a quiet window, and
// no later than the project's autosave interval under a steady stream of edits,
// and when a failing write has gone on long enough to tell the user
// (`onSaveState`; shared/save-status.ts).
// Serialization belongs to persistence.ts, the crash-safe replacement to the
// injected `AutosaveFs.writeFile` (atomicWrite.ts in production). Pure +
// injected (fs / clock / timer / workspace-dir) so the cadence and gc are
// deterministic in tests. Wired by ts-actor-host: subscribed at backend
// bring-up; project_save → forceFlush.
import type { ActorHandle, ChangeEvent } from './actor'
import type { Project, ProjectSettings } from './model'
import { PROJECT_FILE } from './persistence'
import { currentEditTrace, measureEditStage, runEditTrace } from '../../shared/editTrace'
import { AUTOSAVE_INTERVAL_DEFAULT_SECS, AUTOSAVE_INTERVAL_MAX_SECS, AUTOSAVE_INTERVAL_MIN_SECS } from '../../shared/save-status'

/** Quiet window before a write — a 10-event drag coalesces into one. */
const DEBOUNCE_MS = 500
/** Snapshot cadence: a copy to Backups/ once either threshold trips. */
const SNAPSHOT_EVERY_COMMITS = 50
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000
/** Backups/ beyond this many newest files are gc'd after each snapshot. */
const RETAIN_SNAPSHOTS = 20
export const BACKUPS_DIR = 'Backups'

export interface AutosaveFs {
  /** Replaces the file whole: on failure it throws and the previous file stays
   *  (atomicWrite.ts in production). */
  writeFile(path: string, text: string): void
  exists(path: string): boolean
  copyFile(src: string, dest: string): void
  mkdirp(dir: string): void
  readdir(dir: string): string[]
  rm(path: string): void
}

export interface AutosaveDeps {
  actor: Pick<ActorHandle, 'subscribe' | 'snapshot'>
  fs: AutosaveFs
  /** workspace.current() — null in the blank-boot window before Save As / Open. */
  workspaceDir: () => string | null
  join: (...parts: string[]) => string
  /** serializeProjectToJson (persistence.ts) — injected to keep this module pure. */
  serialize: (p: Project) => string
  now?: () => Date
  debounceMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
  /** Called when the save state changes, never twice with the same state. */
  onSaveState?: (state: AutosaveSaveState) => void
}

/** `failing`: edits have been unsaved for at least the autosave interval and the
 *  latest write failed. `ok` follows a failing state only: `saved` when a write
 *  of this project succeeded, `reset` when `beginProject` withdrew it. */
export type AutosaveSaveState =
  | { kind: 'ok'; cause: 'saved' | 'reset' }
  | { kind: 'failing'; since: Date; lastSavedAt: Date | null; code: string | null; path: string; dir: string }

export interface AutosaveController {
  start(): void
  forceFlush(): Promise<void>
  /** Edits not on disk yet. */
  unsaved(): boolean
  /** The workspace now holds another project (or none): its unsaved age and
   *  last save start over, and a failing state reported for the previous one is
   *  withdrawn. */
  beginProject(): void
  stop(): void
}

/** The longest edits may stay unsaved under continuous editing, in ms. */
export function autosaveMaxWaitMs(settings: Pick<ProjectSettings, 'autosave_interval_secs'>): number {
  const secs = settings.autosave_interval_secs
  if (typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0) return AUTOSAVE_INTERVAL_DEFAULT_SECS * 1000
  return Math.min(AUTOSAVE_INTERVAL_MAX_SECS, Math.max(AUTOSAVE_INTERVAL_MIN_SECS, secs)) * 1000
}

export function createAutosave(deps: AutosaveDeps): AutosaveController {
  const now = deps.now ?? (() => new Date())
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))

  let unsubscribe: (() => void) | null = null
  /** Restarted by every edit. */
  let quiet: ReturnType<typeof setTimeout> | null = null
  /** Armed by the first unsaved edit and never restarted by later ones, so a
   *  stream of edits cannot postpone the write past the autosave interval. */
  let deadline: ReturnType<typeof setTimeout> | null = null
  /** Edits not yet on disk. A failed write leaves it set. */
  let dirty = false
  /** When `dirty` was last set from clean: the age the failing state is judged by. */
  let dirtySince: Date | null = null
  let lastSavedAt: Date | null = null
  let reported: AutosaveSaveState = { kind: 'ok', cause: 'saved' }
  let commitsSinceSnapshot = 0
  let lastSnapshotAtMs = now().getTime()
  let pendingTraceId: string | undefined

  /** ISO-8601, no colons/dashes/dots — sorts lexicographically == chronologically
   *  (Windows-filename-safe). */
  function stamp(): string {
    return now().toISOString().replace(/[-:.]/g, '')
  }

  function persist(ws: string): void {
    const json = measureEditStage('serialize', () => deps.serialize(deps.actor.snapshot()))
    currentEditTrace()?.fact('jsonChars', json.length)
    measureEditStage('write_file', () => deps.fs.writeFile(deps.join(ws, PROJECT_FILE), json))
    dirty = false
    dirtySince = null
    lastSavedAt = now()
    if (reported.kind === 'failing') report({ kind: 'ok', cause: 'saved' })
  }

  function report(state: AutosaveSaveState): void {
    reported = state
    deps.onSaveState?.(state)
  }

  /** A write of project.json failed. It is reported only once the edits have
   *  waited the autosave interval: a failure a later cycle fixes in time says
   *  nothing. The deadline always attempts a write at the interval, so judging
   *  at each failed attempt is enough. `atDeadline`: this attempt IS that
   *  deadline, which was armed no earlier than `dirtySince` — trusted over the
   *  wall clock, which may read a millisecond short of the timer. */
  function writeFailed(error: unknown, atDeadline: boolean): void {
    const ws = deps.workspaceDir()
    if (ws === null || !dirty || dirtySince === null) return
    const overdue = atDeadline
      || now().getTime() - dirtySince.getTime() >= autosaveMaxWaitMs(deps.actor.snapshot().settings)
    if (!overdue) return
    const code = (error as NodeJS.ErrnoException | null)?.code
    const next: AutosaveSaveState = {
      kind: 'failing', since: dirtySince, lastSavedAt, code: typeof code === 'string' ? code : null,
      path: deps.join(ws, PROJECT_FILE), dir: ws,
    }
    if (reported.kind === 'failing' && reported.code === next.code && reported.path === next.path
      && reported.since === next.since && reported.lastSavedAt === next.lastSavedAt) return
    report(next)
  }

  function takeSnapshot(ws: string): void {
    const src = deps.join(ws, PROJECT_FILE)
    if (!deps.fs.exists(src)) return // defensive: nothing to copy yet
    const backups = deps.join(ws, BACKUPS_DIR)
    try {
      deps.fs.mkdirp(backups)
      deps.fs.copyFile(src, deps.join(backups, `${stamp()}.json`))
      gcSnapshots(backups)
    } catch { /* best-effort; a setTimeout-callback throw would be an unhandled rejection */ }
  }

  function gcSnapshots(backups: string): void {
    const names = deps.fs.readdir(backups).filter((n) => n.endsWith('.json'))
    names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // descending: newest (largest) first
    for (const stale of names.slice(RETAIN_SNAPSHOTS)) {
      try { deps.fs.rm(deps.join(backups, stale)) } catch { /* logged-only in prod; ignore */ }
    }
  }

  function clearTimers(): void {
    if (quiet !== null) { clearTimer(quiet); quiet = null }
    if (deadline !== null) { clearTimer(deadline); deadline = null }
  }

  /** The interval is read when the window opens, so an edit that changes the
   *  setting applies from the next unsaved edit on. */
  function armDeadline(): void {
    const ms = autosaveMaxWaitMs(deps.actor.snapshot().settings)
    const dueAt = performance.now() + ms
    deadline = setTimer(() => flushOnTimer(dueAt, true), ms)
  }

  /** Timer write: persist, then snapshot if the commit/time threshold passed. */
  function flushOnTimer(dueAt: number, atDeadline: boolean): void {
    clearTimers()
    const traceId = pendingTraceId
    pendingTraceId = undefined
    try {
      runEditTrace(traceId, 'main.autosave', () => {
        if (traceId) currentEditTrace()?.fact('timerLateMs', Math.max(0, performance.now() - dueAt))
        flushOnTimerInner()
      })
    } catch (error) {
      // Thrown out of a timer callback this would be an uncaught exception in
      // main (a modal error box on Windows). The edits stay dirty; the next edit
      // or the re-armed deadline retries.
      console.warn('[autosave] project.json was not written; will retry', error)
      writeFailed(error, atDeadline)
      if (dirty && unsubscribe !== null) armDeadline()
    }
  }

  function flushOnTimerInner(): void {
    const ws = deps.workspaceDir()
    if (ws === null) return // no workspace yet — edits stay dirty for the next cycle
    persist(ws)
    // One per timer write (a flurry coalesced into one write), NOT per raw
    // actor commit.
    commitsSinceSnapshot += 1
    if (commitsSinceSnapshot >= SNAPSHOT_EVERY_COMMITS || now().getTime() - lastSnapshotAtMs >= SNAPSHOT_EVERY_MS) {
      measureEditStage('backup_and_gc', () => takeSnapshot(ws))
      commitsSinceSnapshot = 0
      lastSnapshotAtMs = now().getTime()
    }
  }

  function onChange(_e: ChangeEvent): void {
    if (!dirty) dirtySince = now()
    dirty = true
    if (quiet !== null) clearTimer(quiet)
    // A coalesced save belongs to its latest edit; never attribute a later,
    // untraced edit to the previous drag. IDs are session-only, never persisted.
    pendingTraceId = currentEditTrace()?.id
    const dueAt = performance.now() + debounceMs
    quiet = setTimer(() => flushOnTimer(dueAt, false), debounceMs)
    if (deadline === null) armDeadline()
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = deps.actor.subscribe(onChange)
    },
    /** Flush + snapshot right now, skipping both timers (Cmd-S / project switch /
     *  quit gate). The force path always snapshots and resets the counters. A
     *  failed write rejects to the caller and leaves the edits dirty for a later
     *  cycle. */
    async forceFlush(): Promise<void> {
      clearTimers()
      const traceId = pendingTraceId
      pendingTraceId = undefined
      try {
        runEditTrace(traceId, 'main.force_save', () => {
          const ws = deps.workspaceDir()
          if (ws === null) return
          persist(ws)
          measureEditStage('backup_and_gc', () => takeSnapshot(ws))
          commitsSinceSnapshot = 0
          lastSnapshotAtMs = now().getTime()
        })
      } catch (error) {
        writeFailed(error, false)
        if (dirty && unsubscribe !== null) armDeadline()
        throw error
      }
    },
    unsaved: () => dirty,
    beginProject() {
      dirtySince = dirty ? now() : null
      lastSavedAt = null
      // `writeFailed` trusts a deadline to have been armed no earlier than
      // `dirtySince`; one armed for the previous project would not be.
      if (deadline !== null) { clearTimer(deadline); deadline = null; armDeadline() }
      if (reported.kind === 'failing') report({ kind: 'ok', cause: 'reset' })
    },
    stop() {
      pendingTraceId = undefined
      clearTimers()
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
    },
  }
}
