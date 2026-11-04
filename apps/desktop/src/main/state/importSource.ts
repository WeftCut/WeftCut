// apps/desktop/src/main/state/importSource.ts
//
// Where an import's source already stands: the pool item whose file or bytes
// it is, or a place under the project's Media/ folder, where the import copy
// would have put it. Pure but for the injected file key and realpath;
// `platform` picks the path rules, so a test on Linux can speak Windows paths.
import path from 'node:path'
import type { MediaItem } from './model'

/** The folder the import copy writes into (native `jobs/import.rs` MEDIA_DIR). */
const MEDIA_DIR = 'Media'
/** The probe's provisional hash (native `media_item_from_metadata`). */
const PENDING_HASH = 'pending-'

export const pathLib = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

/** Which file a path names: two paths name one file exactly when their keys
 *  are equal. Null when nothing is there. */
export type FileKey = (p: string) => string | null

/** The key when the host can tell no file identity: the resolved real path,
 *  as spelled. Never folded for case or Unicode normalization: whether two
 *  spellings are one file is the volume's call (NTFS holds an NFC and an NFD
 *  `café.mp4` side by side), and only a stat can ask it. */
export function spelledKey(realPath: (p: string) => string, platform: NodeJS.Platform): FileKey {
  return (p) => pathLib(platform).resolve(realPath(p))
}

/** The pool item whose file `source` is: a link, another spelling or the
 *  source of a copy still in flight all match, provided the probe's size and
 *  modification time still match the item. File identity alone survives an
 *  overwrite; a changed fingerprint must go through content matching instead.
 *  A pooled file that is gone matches nothing. */
function pooledItemFor(
  pool: Record<string, MediaItem>, source: string,
  found: Pick<MediaItem, 'file_size' | 'file_mtime'>, fileKey: FileKey,
): MediaItem | null {
  const key = fileKey(source)
  if (key === null) return null
  for (const item of Object.values(pool)) {
    if (item.file_size === found.file_size && item.file_mtime === found.file_mtime && fileKey(item.path_abs) === key) return item
  }
  return null
}

/** Whether a pool item of `size` bytes has its content hash yet, so hashing a
 *  source of that size could find it. A copy into Media/ replaces the item's
 *  path, so its bytes are what is left to match the source by. */
function hashedItemOfSize(pool: Record<string, MediaItem>, size: number): boolean {
  return Object.values(pool).some((m) => m.file_size === size && !m.file_hash_blake3.startsWith(PENDING_HASH))
}

/** Whether a pool item's own file still holds the bytes its hash records. The
 *  hash was read once, at import; anything outside the app may have deleted
 *  or overwritten the file since, so only a fresh read can say `holds`. */
export type Holding = 'holds' | 'gone' | 'replaced'

/** The next thing an import does. `verify` asks for one item's Holding and
 *  then asks again: every answer is decided from the pool as it is then. */
export type ImportStep =
  | { kind: 'join'; id: string }
  | { kind: 'hash' }
  | { kind: 'verify'; item: MediaItem }
  | { kind: 'reuse'; id: string }
  | { kind: 'relink'; id: string }
  | { kind: 'add' }

/** The one place an import decides whether the pool already answers it
 *  (ADR 0151). Pure: the facts read so far come in, and an answer is only
 *  ever an item whose own file holds the source's bytes.
 *
 *  - An import or relink in flight for the source's own file (by identity and
 *    fingerprint), or for an item of its bytes, is joined: it may yet roll back.
 *  - Unhashed, the source is hashed when a hashed item of its size exists;
 *    else nothing in the pool can hold its bytes and it is added.
 *  - Of the items recording its bytes, one that holds them is reused: the
 *    source's own file does, having just been read; another's must be read.
 *  - None holds them (each file gone or overwritten): the first is relinked
 *    to the source, whose bytes it records. Its layers and derivatives keep
 *    meaning those bytes; whatever now sits at its old path is another file.
 *  - No item records them: the source is added. */
export function nextImportStep(input: {
  pool: Record<string, MediaItem>
  source: string
  found: Pick<MediaItem, 'file_size' | 'file_mtime'>
  fileKey: FileKey
  /** The source's content hash; null until read. */
  hash: string | null
  inFlight: (id: string) => boolean
  /** A Holding already read for this item as it stands, else undefined. */
  holding: (item: MediaItem) => Holding | undefined
}): ImportStep {
  const { pool, source, fileKey, hash } = input
  const sameFile = pooledItemFor(pool, source, input.found, fileKey)
  if (sameFile && input.inFlight(sameFile.id)) return { kind: 'join', id: sameFile.id }
  if (hash === null) return hashedItemOfSize(pool, input.found.file_size) ? { kind: 'hash' } : { kind: 'add' }
  const recorded = Object.values(pool).filter((m) => m.file_hash_blake3 === hash)
  const busy = recorded.find((m) => input.inFlight(m.id))
  if (busy) return { kind: 'join', id: busy.id }
  const sourceKey = fileKey(source)
  const holdingOf = (m: MediaItem) => (sourceKey !== null && fileKey(m.path_abs) === sourceKey ? 'holds' : input.holding(m))
  const holds = recorded.find((m) => holdingOf(m) === 'holds')
  if (holds) return { kind: 'reuse', id: holds.id }
  const unread = recorded.find((m) => holdingOf(m) === undefined)
  if (unread) return { kind: 'verify', item: unread }
  return recorded.length ? { kind: 'relink', id: recorded[0].id } : { kind: 'add' }
}

/** `source`'s path relative to the project folder when it already sits under
 *  the project's Media/ folder, else null. A folder is Media/ when it is the
 *  same folder, however the two paths spell it. */
export function mediaFolderPath(
  workspaceDir: string, source: string,
  realPath: (p: string) => string, fileKey: FileKey, platform: NodeJS.Platform,
): string | null {
  const lib = pathLib(platform)
  const media = fileKey(lib.join(workspaceDir, MEDIA_DIR))
  if (media === null) return null
  const file = realPath(source)
  for (let dir = lib.dirname(file); ; dir = lib.dirname(dir)) {
    if (fileKey(dir) === media) return lib.join(MEDIA_DIR, lib.relative(dir, file))
    if (lib.dirname(dir) === dir) return null
  }
}

/** `source` as an absolute path: a relative one is read from the project
 *  folder. Null when it is relative and no project is open. A Windows path
 *  counts as absolute on every host: no one means `C:/clip.mp4` relative to a
 *  folder, and on POSIX it names nothing and is refused as missing. */
export function absoluteSource(workspaceDir: string | null, source: string, platform: NodeJS.Platform): string | null {
  const lib = pathLib(platform)
  if (lib.isAbsolute(source) || path.win32.isAbsolute(source)) return source
  return workspaceDir === null ? null : lib.join(workspaceDir, source)
}
