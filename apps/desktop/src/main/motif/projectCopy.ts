// apps/desktop/src/main/motif/projectCopy.ts
//
// Save As carries the project's Motifs (ADR 0173): the saved copy renders
// what the original did, so every folder its Motif table names goes along.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { PROJECT_MOTIFS_DIR } from './projectStore'

/** Copies `<from>/Motifs/<id>/` to `<to>/Motifs/<id>/` for each id, replacing
 *  a folder of that id already at `<to>`. A folder missing at `<from>` is
 *  skipped: the copy shows it missing, as the original does. Throws on the
 *  first copy that fails, before the caller writes the project that names it. */
export function copyProjectMotifs(from: string, to: string, ids: Iterable<string>): void {
  if (path.resolve(from) === path.resolve(to)) return
  for (const id of ids) {
    const source = path.join(from, PROJECT_MOTIFS_DIR, id)
    if (!existsSync(source)) continue
    const target = path.join(to, PROJECT_MOTIFS_DIR, id)
    mkdirSync(path.dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true })
  }
}
