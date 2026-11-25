// apps/desktop/src/main/state/projectContent.ts
//
// The files a project folder holds beside project.wcpr, and how they travel
// inside or between folders: Save As copies them to the new folder, a pack
// lists the same files (ADR 0178), and the open carries out the file moves and
// copies a schema upgrade planned.
//
// A copy is a clone where the volume can make one, else a hard link, else a
// byte copy. A hard link shares its bytes with the source folder: an edit
// made in place to one file changes the other too, and the folder that did
// not make the edit then reports its file as changed (ADR 0153). Media files
// are never edited in place by the app, so only files under `Media/` are
// linked; `TASTE.md`, style packages, fonts and the other files people may
// replace or edit are always copied.
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MEDIA, isPortableSegment, parseProjectPath, projectPathOf, type ProjectPath } from '../../shared/projectPath'
import { STYLES_DIR, TASTE_FILE } from '../taste/packages'
import { FONTS_DIR } from '../fonts/projectFonts'
import { PROJECT_MOTIFS_DIR } from '../motif/projectStore'
import { PROJECT_FILE } from '../../shared/projectFile'
import type { FilePlan } from './migrate'
import { toNative, type PathPlatform } from './projectPathNative'

/** The project's ignore file. People edit it, so it is content that is
 *  copied, never linked. */
export const GITIGNORE = parseProjectPath('.gitignore')

/** What Save As copies, beside `Motifs/` (motif/projectCopy.ts): each a
 *  folder copied whole or a file, when present. Everything else in the folder
 *  (`PROJECT_MACHINE_LOCAL` and anything the app did not put there) stays
 *  behind. */
export const PROJECT_CONTENT: readonly ProjectPath[] = [
  MEDIA, parseProjectPath(FONTS_DIR), parseProjectPath(STYLES_DIR), parseProjectPath(TASTE_FILE),
  parseProjectPath('export.json'), parseProjectPath('view.json'), GITIGNORE,
]

/** The top-level names a pack may hold: project.wcpr, the project content
 *  and `Motifs/`. An unpack refuses an archive entry under any other name. */
export const PACK_TOP_LEVEL: readonly string[] = [PROJECT_FILE, ...PROJECT_CONTENT, PROJECT_MOTIFS_DIR]

/** What the app keeps in a project folder for this machine alone, as
 *  `.gitignore` patterns: caches it rebuilds, autosave and Motif history
 *  backups, logs, exports, and the pre-upgrade `project.pre-v*.json` files. */
export const PROJECT_MACHINE_LOCAL: readonly string[] = [
  '/Cache/', '/Backups/', '/Logs/', '/output/', '/project.pre-v*.json', '*.tmp',
]

/** The `.gitignore` a project gets when it has none. */
export const DEFAULT_GITIGNORE =
  `# This machine's files: WeftCut rebuilds or keeps them for this machine alone.\n${PROJECT_MACHINE_LOCAL.join('\n')}\n`

/** Writes `DEFAULT_GITIGNORE` into the project folder `dir` when it holds no
 *  `.gitignore`; one already there is the user's and stays. */
export function ensureGitignore(dir: string, fs: { exists(path: string): boolean; writeFile(path: string, text: string): void }, join: (...parts: string[]) => string): void {
  const file = join(dir, GITIGNORE)
  if (!fs.exists(file)) fs.writeFile(file, DEFAULT_GITIGNORE)
}

/** The node:fs/promises calls a copy makes; node:fs/promises itself in
 *  production. `lstat` and `realpath` reject with ENOENT for a missing path. */
export interface ProjectContentFs {
  lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; atimeMs: number; mtimeMs: number; size: number }>
  readdir(dir: string): Promise<string[]>
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>
  copyFile(src: string, dst: string, mode?: number): Promise<void>
  link(src: string, dst: string): Promise<void>
  utimes(p: string, atime: number, mtime: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(p: string, opts: { force: true }): Promise<void>
  realpath(p: string): Promise<string>
}

/** The path rules of `platform`: the host's in production, another OS's in
 *  tests that stand in for it. One library for every path a copy builds, so a
 *  folder named the Windows way is never split the POSIX way. */
type PathLib = typeof path.posix
const pathLib = (platform: PathPlatform): PathLib => (platform === 'win32' ? path.win32 : path.posix)

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

/** `dir` as the file system resolves it, links and case included; `dir`
 *  itself while it does not exist. */
async function realDir(fs: ProjectContentFs, dir: string, l: PathLib): Promise<string> {
  try { return await fs.realpath(dir) } catch { return l.resolve(dir) }
}

/** Whether `a` and `b` name one folder, however spelled. */
export async function sameFolder(fs: ProjectContentFs, a: string, b: string, platform: PathPlatform = process.platform): Promise<boolean> {
  const l = pathLib(platform)
  return (await realDir(fs, a, l)) === (await realDir(fs, b, l))
}

function isInside(child: string, parent: string, l: PathLib): boolean {
  const rel = l.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${l.sep}`) && !l.isAbsolute(rel))
}

async function lstatOrNull(fs: Pick<ProjectContentFs, 'lstat'>, p: string) {
  try { return await fs.lstat(p) } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** Places the bytes of the file `src` at `dst`, with the source's times so
 *  the next open finds it unchanged without reading it: a clone where the
 *  volume makes one; else, when `link` allows and nothing is at `dst` yet, a
 *  hard link; else a byte copy. A clone or copy is written under a temporary
 *  name and renamed over `dst`, never into it: a file already at `dst` may be
 *  a link into another folder, and writing into it would change that
 *  folder's file. Any failure to clone or link means the volume makes none
 *  here (FAT and exFAT report a link refusal under several codes), so the
 *  next way is tried. */
async function placeFile(fs: ProjectContentFs, src: string, dst: string, times: { atimeMs: number; mtimeMs: number }, link: boolean, l: PathLib): Promise<void> {
  const temp = l.join(l.dirname(dst), `.${l.basename(dst)}.${randomUUID()}.tmp`)
  try {
    let cloned = false
    try { await fs.copyFile(src, temp, constants.COPYFILE_FICLONE_FORCE); cloned = true } catch {
      await fs.rm(temp, { force: true })
    }
    if (!cloned && link && !(await lstatOrNull(fs, dst))) {
      // LANDMINE: the link is made at `dst` itself, never at a temporary name
      // renamed into place. On NTFS renaming any name of a file needs delete
      // access against every open handle of that file, and a decoder holds the
      // source open without FILE_SHARE_DELETE (cache/mod.rs), so the rename of
      // a fresh link fails while the clip plays. A link is the source file
      // itself: its times are already the source's.
      try { await fs.link(src, dst); return } catch { /* no link on this volume: copy */ }
    }
    if (!cloned) await fs.copyFile(src, temp)
    await fs.utimes(temp, times.atimeMs / 1000, times.mtimeMs / 1000)
    await fs.rename(temp, dst)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Not project content: hidden files and the temporary files of an import or
 *  a copy still running. The relink walk skips the same names. */
function isScratchName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.tmp')
}

/** Copies `src` to `dst`: a folder whole, a file, nothing for a symbolic link
 *  or a missing path. `link` allows hard links (media only). */
async function copyEntry(fs: ProjectContentFs, src: string, dst: string, link: boolean, l: PathLib): Promise<void> {
  const st = await lstatOrNull(fs, src)
  if (!st || st.isSymbolicLink()) return
  if (st.isDirectory()) {
    await fs.mkdir(dst, { recursive: true })
    for (const name of await fs.readdir(src)) {
      if (!isScratchName(name)) await copyEntry(fs, l.join(src, name), l.join(dst, name), link, l)
    }
  } else if (st.isFile()) {
    await placeFile(fs, src, dst, st, link, l)
  }
}

/** Save As: copies the project content (`PROJECT_CONTENT`) of the folder
 *  `from` into the existing folder `to`, replacing files of the same name.
 *  Nothing is copied when both name one folder. Throws on the first file that
 *  fails, and refuses a `to` inside a folder Save As copies (`Media/`,
 *  `Fonts/`, `Styles/`, `Motifs/`), which the copy would copy into itself. */
export async function copyProjectContent(from: string, to: string, fs: ProjectContentFs, platform: PathPlatform = process.platform): Promise<void> {
  const l = pathLib(platform)
  const target = await realDir(fs, to, l)
  if (target === await realDir(fs, from, l)) return
  for (const folder of [...PROJECT_CONTENT, parseProjectPath(PROJECT_MOTIFS_DIR)]) {
    if (isInside(target, await realDir(fs, toNative(from, folder, platform), l), l))
      throw new Error(`A project cannot be saved inside the ${folder} folder of the project it is saved from`)
  }
  for (const entry of PROJECT_CONTENT) await copyEntry(fs, toNative(from, entry, platform), toNative(to, entry, platform), entry === MEDIA, l)
}

/** One file of a pack and its size in bytes. */
export interface PackEntry { path: ProjectPath; size: number }

/** Lists `src` (project path `rel`) into `out` as Save As copies it: a folder
 *  whole, a file, nothing for a symbolic link or a missing path. `scratch`
 *  leaves hidden and temporary names inside a folder out, as `copyEntry`
 *  does; a Motif folder is copied whole, so it is listed whole. A name no project path can
 *  take is left out: no project record can name it, and an archive entry
 *  must be a project path. */
async function listEntry(fs: Pick<ProjectContentFs, 'lstat' | 'readdir'>, src: string, rel: string[], scratch: boolean, l: PathLib, out: PackEntry[]): Promise<void> {
  const st = await lstatOrNull(fs, src)
  if (!st || st.isSymbolicLink()) return
  if (st.isDirectory()) {
    for (const name of (await fs.readdir(src)).sort()) {
      if ((scratch && isScratchName(name)) || !isPortableSegment(name)) continue
      await listEntry(fs, l.join(src, name), [...rel, name], scratch, l, out)
    }
  } else if (st.isFile()) {
    out.push({ path: projectPathOf(...rel), size: st.size })
  }
}

/** What a pack of the project folder `dir` holds: project.wcpr first, then
 *  every file Save As copies into a new folder — the project content
 *  (`PROJECT_CONTENT`) and `Motifs/<id>/` for each id of the project's Motif
 *  table (motif/projectCopy.ts). Never `Backups/` or another machine-local
 *  entry. project.wcpr leads because autosave may rewrite it while the pack
 *  runs, and the pack fails on a file whose size changed before it was read.
 *
 *  `pooled` is the media pool's project paths: a file under `Media/` the pool
 *  draws is listed even when its name is one the folder walk skips as scratch
 *  (an imported `.voice.wav`), as Save As's `copyLateFiles` copies it. */
export async function packFiles(dir: string, motifIds: Iterable<string>, fs: Pick<ProjectContentFs, 'lstat' | 'readdir'>, platform: PathPlatform = process.platform, pooled: Iterable<ProjectPath> = []): Promise<PackEntry[]> {
  const l = pathLib(platform)
  const out: PackEntry[] = []
  await listEntry(fs, l.join(dir, PROJECT_FILE), [PROJECT_FILE], true, l, out)
  for (const entry of PROJECT_CONTENT) await listEntry(fs, toNative(dir, entry, platform), [entry], true, l, out)
  const listed = new Set<string>(out.map(e => e.path))
  for (const p of pooled) {
    if (listed.has(p) || !p.startsWith(`${MEDIA}/`)) continue
    const st = await lstatOrNull(fs, toNative(dir, p, platform))
    if (st?.isFile()) { out.push({ path: p, size: st.size }); listed.add(p) }
  }
  for (const id of [...motifIds].sort()) {
    if (!isPortableSegment(id) || id.startsWith('.')) continue
    await listEntry(fs, l.join(dir, PROJECT_MOTIFS_DIR, id), [PROJECT_MOTIFS_DIR, id], false, l, out)
  }
  return out
}

/** After Save As switched folders: copies each of `paths` that is in `from`
 *  but not in `to`. An import that finished while the content was being
 *  copied put its file in `from` after the copy passed it. Never throws: the
 *  folders have already switched, and a file that fails shows as missing. */
export async function copyLateFiles(from: string, to: string, paths: readonly ProjectPath[], fs: ProjectContentFs, platform: PathPlatform = process.platform): Promise<void> {
  const l = pathLib(platform)
  for (const p of paths) {
    try {
      const dst = toNative(to, p, platform)
      if (await lstatOrNull(fs, dst)) continue
      const src = toNative(from, p, platform)
      const st = await lstatOrNull(fs, src)
      if (!st?.isFile()) continue
      await fs.mkdir(l.dirname(dst), { recursive: true })
      await placeFile(fs, src, dst, st, true, l)
    } catch (error) {
      console.warn('[project] a media file was not copied to the saved folder', p, error)
    }
  }
}

/** A planned copy that left its target without a file. */
export interface MissingFile { path: string; diagnostic: string }

/** Carries out a schema upgrade's file plans in the folder `dir`, each at
 *  most once: a plan whose target is already there is done. A move whose
 *  source is gone is skipped. Never throws: answers the copies that left
 *  their target without a file. */
export async function placeFilePlans(dir: string, plans: readonly FilePlan[], fs: ProjectContentFs, platform: PathPlatform = process.platform): Promise<MissingFile[]> {
  const l = pathLib(platform)
  const missing: MissingFile[] = []
  for (const plan of plans) {
    try {
      let from = toNative(dir, parseProjectPath(plan.from), platform)
      const to = toNative(dir, parseProjectPath(plan.to), platform)
      if (await lstatOrNull(fs, to)) continue
      let source = await lstatOrNull(fs, from)
      if (!source?.isFile() && plan.mode === 'copy' && plan.recorded && l.isAbsolute(plan.recorded)) {
        from = plan.recorded
        source = await lstatOrNull(fs, from).catch(() => null)
      }
      if (!source?.isFile()) {
        if (plan.mode === 'copy') missing.push({ path: plan.to, diagnostic: `${plan.from} is not in the project folder` })
        continue
      }
      await fs.mkdir(l.dirname(to), { recursive: true })
      // Never a link: later syntheses reuse the cached voiceover, and an edit
      // made in place to the project's file would change what they reuse.
      if (plan.mode === 'move') await fs.rename(from, to)
      else await placeFile(fs, from, to, source, false, l)
    } catch (error) {
      if (plan.mode === 'copy') missing.push({ path: plan.to, diagnostic: String(error) })
      else console.warn('[project] planned file move failed', plan, error)
    }
  }
  return missing
}
