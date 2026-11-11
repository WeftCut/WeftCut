// apps/desktop/src/main/state/poolFiles.ts
//
// What the disk holds for each pool item: whether its source still holds the
// bytes it records (ADR 0153), and whether the derivative files its decode
// route and conform slot name are there. Owns the cache of those facts; the
// summary reads them and never the disk. Readers of a source's bytes settle
// it here first.
//
// An item's files are read when it is first seen and again whenever the item
// is a different object in the model: every app write to a pool item (a job's
// write-back, an import, a relink, a confirmed mtime) replaces it, so an edit
// that leaves the pool alone reads nothing. What changes outside the app is
// read again by `refresh` (window focus) and `recheck` (a failed job).
import type { MediaItem } from './model'

export type SourceState = 'present' | 'missing' | 'changed'

/** A regular file's size and whole-second mtime (native `stat_file`'s units). */
export interface FileStat { size: number; mtimeSecs: number }

/** One pool item's files as last read. A derivative flag is false for an
 *  empty slot. */
export interface MediaFiles {
  source: SourceState
  quick_proxy: boolean
  full_proxy: boolean
  conform: boolean
}

export interface PoolFilesFs {
  /** null when no regular file is readable there. */
  stat(path: string): FileStat | null
  /** The same off the main thread; never rejects. */
  statAsync(path: string): Promise<FileStat | null>
}

export interface PoolFilesDeps extends PoolFilesFs {
  /** BLAKE3 hex of a file's contents. */
  hash(path: string): Promise<string>
  /** The bytes were read and are the item's: record the mtime they now have,
   *  so the screen passes again without reading them. */
  confirmed(item: MediaItem, mtimeSecs: number): void
  /** A fact already handed out is no longer true: what was published from it
   *  is stale. A fresh `read` calls it before returning. */
  changed(): void
}

export interface PoolFiles {
  /** Every item's files, as a lookup that touches no disk. Reads the files of
   *  items not seen before, or changed in the model since; `fresh` reads them
   *  all again, for a reader about to use them (export). An item outside
   *  `pool` reads as missing. */
  read(pool: Record<string, MediaItem>, fresh?: boolean): (item: MediaItem) => MediaFiles
  /** What the item's source is now, from a fresh stat, waiting for the read of
   *  its bytes when only the mtime differs: what a reader of the bytes asks. */
  settle(item: MediaItem): Promise<SourceState>
  /** Read one item's files again now. */
  recheck(mediaId: string): void
  /** Read every known item's files again off the main thread; one run at a
   *  time, and a call during a run queues one more. */
  refresh(): Promise<void>
  /** Forget every item: the next read is a first sight. */
  clear(): void
}

/** What was read for one item object. Replaced, never mutated: a refresh
 *  applies its result only to the entry it read for. */
interface Entry {
  item: MediaItem
  source: FileStat | null
  quick_proxy: boolean
  full_proxy: boolean
  conform: boolean
}

const NOT_READ: MediaFiles = { source: 'missing', quick_proxy: false, full_proxy: false, conform: false }

/** The derivative paths the item names, by slot. */
function slots(item: MediaItem): { quick_proxy: string | null; full_proxy: string | null; conform: string | null } {
  const r = item.decode_route
  return {
    quick_proxy: r.route === 'bypass' ? null : r.quick_proxy,
    full_proxy: r.route === 'proxied' || r.route === 'native-sw' ? r.full_proxy : null,
    conform: item.conform_path,
  }
}

function sameStat(a: FileStat | null, b: FileStat | null): boolean {
  return a === null || b === null ? a === b : a.size === b.size && a.mtimeSecs === b.mtimeSecs
}

function sameFacts(a: Entry, b: Entry): boolean {
  return sameStat(a.source, b.source) && a.quick_proxy === b.quick_proxy && a.full_proxy === b.full_proxy && a.conform === b.conform
}

export function createPoolFiles(deps: PoolFilesDeps): PoolFiles {
  const entries = new Map<string, Entry>()
  // Settled reads, by the item's record and the file's stat at the read: a
  // file that changes again, or an item that moves or rehashes, is read again.
  const verdicts = new Map<string, 'present' | 'changed'>()
  const reads = new Map<string, Promise<SourceState>>()
  let queue: Promise<unknown> = Promise.resolve()

  function readEntry(item: MediaItem): Entry {
    const s = slots(item)
    const there = (path: string | null): boolean => path !== null && path !== '' && deps.stat(path) !== null
    return { item, source: deps.stat(item.path_abs), quick_proxy: there(s.quick_proxy), full_proxy: there(s.full_proxy), conform: there(s.conform) }
  }

  async function readEntryAsync(item: MediaItem): Promise<Entry> {
    const s = slots(item)
    const paths = [item.path_abs, s.quick_proxy, s.full_proxy, s.conform]
    const [source, quick, full, conform] = await Promise.all(paths.map((p) => (p ? deps.statAsync(p) : null)))
    return { item, source: source ?? null, quick_proxy: quick != null, full_proxy: full != null, conform: conform != null }
  }

  function screen(item: MediaItem, facts: FileStat | null): { state: SourceState } | { key: string; mtimeSecs: number } {
    if (facts === null) return { state: 'missing' }
    // Still importing: there is no settled hash to hold.
    if (item.file_hash_blake3.startsWith('pending-')) return { state: 'present' }
    if (facts.size !== item.file_size) return { state: 'changed' }
    if (facts.mtimeSecs === item.file_mtime) return { state: 'present' }
    const key = [item.id, item.path_abs, item.file_hash_blake3, facts.size, facts.mtimeSecs].join('\n')
    const verdict = verdicts.get(key)
    return verdict ? { state: verdict } : { key, mtimeSecs: facts.mtimeSecs }
  }

  function readBytes(item: MediaItem, key: string, mtimeSecs: number): Promise<SourceState> {
    const pending = reads.get(key)
    if (pending) return pending
    const run = async (): Promise<SourceState> => {
      let verdict: 'present' | 'changed'
      // A file that cannot be read now is settled by the next stat.
      try { verdict = (await deps.hash(item.path_abs)) === item.file_hash_blake3 ? 'present' : 'changed' }
      catch { return 'missing' }
      verdicts.set(key, verdict)
      // Present was what the screen said meanwhile; the confirmed mtime
      // replaces the item, which republishes on its own.
      if (verdict === 'present') deps.confirmed(item, mtimeSecs)
      else deps.changed()
      return verdict
    }
    const answer = queue.then(run)
    queue = answer.catch(() => {})
    reads.set(key, answer)
    void answer.finally(() => reads.delete(key))
    return answer
  }

  function sourceState(item: MediaItem, facts: FileStat | null): SourceState {
    const s = screen(item, facts)
    if ('state' in s) return s.state
    void readBytes(item, s.key, s.mtimeSecs)
    return 'present'
  }

  async function refreshOnce(): Promise<void> {
    const taken = [...entries.values()]
    // All at once: completions then arrive in batches per loop turn. Capping
    // what is in flight wakes the loop once per stat, which costs the main
    // thread several times the stats themselves.
    const read = await Promise.all(taken.map((e) => readEntryAsync(e.item)))
    let moved = false
    taken.forEach((before, i) => {
      // Re-read synchronously meanwhile (the item changed, a settle, a
      // recheck) or forgotten by a project switch: that read is newer.
      if (entries.get(before.item.id) !== before || sameFacts(before, read[i])) return
      entries.set(before.item.id, read[i])
      moved = true
    })
    if (moved) deps.changed()
  }

  let refreshing: Promise<void> | null = null
  let again = false

  return {
    read(pool, fresh = false) {
      const files = new Map<string, MediaFiles>()
      let moved = false
      for (const item of Object.values(pool)) {
        let e = entries.get(item.id)
        if (e === undefined || e.item !== item || fresh) {
          const next = readEntry(item)
          if (e !== undefined && e.item === item && !sameFacts(e, next)) moved = true
          entries.set(item.id, e = next)
        }
        files.set(item.id, { source: sourceState(item, e.source), quick_proxy: e.quick_proxy, full_proxy: e.full_proxy, conform: e.conform })
      }
      // Only a fresh read can find an item it already handed out changed.
      if (moved) deps.changed()
      return (item) => files.get(item.id) ?? NOT_READ
    },
    async settle(item) {
      const facts = deps.stat(item.path_abs)
      const e = entries.get(item.id)
      if (e !== undefined && e.item === item && !sameStat(e.source, facts)) {
        entries.set(item.id, { ...e, source: facts })
        deps.changed()
      }
      const s = screen(item, facts)
      return 'state' in s ? s.state : readBytes(item, s.key, s.mtimeSecs)
    },
    recheck(mediaId) {
      const e = entries.get(mediaId)
      if (e === undefined) return
      const next = readEntry(e.item)
      if (sameFacts(e, next)) return
      entries.set(mediaId, next)
      deps.changed()
    },
    refresh() {
      if (refreshing) { again = true; return refreshing }
      const run = async (): Promise<void> => {
        try { do { again = false; await refreshOnce() } while (again) }
        finally { refreshing = null }
      }
      return (refreshing = run())
    },
    clear() { entries.clear() },
  }
}
