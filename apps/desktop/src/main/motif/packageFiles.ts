import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface MotifFile { path: string; bytes: Buffer }

/** One portable name: no traversal, Windows aliases or streams. */
function portableSegment(p: string): boolean {
  return p !== '' && p !== '.' && p !== '..'
    && !/[\\/:\x00-\x1f<>"|?*]/.test(p) && !/[. ]$/.test(p)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
}

/** One portable relative path, with no traversal, Windows aliases or streams. */
export function motifFileSegments(rel: string): string[] | null {
  const parts = rel.split('/')
  return parts.every(portableSegment) ? parts : null
}

/** The file a package path names, or null: links and junctions are refused at
 * every level, including the package root. */
function confinedFile(root: string, rel: string): string | null {
  const parts = motifFileSegments(rel)
  if (!parts || rel.toLowerCase() === 'target') return null // private draft metadata
  try {
    if (lstatSync(root).isSymbolicLink()) return null
    let file = root
    for (const part of parts) {
      file = path.join(file, part)
      if (lstatSync(file).isSymbolicLink()) return null
    }
    return lstatSync(file).isFile() ? file : null
  } catch { return null }
}

export function readMotifFile(root: string, rel: string): Buffer | null {
  const file = confinedFile(root, rel)
  try { return file ? readFileSync(file) : null } catch { return null }
}

/** Presence of a package file, under the confinement of `readMotifFile`. */
export function hasMotifFile(root: string, rel: string): boolean {
  return confinedFile(root, rel) !== null
}

/** The limits one package keeps, on import and wherever it is read again. */
const PACKAGE_BYTES = 256 * 1024 * 1024
const PACKAGE_FILES = 10_000

/** One file's identity on disk without its bytes. Times are nanoseconds and
 * `ino` the file id, as decimal strings: a `bigint` does not survive JSON. */
export interface FileStamp { path: string; size: number; mtimeNs: string; ctimeNs: string; ino: string }

/** A package's files in path order: no links at any level, portable paths,
 * regular files only, within the package limits. `target` is the store's
 * private Update metadata, never a package asset. Reads no file's bytes. */
export function stampMotifDirectory(root: string): FileStamp[] {
  const files: FileStamp[] = []
  let total = 0
  if (lstatSync(root).isSymbolicLink()) throw new Error('Motif directory cannot be a symbolic link')
  // Runs per file on every catalog listing: each name is checked once, where
  // it is met, and paths are joined by hand.
  function visit(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      if (prefix === '' && rel.toLowerCase() === 'target') continue
      if (!portableSegment(entry.name)) throw new Error(`Invalid Motif asset path: ${rel}`)
      if (entry.isSymbolicLink()) throw new Error(`Motif assets cannot be symbolic links: ${rel}`)
      const file = dir + path.sep + entry.name
      if (entry.isDirectory()) visit(file, rel + '/')
      else if (entry.isFile()) {
        const stamp = stampOf(rel, file)
        total += stamp.size
        if (total > PACKAGE_BYTES || files.length >= PACKAGE_FILES) throw new Error('Motif package exceeds 256 MiB / 10000 files')
        files.push(stamp)
      } else throw new Error(`Motif asset is not a regular file: ${rel}`)
    }
  }
  visit(root, '')
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function stampOf(rel: string, file: string): FileStamp {
  const stat = lstatSync(file, { bigint: true })
  return { path: rel, size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), ino: String(stat.ino) }
}

/** One package file's stamp, under the confinement of `readMotifFile`; null
 * when the package has no such file. */
export function stampMotifFile(root: string, rel: string): FileStamp | null {
  const file = confinedFile(root, rel)
  try { return file ? stampOf(rel, file) : null } catch { return null }
}

/** Whether two stamps are of one file, unchanged. */
export function sameStamp(a: FileStamp | null | undefined, b: FileStamp | null | undefined): boolean {
  return !!a && !!b && a.path === b.path && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino
}

/** Whether two stampings saw the same files, unchanged. */
export function sameStamps(a: readonly FileStamp[], b: readonly FileStamp[]): boolean {
  return a.length === b.length && a.every((f, i) => sameStamp(f, b[i]))
}

/** The bytes of the files a stamping saw. */
export function readStampedFiles(root: string, stamps: readonly FileStamp[]): MotifFile[] {
  return stamps.map(({ path: rel }) => {
    const bytes = readMotifFile(root, rel)
    if (!bytes) throw new Error(`Cannot read Motif asset: ${rel}`)
    return { path: rel, bytes }
  })
}

/** Snapshot before importing/copying: never follow links outside the package. */
export function readMotifDirectory(root: string): MotifFile[] {
  return readStampedFiles(root, stampMotifDirectory(root))
}
