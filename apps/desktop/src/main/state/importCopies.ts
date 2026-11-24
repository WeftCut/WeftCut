// apps/desktop/src/main/state/importCopies.ts
//
// The copies into Media/ the native import queue (native/src/jobs/import.rs)
// still has queued or running, read from its `import:queue` snapshots, and a
// wait for all of them to end. A pack waits on it (ADR 0178).

/** One `import:queue` entry, as far as a wait reads it. */
export interface ImportQueueEntry { media_id: string; status: { kind: string } }

const RUNNING = new Set(['Pending', 'Copying'])

export interface ImportCopies {
  /** An `import:queue` snapshot of the current workspace. */
  observe(entries: readonly ImportQueueEntry[]): void
  /** The workspace changed: its queue is gone, and every wait ends. */
  reset(): void
  /** Resolves once every copy queued when it was called has ended (landed,
   *  failed or cancelled) and its result has been applied to the pool;
   *  rejects with the signal's reason when `signal` aborts first. */
  settled(signal: AbortSignal): Promise<void>
}

/** `list` is the queue's own answer (`import_queue_list`): it holds an
 *  enqueue the snapshots may not have shown yet. */
export function createImportCopies(list: () => Promise<readonly ImportQueueEntry[]>): ImportCopies {
  let seen: readonly ImportQueueEntry[] = []
  let generation = 0
  const waiters = new Set<() => void>()
  const wake = () => { for (const w of [...waiters]) w() }

  return {
    observe(entries) { seen = entries; wake() },
    reset() { seen = []; generation++; wake() },
    async settled(signal) {
      signal.throwIfAborted()
      const start = generation
      const queued = await list()
      signal.throwIfAborted()
      // LANDMINE: the result of a copy (`media:workspace_paths`) reaches the
      // pool through the event channel, and the queue answer above through
      // another, which may overtake it. Only a snapshot from the event
      // channel that has caught up with `queued` (history only grows within a
      // workspace) proves every result before it was applied.
      const done = () => generation !== start
        || (seen.length >= queued.length && !seen.some(e => RUNNING.has(e.status.kind)))
      if (done()) return
      await new Promise<void>((resolve, reject) => {
        const finish = () => { waiters.delete(check); signal.removeEventListener('abort', abort) }
        const check = () => { if (done()) { finish(); resolve() } }
        const abort = () => { finish(); reject(signal.reason) }
        waiters.add(check)
        signal.addEventListener('abort', abort, { once: true })
      })
    },
  }
}
