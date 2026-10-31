/** Prepare a server-side editor restart without cancelling user work. The
 * returned commit runs only after the authenticated HTTP response is flushed. */
export function createServerRestart(deps: {
  busy: () => boolean;
  hold: () => () => void;
  saveResume: () => void;
  clearResume: () => void;
  flushSettings: () => void;
  writeIntent: () => void;
  clearIntent: () => void;
  shutdown: () => Promise<void>;
  quit: () => void;
}) {
  let pending: Promise<() => void> | undefined;
  return () => {
    if (pending) return pending;
    if (deps.busy()) return Promise.reject(Object.assign(new Error('Editor work is active'), { code: 'editor_busy' }));
    let release: () => void;
    try { release = deps.hold(); }
    catch (error) { return Promise.reject(error); }
    pending = (async () => {
      try {
        deps.saveResume();
        deps.flushSettings();
        // Write before close: a failure to prepare the supervisor handoff must
        // not leave the editor closed without a replacement.
        deps.writeIntent();
        await deps.shutdown();
        return deps.quit;
      } catch (error) {
        try { deps.clearIntent(); } catch { /* retain the original error */ }
        try { deps.clearResume(); } catch { /* retain the original error */ }
        release();
        pending = undefined;
        throw error;
      }
    })();
    // A synchronous write failure can reject before the assignment completes.
    void pending.catch(() => { pending = undefined; });
    return pending;
  };
}
