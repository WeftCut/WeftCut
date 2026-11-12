// apps/desktop/src/main/sessionEnd.ts
//
// What the app settles when the OS ends the session under it: a Windows
// shutdown, restart or sign-out. Owns the order and what a failed step costs;
// index.ts owns the Electron side (the window event, the stores behind `deps`).
// The quit a user asks for is quitSave.ts and the `before-quit` teardown.

export interface SessionEndDeps {
  /** Writes unsaved edits before returning (`TsActorHost.saveNow`); throws when
   *  the write fails. */
  save: () => void
  /** Debounced writes to settle now (workspace layout, window geometry). */
  flush: ReadonlyArray<() => void>
  /** The diagnostics store's calls, which never throw (diagnostics.ts). */
  diagnostics: {
    record: (kind: string, message: string) => void
    /** Marks the session for the next start's report. */
    failure: (kind: string, message: string) => void
    /** Marks the session as ended in order. */
    close: () => void
  }
}

const reasonOf = (error: unknown): string => error instanceof Error ? (error.stack ?? error.message) : String(error)

/** The session's end as the next start will read it: ended in order, and
 *  reported only when edits could not be written.
 *
 *  LANDMINE: nothing here may be awaited. On Windows the session end raises no
 *  `before-quit`, `will-quit` or `quit`, and Electron terminates the process as
 *  the window's `session-end` listeners return, without Node's `exit`. See
 *  docs/notes/electron-chromium-behavior.md § A Windows session end skips every
 *  quit event. */
export function endSession(reasons: readonly string[], deps: SessionEndDeps): void {
  const { diagnostics } = deps
  diagnostics.record('session-end', reasons.join(','))
  try { deps.save() }
  catch (error) { diagnostics.failure('session-end-save', reasonOf(error)) }
  for (const flush of deps.flush) {
    try { flush() }
    catch (error) { diagnostics.record('session-end-flush', reasonOf(error)) }
  }
  diagnostics.close()
}
