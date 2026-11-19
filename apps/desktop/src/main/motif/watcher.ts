// Motif file watches. The library root: a recursive fs.watch whose changes,
// external-editor saves included, coalesce through a quiet-window debounce
// into ONE onChange call; the caller (index.ts) refreshes the actor catalog and
// emits motifs:changed, and the renderer resync does the rest, so there is no
// per-file dispatch and no filtering of the app's own writes, bar the trust
// record kept beside the library (`spawnMotifWatcher`). The open
// project's `Motifs/`: a recursive watch that tells which Motif changed and
// what its folder now holds (`watchProjectMotifs`). The debounce is
// unit-tested independently of the OS watch.
import { existsSync, mkdirSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { MotifState, ProjectMotifStore } from './projectStore'
import { TRUST_FILES } from './trust'

/** Quiet window (ms): after a change, wait until this long passes with no
 *  further event, then fire once. Absorbs editor write bursts + multi-file writes. */
export const DEBOUNCE_QUIET_MS = 400

/** Coalesce raw watch events into one onChange after a quiet window. Split from
 *  spawnMotifWatcher so the debounce is testable with fake timers (no OS watch). */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly quietMs: number, private readonly onChange: () => void) {}
  /** Signal a raw change; resets the quiet window. */
  signal(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.onChange() }, this.quietMs)
  }
  /** Cancel any pending fire (used on close). */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}

export interface MotifWatcher { close(): void }

/** The canonical long-name spelling of `dir`, the one to watch.
 *  Windows reports events under the long name, and libuv (1.52+, so Node
 *  24.20+ and Electron 44+) asserts that every reported path starts with the
 *  directory it was handed: an 8.3 short-name root (`C:\Users\RUNNER~1\...`,
 *  which is what os.tmpdir() yields on GitHub's Windows runners) fails that
 *  check — an assert-abort of the whole process on Node builds, mangled
 *  relative paths on Electron's assert-free build. realpathSync.native is the
 *  one fs API that returns the long name. */
function canonicalDir(dir: string): string {
  try { return realpathSync.native(dir) } catch { return dir }
}

/** Attach a recursive watcher at `root` (created if missing — a first boot has
 *  no user Motifs yet, but the watcher must still attach) and fire `onChange`
 *  once per debounced burst. Errors are forwarded as change signals too: a
 *  watch error means "something may have changed that we missed" — a spurious
 *  resync is harmless, a missed one isn't. The trust record's files
 *  (`TRUST_FILES`) are no library change: every trust given writes them, and
 *  each change re-reads every library revision. */
export function spawnMotifWatcher(root: string, onChange: () => void): MotifWatcher {
  mkdirSync(root, { recursive: true })
  const deb = new Debouncer(DEBOUNCE_QUIET_MS, onChange)
  const watcher = watch(canonicalDir(root), { recursive: true })
  watcher.on('change', (_event, name) => {
    if (name === null || !TRUST_FILES.includes(String(name))) deb.signal()
  })
  watcher.on('error', () => deb.signal())
  return { close() { deb.cancel(); watcher.close() } }
}

/** Hears a project Motif whose folder changed, with what it now holds. */
export type ProjectMotifListener = (id: string, state: MotifState) => void

export interface ProjectMotifWatcher extends MotifWatcher {
  /** Forgets the state last told of `id`: its next change is told even when
   *  it ends in that same state, for a listener that could not act on it or
   *  has since changed the folder itself. */
  forget(id: string): void
}

/** Watches `<project>/Motifs/` recursively and, once per quiet window, tells
 *  `onChanged` of each Motif whose folder an event touched, its state
 *  observed through `project` (`ProjectMotifStore.observe`, which judges a
 *  new revision as an edit made while the project is open). A Motif is told
 *  again only when its state differs from the last one told. A project without
 *  `Motifs/` is watched for the folder to appear; a Motif written before the
 *  watch attached is told then. The app's own writes are told like any other:
 *  the listener compares against what it recorded. */
export function watchProjectMotifs(project: ProjectMotifStore, onChanged: ProjectMotifListener): ProjectMotifWatcher {
  const root = project.root()
  const pending = new Set<string>()
  const told = new Map<string, string>()
  const deb = new Debouncer(DEBOUNCE_QUIET_MS, () => {
    const ids = [...pending]
    pending.clear()
    // A file beside the folders is no Motif.
    const folders = new Set(project.ids())
    for (const id of ids) {
      if (!folders.has(id) && !told.has(id)) continue
      const state = project.observe(id)
      const seen = JSON.stringify([state.status, state.revision, state.diagnostic])
      if (told.get(id) === seen) continue
      told.set(id, seen)
      onChanged(id, state)
    }
  })
  /** Every Motif there is or was told of. */
  const everyId = () => {
    for (const id of [...project.ids(), ...told.keys()]) pending.add(id)
    deb.signal()
  }
  const touched = (name: string | Buffer | null) => {
    if (name === null) return everyId()
    // The first segment names the Motif; dot-names are the store's staging.
    const id = String(name).split(/[\\/]/)[0]!
    if (!id || id.startsWith('.')) return
    pending.add(id)
    deb.signal()
  }
  let tree: FSWatcher | null = null
  let closed = false
  const detach = () => { tree?.close(); tree = null }
  const attach = (late: boolean) => {
    // LANDMINE: checked, not left to `watch` to throw: Node 24.20's recursive
    // watch on Linux takes a missing folder without an error and never
    // reports, which would hold `tree` and keep the folder's arrival unheard.
    if (tree || closed || !existsSync(root)) return
    try { tree = watch(canonicalDir(root), { recursive: true }) } catch { return }
    tree.on('change', (_event, name) => touched(name))
    tree.on('error', () => { detach(); attach(true) })
    if (late) everyId()
  }
  // `Motifs/` appearing, or going with every Motif in it. Some systems also
  // report the folder here when its contents change: those leave the tree as
  // it is.
  let parent: FSWatcher | null = null
  try {
    parent = watch(canonicalDir(path.dirname(root)), (_event, name) => {
      if (name !== null && String(name) !== path.basename(root)) return
      const present = existsSync(root)
      if (tree && present) return
      if (tree) { detach(); everyId() }
      else if (present) attach(true)
    })
    parent.on('error', () => { parent?.close(); parent = null })
  } catch { /* the project folder is gone */ }
  attach(false)
  return {
    forget(id) { told.delete(id) },
    close() {
      closed = true
      deb.cancel()
      detach()
      parent?.close()
    },
  }
}
