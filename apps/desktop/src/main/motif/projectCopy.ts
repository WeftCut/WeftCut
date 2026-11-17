// apps/desktop/src/main/motif/projectCopy.ts
//
// Save As carries the project's Motifs (ADR 0173): the saved copy renders
// what the original did, so every folder its Motif table names goes along,
// and so do the backups its undo puts them back from.

import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MOTIF_BACKUPS_DIR } from './backups'
import { PROJECT_MOTIFS_DIR } from './projectStore'

/** `dir` as the file system resolves it, links and case included; `dir`
 *  itself while it does not exist yet. */
function realDir(dir: string): string {
  try { return realpathSync.native(dir) } catch { return path.resolve(dir) }
}

/** Copies `source` to `target` whole: into a staging folder beside
 *  `target`, which then takes its place. What `target` held is removed only
 *  once the copy is complete. Dot-named, as no Motif id is, so a folder
 *  left by a crash is never listed as a Motif. */
function copyOver(source: string, target: string): void {
  const parent = path.dirname(target)
  mkdirSync(parent, { recursive: true })
  const staging = path.join(parent, `.stage-${randomUUID()}`), old = path.join(parent, `.old-${randomUUID()}`)
  try {
    cpSync(source, staging, { recursive: true })
    if (existsSync(target)) renameSync(target, old)
    try { renameSync(staging, target) }
    catch (error) {
      if (existsSync(old)) renameSync(old, target)
      throw error
    }
    rmSync(old, { recursive: true, force: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Copies `<from>/Motifs/<id>/` to `<to>/Motifs/<id>/` for each id,
 *  replacing a folder of that id already at `<to>`, and `<from>`'s Motif
 *  backups with them. A folder missing at `<from>` is skipped: the copy shows
 *  it missing, as the original does. Nothing is copied when both name one
 *  folder, however spelled. Throws on the first copy that fails, before the
 *  caller writes the project that names it. */
export function copyProjectMotifs(from: string, to: string, ids: Iterable<string>): void {
  if (realDir(from) === realDir(to)) return
  for (const id of ids) {
    const source = path.join(from, PROJECT_MOTIFS_DIR, id)
    if (!existsSync(source)) continue
    copyOver(source, path.join(to, PROJECT_MOTIFS_DIR, id))
  }
  const backups = path.join(from, MOTIF_BACKUPS_DIR)
  if (existsSync(backups)) copyOver(backups, path.join(to, MOTIF_BACKUPS_DIR))
}
