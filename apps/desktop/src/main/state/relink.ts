// apps/desktop/src/main/state/relink.ts
//
// Load-time relink-by-content: heal workspace-managed media whose on-disk file
// went missing because its NAME changed while the BYTES survived — the classic
// cross-machine transfer mangle (zip tools decoding UTF-8 names via the local
// ANSI codepage, NFD/NFC drift on macOS-origin names), or an upgrade that gave
// a recorded path a portable name the file does not have yet. The media pool is
// content-addressed (blake3 + size + mtime, media.rs) precisely for this: files
// anywhere under <workspace>/Media are prefiltered by exact size (one stat, no
// read) and confirmed by blake3 before rebinding, so a heal can never bind the
// wrong file. Runs between loadProjectFromJson and replaceState — a pure value
// repair, never a history entry.
import type { MediaItem, Project } from './model'
import { foldCase, isPortableSegment, MEDIA, projectPathOf, type ProjectPath } from '../../shared/projectPath'
import { toNative, type PathPlatform } from './projectPathNative'

/** One regular file found under a folder. */
export interface WalkedFile {
  /** Its names below the walked folder, outermost first. */
  segments: string[]
  abs: string
  size: number
}

export interface RelinkFs {
  exists(path: string): boolean
  /** Every regular file under `dir` at any depth, leaving out symlinks,
   *  dot-files and `*.tmp` (a copy still being written); [] when `dir` is
   *  missing or unreadable. */
  walk(dir: string): WalkedFile[]
  /** null when missing or not a regular file. */
  statFile(path: string): { size: number; mtimeSecs: number } | null
  /** Moves `from` to `to`, creating `to`'s folder first. Throws on failure
   *  (target locked, cross-device) — relink then adopts the found name instead. */
  rename(from: string, to: string): void
}

export interface RelinkDeps {
  fs: RelinkFs
  /** BLAKE3 hex of a file's contents (Backend.hashMediaSource over napi). */
  hashFile: (path: string) => Promise<string>
  /** Whose path rules and case sensitivity apply. Absent: this process's. */
  platform?: PathPlatform
}

export interface RelinkReport {
  /** `from` = where the stray file was found, `/`-separated (its names need
   *  not be portable); `to` = the final path_rel bound. */
  healed: { media: string; from: string; to: string }[]
  /** Media ids left unresolved — the MissingMedia surfaces take over. */
  missing: string[]
}

/** A file under Media/ that may hold a missing item's bytes. */
interface Candidate extends WalkedFile {
  /** Its project path, or null when a name in it is not valid on every OS:
   *  such a file can be renamed to a recorded path, never adopted as found. */
  path: ProjectPath | null
}

/** Heal missing workspace-managed media (path_rel set) by content identity.
 *  External sources (path_rel === null) are out of scope: their bytes were
 *  never copied under the workspace, so there is no bounded place to scan.
 *  Preferred outcome: rename the stray file back to the recorded path
 *  (restores the human-readable name and makes the heal durable without a
 *  save); when that path is taken or the rename fails, the item adopts the
 *  found path instead, provided every name in it is portable. */
export async function relinkMissingMedia(
  project: Project,
  dir: string,
  deps: RelinkDeps,
): Promise<{ project: Project; report: RelinkReport }> {
  const { fs, hashFile } = deps
  const platform = deps.platform ?? process.platform
  const native = (p: ProjectPath) => toNative(dir, p, platform)
  const report: RelinkReport = { healed: [], missing: [] }

  const entries = Object.entries(project.media_pool)
  const missingIds = entries
    .filter(([, item]) => item.path_rel !== null && !fs.exists(native(item.path_rel)))
    .map(([id]) => id)
  if (missingIds.length === 0) return { project, report }

  // Windows and macOS volumes are case-insensitive by default: there two
  // spellings that fold alike name one file.
  const key = platform === 'win32' || platform === 'darwin' ? foldCase : (s: string) => s
  // Files already resolved by a healthy pool item are never rebind sources or
  // targets — a rename would break the item that still works. An external item
  // claims its file by its OS path.
  const claimed = new Set(
    entries.filter(([id]) => !missingIds.includes(id)).map(([, item]) => key(item.path_rel ?? item.path_abs)),
  )
  const isClaimed = (c: Candidate) => claimed.has(key(c.abs)) || (c.path !== null && claimed.has(key(c.path)))
  const candidates = fs
    .walk(native(MEDIA))
    .map((f): Candidate => ({ ...f, path: f.segments.every(isPortableSegment) ? projectPathOf(MEDIA, ...f.segments) : null }))
    .filter((c) => !isClaimed(c))

  const hashMemo = new Map<string, string | null>() // abs → hex, null = unreadable
  async function hashOf(abs: string): Promise<string | null> {
    if (!hashMemo.has(abs)) {
      try { hashMemo.set(abs, await hashFile(abs)) } catch { hashMemo.set(abs, null) }
    }
    return hashMemo.get(abs) ?? null
  }

  // Same content imported twice with both copies missing: the second item
  // binds to the file the first heal landed on instead of staying missing.
  const healedByHash = new Map<string, { path_abs: string; path_rel: ProjectPath; from: string }>()

  const media_pool: Record<string, MediaItem> = { ...project.media_pool }
  for (const id of missingIds) {
    const item = media_pool[id]
    const recorded = item.path_rel!
    const hash = item.file_hash_blake3
    // Provisional hashes (pending-{id}, pre-hash-pass imports) have no content
    // identity to match against.
    if (!hash || hash.startsWith('pending-')) { report.missing.push(id); continue }

    const prior = healedByHash.get(hash)
    if (prior) {
      media_pool[id] = { ...item, path_abs: prior.path_abs, path_rel: prior.path_rel }
      report.healed.push({ media: id, from: prior.from, to: prior.path_rel })
      continue
    }

    let hit: Candidate | null = null
    for (const c of candidates) {
      if (c.size !== item.file_size) continue
      if ((await hashOf(c.abs)) === hash) { hit = c; break }
    }
    if (!hit) { report.missing.push(id); continue }
    candidates.splice(candidates.indexOf(hit), 1)

    const recordedAbs = native(recorded)
    let bound: { path_abs: string; path_rel: ProjectPath } | null = hit.path ? { path_abs: hit.abs, path_rel: hit.path } : null
    if (!claimed.has(key(recorded)) && !fs.exists(recordedAbs)) {
      try {
        fs.rename(hit.abs, recordedAbs)
        bound = { path_abs: recordedAbs, path_rel: recorded }
      } catch { /* adopt the found path */ }
    }
    if (!bound) { report.missing.push(id); continue }
    claimed.add(key(bound.path_rel))

    const stat = fs.statFile(bound.path_abs)
    media_pool[id] = {
      ...item,
      ...bound,
      file_mtime: stat?.mtimeSecs ?? item.file_mtime,
    }
    const from = [MEDIA, ...hit.segments].join('/')
    healedByHash.set(hash, { ...bound, from })
    report.healed.push({ media: id, from, to: bound.path_rel })
  }

  return { project: { ...project, media_pool }, report }
}
