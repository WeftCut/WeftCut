// apps/desktop/src/main/state/autosave.ts
//
// Auto-save subscriber + periodic Backups/ snapshots. Per docs/data-model.md the
// workspace is the truth: every actor commit lands on disk as project.json, no
// explicit Save. This module decides *when* to write: after a quiet window, and
// no later than the project's autosave interval under a steady stream of edits.
// Serialization belongs to persistence.ts, the crash-safe replacement to the
// injected `AutosaveFs.writeFile` (atomicWrite.ts in production). Pure +
// injected (fs / clock / timer / workspace-dir) so the cadence and gc are
// deterministic in tests. Wired by ts-actor-host: subscribed at backend
// bring-up; project_save → forceFlush.
import type { ActorHandle, ChangeEvent } from './actor'
import type { Project, ProjectSettings } from './model'
import { PROJECT_FILE } from './persistence'
import { currentEditTrace, measureEditStage, runEditTrace } from '../../shared/editTrace'

/** Quiet window before a write — a 10-event drag coalesces into one. */
const DEBOUNCE_MS = 500
/** `settings.autosave_interval_secs` bounds how long edits may stay unsaved while
 *  they keep arriving faster than the quiet window (a long agent run). Internal:
 *  not exposed in the UI or MCP. A missing or invalid value falls back to the
 *  default; the clamp keeps a hand-edited project.json from disabling the bound
 *  or turning every edit into a write. */
export const AUTOSAVE_INTERVAL_DEFAULT_SECS = 60
export const AUTOSAVE_INTERVAL_MIN_SECS = 5
export const AUTOSAVE_INTERVAL_MAX_SECS = 300
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
}

export interface AutosaveController {
  start(): void
  forceFlush(): Promise<void>
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
    deadline = setTimer(() => flushOnTimer(dueAt), ms)
  }

  /** Timer write: persist, then snapshot if the commit/time threshold passed. */
  function flushOnTimer(dueAt: number): void {
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
    dirty = true
    if (quiet !== null) clearTimer(quiet)
    // A coalesced save belongs to its latest edit; never attribute a later,
    // untraced edit to the previous drag. IDs are session-only, never persisted.
    pendingTraceId = currentEditTrace()?.id
    const dueAt = performance.now() + debounceMs
    quiet = setTimer(() => flushOnTimer(dueAt), debounceMs)
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
        if (dirty && unsubscribe !== null) armDeadline()
        throw error
      }
    },
    stop() {
      pendingTraceId = undefined
      clearTimers()
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
    },
  }
}
