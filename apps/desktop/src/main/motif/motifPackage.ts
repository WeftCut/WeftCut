// What a set of files makes as a Motif package, and how a whole package is
// written. The stores decide where packages live; this module decides what
// their files mean.
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { composeMotifHtml, parseManifestIsland, validateManifest, type Manifest } from '../../shared/motifs/catalog'
import { motifContentHash } from './contentHash'
import { motifFileSegments, type MotifFile } from './packageFiles'

/** What an `empty` source starts as. */
export const EMPTY_DRAFT = { name: 'Untitled Motif', size: [960, 540] as [number, number], default_duration_s: 5 }

/** The files of a new, empty Motif named `name`. */
export function emptyPackageFiles(name?: string): MotifFile[] {
  return [
    { path: 'index.html', bytes: Buffer.from('<!doctype html><html><body><script>motif.define({frame(t){}})</script></body></html>') },
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify({ ...EMPTY_DRAFT, name: name || EMPTY_DRAFT.name, props_schema: {} })) },
  ]
}

export function validateFiles(files: readonly MotifFile[]): void {
  const nodes = new Map<string, string>()
  let total = 0
  for (const file of files) {
    const parts = motifFileSegments(file.path)
    if (!parts || parts[0].toLowerCase() === '.revisions')
      throw new Error('Invalid Motif file path: ' + file.path)
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase(), kind = i === parts.length ? 'file' : 'dir'
      const value = kind + ':' + prefix, previous = nodes.get(key)
      if (previous && (previous !== value || kind === 'file'))
        throw new Error('Conflicting Motif file path: ' + file.path)
      nodes.set(key, value)
    }
    total += file.bytes.length
  }
  if (files.length > 10000 || total > 256 * 1024 * 1024)
    throw new Error('Motif package exceeds 256 MiB / 10000 files')
}

/** The manifest the files declare: `manifest.json` when present, else the
 *  page's island. */
export function declaredManifest(files: readonly MotifFile[]): { input: Manifest; html: string } {
  const html = files.find(f => f.path === 'index.html')?.bytes.toString('utf8')
  if (html === undefined) throw new Error('A Motif folder must contain index.html')
  const json = files.find(f => f.path === 'manifest.json')
  return { input: json ? JSON.parse(json.bytes.toString('utf8')) as Manifest : parseManifestIsland(html), html }
}

/** The package the app writes for `files` under `id`: the page's island and
 *  `manifest.json` are composed from the declared manifest. `version` 'own'
 *  keeps the manifest's version (1 when it declares none).
 *
 *  Not idempotent: composing a composed page adds a line, so normalising a
 *  normalised package changes its revision. A package the app reads back is
 *  hashed as it is (`declaredPackage`), never normalised again. */
export function normalize(files: readonly MotifFile[], id: string, version: number | 'own' = 1) {
  validateFiles(files)
  const { input, html } = declaredManifest(files)
  const own = Number.isSafeInteger(input.version) && input.version > 0 ? input.version : 1
  const manifest = { ...input, id, version: version === 'own' ? own : version } as Manifest
  validateManifest(manifest)
  const composed = composeMotifHtml(manifest, html)
  const normalized = [...files.filter(f => f.path !== 'index.html' && f.path !== 'manifest.json'),
    { path: 'index.html', bytes: Buffer.from(composed) }, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) }]
  validateFiles(normalized)
  return { manifest, html: composed, files: normalized, revision: motifContentHash(manifest, composed, normalized) }
}

/** The package a folder named `id` holds, read as its files stand: the
 *  declared manifest under the folder's id, with the bytes hashed unchanged.
 *  The files of a library version, a built-in or a draft keep their revision
 *  when copied under the same id; a folder an author edits is never
 *  rewritten. Throws what makes the files no package. */
export function declaredPackage(files: readonly MotifFile[], id: string): { manifest: Manifest; html: string; revision: string } {
  validateFiles(files)
  const { input, html } = declaredManifest(files)
  const manifest = { ...input, id } as Manifest
  validateManifest(manifest)
  return { manifest, html, revision: motifContentHash(manifest, html, files) }
}

/** Replace a whole app-owned package. A failed rename restores the old
 *  package. Installed Motifs are never replaced: each publication adds a
 *  version (`UserMotifStore.addVersion`). */
export function replacePackage(directory: string, files: readonly MotifFile[]): void {
  validateFiles(files)
  mkdirSync(path.dirname(directory), { recursive: true })
  const staging = directory + '.stage-' + randomUUID(), backup = directory + '.backup-' + randomUUID()
  mkdirSync(staging)
  try {
    for (const file of files) {
      const dest = path.join(staging, ...file.path.split('/'))
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, file.bytes)
    }
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink())
        throw new Error('Motif package cannot be a link')
      renameSync(directory, backup)
    }
    try {
      renameSync(staging, directory)
    } catch (error) {
      if (existsSync(backup))
        renameSync(backup, directory)
      throw error
    }
    rmSync(backup, { recursive: true, force: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
