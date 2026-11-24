// apps/desktop/src/main/taste/projectStyles.ts
//
// The user style a project's TASTE.md extends, copied into the project's
// `Styles/<name>/` so the folder carries the style it renders with (ADR 0176).
// The taste view looks there before the user's packages (./view.ts).

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { listStyleDirs, readTasteFile, STYLES_DIR } from './packages'
import { parseExtends, type StyleDirs } from './view'

/** A copy in progress: `.<name>.<uuid>.part`. `listStyleDirs` skips dot
 *  names, so the taste view never reads a half-copied package. */
const PART = /^\..+\.part$/

/** Copies per project folder run one after another, so a cleanup of stale
 *  `.part` directories never removes one still being written. */
const running = new Map<string, Promise<unknown>>()

/** Copy the user style `TASTE.md` extends into `<projectDir>/Styles/<name>/`,
 *  when it is a user package and the project has no style by that name.
 *  A project copy already there is kept as it is: it is what the project
 *  renders with, and the user's package may have moved on since. Built-in
 *  styles are never copied. Resolves to the copied style's name, or null.
 *  Call it when a project opens and whenever its TASTE.md may have changed. */
export function collectExtendedStyle(dirs: StyleDirs, projectDir: string): Promise<string | null> {
  const stylesDir = path.join(projectDir, STYLES_DIR)
  const next = (running.get(stylesDir) ?? Promise.resolve()).catch(() => {}).then(() => copyExtended(dirs, projectDir, stylesDir))
  running.set(stylesDir, next)
  void next.finally(() => { if (running.get(stylesDir) === next) running.delete(stylesDir) }).catch(() => {})
  return next
}

/** The name of the style TASTE.md extends when the project folder does not
 *  carry it: neither a built-in nor under `Styles/`, so it resolves from this
 *  machine's user styles or nowhere. Null when TASTE.md extends nothing or
 *  the folder carries the style. */
export function styleOutsideProject(dirs: StyleDirs, projectDir: string): string | null {
  const file = readTasteFile(projectDir)
  const data = file && 'frontmatter' in file ? file.frontmatter.data : null
  if (!data || data.extends === undefined) return null
  const { name } = parseExtends(data.extends, [])
  return listStyleDirs(dirs.builtin).has(name) || listStyleDirs(path.join(projectDir, STYLES_DIR)).has(name) ? null : name
}

async function copyExtended(dirs: StyleDirs, projectDir: string, stylesDir: string): Promise<string | null> {
  const name = styleOutsideProject(dirs, projectDir)
  if (name === null) return null
  const source = listStyleDirs(dirs.user).get(name)
  if (!source) return null
  await removeStaleParts(stylesDir)
  const part = path.join(stylesDir, `.${name}.${randomUUID()}.part`)
  try {
    await fs.promises.mkdir(stylesDir, { recursive: true })
    // Dot entries are left out, as the package hash leaves them out
    // (./packages.ts): the copy hashes like its source, so a pin still matches.
    await fs.promises.cp(source, part, { recursive: true, filter: (src) => src === source || !path.basename(src).startsWith('.') })
    await fs.promises.rename(part, path.join(stylesDir, name))
    return name
  } catch (e) {
    await fs.promises.rm(part, { recursive: true, force: true })
    // Another writer (a sync, a second app instance) put the style there first.
    if (listStyleDirs(stylesDir).has(name)) return null
    throw e
  }
}

async function removeStaleParts(stylesDir: string): Promise<void> {
  let names: string[]
  try { names = await fs.promises.readdir(stylesDir) } catch { return }
  for (const n of names) if (PART.test(n)) await fs.promises.rm(path.join(stylesDir, n), { recursive: true, force: true })
}
