// apps/desktop/src/main/state/projectContent.ts
//
// The files a project folder holds beside project.json, and how they travel
// inside or between folders: Save As copies them to the new folder, and the
// open carries out the file moves and copies a schema upgrade planned.
//
// A copy is a clone where the volume can make one, else a hard link, else a
// byte copy. A hard link shares its bytes with the source folder: an edit
// made in place to one file changes the other too, and the folder that did
// not make the edit then reports its file as changed (ADR 0153). Media files
// are never edited in place by the app, so the link is safe for them.
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MEDIA, parseProjectPath, type ProjectPath } from '../../shared/projectPath'
import { TASTE_FILE } from '../taste/packages'
import type { FilePlan } from './migrate'
import { toNative, type PathPlatform } from './projectPathNative'

/** What Save As copies, beside `Motifs/` (motif/projectCopy.ts): each a
 *  folder copied whole or a file, when present. Everything else in the folder
 *  is this machine's (`Cache/`, `Backups/`, `Logs/`, the pre-upgrade
 *  `project.pre-v*.json` files, exports under `output/`) and stays behind. */
export const PROJECT_CONTENT: readonly ProjectPath[] = [
  MEDIA, parseProjectPath(TASTE_FILE), parseProjectPath('export.json'), parseProjectPath('view.json'),
]

/** The node:fs/promises calls a copy makes; node:fs/promises itself in
 *  production. `lstat` and `realpath` reject with ENOENT for a missing path. */
export interface ProjectContentFs {
  lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; atimeMs: number; mtimeMs: number }>
  readdir(dir: string): Promise<string[]>
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>
  copyFile(src: string, dst: string, mode?: number): Promise<void>
  link(src: string, dst: string): Promise<void>
  utimes(p: string, atime: number, mtime: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(p: string, opts: { force: true }): Promise<void>
  realpath(p: string): Promise<string>
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

/** `dir` as the file system resolves it, links and case included; `dir`
 *  itself while it does not exist. */
async function realDir(fs: ProjectContentFs, dir: string): Promise<string> {
  try { return await fs.realpath(dir) } catch { return path.resolve(dir) }
}

/** Whether `a` and `b` name one folder, however spelled. */
export async function sameFolder(fs: ProjectContentFs, a: string, b: string): Promise<boolean> {
  return (await realDir(fs, a)) === (await realDir(fs, b))
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

async function lstatOrNull(fs: ProjectContentFs, p: string) {
  try { return await fs.lstat(p) } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** Errors that say the volume makes no clone of this file. */
const NO_CLONE = new Set(['ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'])
/** Errors that say the volume makes no hard link of this file. */
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP'])

/** Puts the bytes of `src` at the new path `dst`: a clone, a hard link when
 *  `link` allows one, a byte copy otherwise. Answers whether it linked. */
async function cloneLinkOrCopy(fs: ProjectContentFs, src: string, dst: string, link: boolean): Promise<boolean> {
  try { await fs.copyFile(src, dst, constants.COPYFILE_FICLONE_FORCE); return false } catch (error) {
    if (!NO_CLONE.has(errorCode(error) ?? '')) throw error
  }
  await fs.rm(dst, { force: true })
  if (link) {
    try { await fs.link(src, dst); return true } catch (error) {
      if (!NO_LINK.has(errorCode(error) ?? '')) throw error
    }
  }
  await fs.copyFile(src, dst)
  return false
}

/** Places a copy of the file `src` at `dst` with the source's times, so the
 *  next open finds it unchanged without reading it. Written under a temporary
 *  name and renamed over `dst`: a file already at `dst` may be a link into
 *  another folder, and writing into it would change that folder's file. */
async function placeFile(fs: ProjectContentFs, src: string, dst: string, times: { atimeMs: number; mtimeMs: number }, link: boolean): Promise<void> {
  const temp = path.join(path.dirname(dst), `.${path.basename(dst)}.${randomUUID()}.tmp`)
  try {
    // A link is the source file itself, its times already the source's.
    if (!(await cloneLinkOrCopy(fs, src, temp, link))) await fs.utimes(temp, times.atimeMs / 1000, times.mtimeMs / 1000)
    await fs.rename(temp, dst)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Copies `src` to `dst`: a folder whole, a file, nothing for a symbolic link
 *  or a missing path. */
async function copyEntry(fs: ProjectContentFs, src: string, dst: string): Promise<void> {
  const st = await lstatOrNull(fs, src)
  if (!st || st.isSymbolicLink()) return
  if (st.isDirectory()) {
    await fs.mkdir(dst, { recursive: true })
    for (const name of await fs.readdir(src)) await copyEntry(fs, path.join(src, name), path.join(dst, name))
  } else if (st.isFile()) {
    await placeFile(fs, src, dst, st, true)
  }
}

/** Save As: copies the project content (`PROJECT_CONTENT`) of the folder
 *  `from` into the existing folder `to`, replacing files of the same name.
 *  Nothing is copied when both name one folder. Throws on the first file that
 *  fails, and refuses a `to` inside `from`'s `Media/`, which the copy would
 *  copy into itself. */
export async function copyProjectContent(from: string, to: string, fs: ProjectContentFs, platform: PathPlatform = process.platform): Promise<void> {
  const target = await realDir(fs, to)
  if (target === await realDir(fs, from)) return
  if (isInside(target, await realDir(fs, toNative(from, MEDIA, platform)))) {
    throw new Error("A project cannot be saved inside the Media folder of the project it is saved from")
  }
  for (const entry of PROJECT_CONTENT) await copyEntry(fs, toNative(from, entry, platform), toNative(to, entry, platform))
}

/** A planned copy that left its target without a file. */
export interface MissingFile { path: string; diagnostic: string }

/** Carries out a schema upgrade's file plans in the folder `dir`, each at
 *  most once: a plan whose target is already there is done. A move whose
 *  source is gone is skipped. Never throws: answers the copies that left
 *  their target without a file. */
export async function placeFilePlans(dir: string, plans: readonly FilePlan[], fs: ProjectContentFs, platform: PathPlatform = process.platform): Promise<MissingFile[]> {
  const missing: MissingFile[] = []
  for (const plan of plans) {
    try {
      const from = toNative(dir, parseProjectPath(plan.from), platform)
      const to = toNative(dir, parseProjectPath(plan.to), platform)
      if (await lstatOrNull(fs, to)) continue
      const source = await lstatOrNull(fs, from)
      if (!source?.isFile()) {
        if (plan.mode === 'copy') missing.push({ path: plan.to, diagnostic: `${plan.from} is not in the project folder` })
        continue
      }
      await fs.mkdir(path.dirname(to), { recursive: true })
      // Never a link: later syntheses reuse the cached voiceover, and an edit
      // made in place to the project's file would change what they reuse.
      if (plan.mode === 'move') await fs.rename(from, to)
      else await placeFile(fs, from, to, source, false)
    } catch (error) {
      if (plan.mode === 'copy') missing.push({ path: plan.to, diagnostic: String(error) })
      else console.warn('[project] planned file move failed', plan, error)
    }
  }
  return missing
}
