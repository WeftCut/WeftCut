import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface MotifFile { path: string; bytes: Buffer }

/** One portable relative path, with no traversal, Windows aliases or streams. */
export function motifFileSegments(rel: string): string[] | null {
  const parts = rel.split('/')
  return parts.every(p => p !== '' && p !== '.' && p !== '..'
    && !/[\\:\x00-\x1f<>"|?*]/.test(p) && !/[. ]$/.test(p)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) ? parts : null
}

/** Refuse links/junctions at every level, including the package root. */
export function readMotifFile(root: string, rel: string): Buffer | null {
  const parts = motifFileSegments(rel)
  if (!parts || rel.toLowerCase() === 'target') return null // private draft metadata
  try {
    if (lstatSync(root).isSymbolicLink()) return null
    let file = root
    for (const part of parts) {
      file = path.join(file, part)
      if (lstatSync(file).isSymbolicLink()) return null
    }
    return lstatSync(file).isFile() ? readFileSync(file) : null
  } catch { return null }
}

/** Snapshot before importing/copying: never follow links outside the package.
 * `target` is the store's private Update metadata, never a package asset. */
export function readMotifDirectory(root: string): MotifFile[] {
  const files: MotifFile[] = []
  if (lstatSync(root).isSymbolicLink()) throw new Error('Motif directory cannot be a symbolic link')
  function visit(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      if (rel.toLowerCase() === 'target') continue
      if (!motifFileSegments(rel)) throw new Error(`Invalid Motif asset path: ${rel}`)
      if (entry.isSymbolicLink()) throw new Error(`Motif assets cannot be symbolic links: ${rel}`)
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel + '/')
      else if (entry.isFile()) {
        const bytes = readMotifFile(root, rel)
        if (!bytes) throw new Error(`Cannot read Motif asset: ${rel}`)
        files.push({ path: rel, bytes })
      } else throw new Error(`Motif asset is not a regular file: ${rel}`)
    }
  }
  visit(root, '')
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
