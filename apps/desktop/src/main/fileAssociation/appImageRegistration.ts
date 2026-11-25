// An AppImage has no installer, so it registers WeftCut's file types itself
// (ADR 0181): a MIME package and a desktop entry that opens them with the
// AppImage file, both under the user's XDG data home. The deb registers the
// same types through its package; this runs only for an AppImage.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { nodeAtomicWriteIo, writeFileAtomic } from '../atomicWrite.js'
import { OWNED_FILE_TYPES, type OwnedFileType } from './fileTypes.js'

/** Named apart from the deb's `WeftCut.desktop`: a per-user entry of the same
 *  name would replace the deb's launcher with the AppImage. */
export const APPIMAGE_DESKTOP_FILE = 'weftcut-appimage.desktop'
const MIME_PACKAGE_FILE = 'weftcut-appimage.xml'

export interface AppImageRegistrationIo {
  /** null when the file does not exist. */
  readText(file: string): string | null
  /** Creates the folders it needs. */
  writeText(file: string, text: string): void
  /** Last modification in ms since the epoch; null when the file does not exist. */
  modifiedMs(file: string): number | null
  /** The cache tools that make a written file take effect. */
  run(command: string, args: readonly string[]): Promise<void>
}

export interface AppImageRegistrationTarget {
  /** `$APPIMAGE`: the file the user runs, not its mount. */
  appImage: string
  /** The XDG data home (`$XDG_DATA_HOME`, else `~/.local/share`). */
  dataHome: string
  /** An icon for the entry, outside the AppImage's mount; null for none. */
  icon: string | null
}

/** The XDG data home the spec names: `$XDG_DATA_HOME` when absolute, else
 *  `~/.local/share`. */
export function xdgDataHome(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.XDG_DATA_HOME
  return configured && path.posix.isAbsolute(configured) ? configured : path.posix.join(home, '.local', 'share')
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function mimePackage(types: readonly OwnedFileType[] = OWNED_FILE_TYPES): string {
  const entries = types.map((type) => [
    `  <mime-type type="${xml(type.mime)}">`,
    `    <comment>${xml(type.description)}</comment>`,
    `    <glob pattern="*.${xml(type.ext)}"/>`,
    '    <generic-icon name="x-office-document"/>',
    '  </mime-type>',
  ].join('\n'))
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">', ...entries, '</mime-info>', ''].join('\n')
}

/** One quoted argument of an `Exec` key. The desktop entry spec escapes in two
 *  layers: `"`, `` ` ``, `$` and `\` inside the quotes, then every `\` again
 *  as a string value; `%` is a field code unless doubled. */
export function desktopExecArgument(file: string): string {
  const quoted = file.replace(/[\\"`$]/g, (c) => `\\${c}`)
  return `"${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`
}

const desktopString = (text: string) => text.replace(/\\/g, '\\\\')

/** The entry that opens the owned types with `appImage`. `NoDisplay`: it is a
 *  handler, not a launcher in the application menu. */
export function desktopEntry(appImage: string, icon: string | null, types: readonly OwnedFileType[] = OWNED_FILE_TYPES): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=WeftCut',
    `Exec=${desktopExecArgument(appImage)} %U`,
    ...(icon === null ? [] : [`Icon=${desktopString(icon)}`]),
    `MimeType=${types.map((type) => `${type.mime};`).join('')}`,
    'NoDisplay=true',
    'Terminal=false',
    '',
  ].join('\n')
}

/** Writes the MIME package and the desktop entry where they differ from what
 *  is there, then refreshes each cache missing or older than the file it
 *  reads, so a refresh that failed or found no tool is retried next start.
 *  Answers whether anything was written. A path a desktop entry cannot hold (a
 *  control character) registers nothing. */
export async function registerAppImageFileTypes(target: AppImageRegistrationTarget, io: AppImageRegistrationIo): Promise<boolean> {
  const unsafe = /[\u0000-\u001f\u007f]/
  if (unsafe.test(target.appImage) || (target.icon !== null && unsafe.test(target.icon))) return false
  const mimeDir = path.posix.join(target.dataHome, 'mime')
  const applicationsDir = path.posix.join(target.dataHome, 'applications')
  const files = [
    { file: path.posix.join(mimeDir, 'packages', MIME_PACKAGE_FILE), text: mimePackage(), cache: path.posix.join(mimeDir, 'mime.cache'), refresh: ['update-mime-database', mimeDir] },
    { file: path.posix.join(applicationsDir, APPIMAGE_DESKTOP_FILE), text: desktopEntry(target.appImage, target.icon), cache: path.posix.join(applicationsDir, 'mimeinfo.cache'), refresh: ['update-desktop-database', applicationsDir] },
  ] as const
  const changed = files.filter(({ file, text }) => io.readText(file) !== text)
  for (const { file, text } of changed) io.writeText(file, text)
  const stale = files.filter(({ file, cache }) => {
    const cached = io.modifiedMs(cache)
    return cached === null || cached < (io.modifiedMs(file) ?? Infinity)
  })
  await Promise.all(stale.map(({ refresh: [command, dir] }) => io.run(command, [dir]).catch(() => {})))
  return changed.length > 0
}

const nodeIo: AppImageRegistrationIo = {
  readText(file) {
    try { return fs.readFileSync(file, 'utf8') } catch { return null }
  },
  writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(nodeAtomicWriteIo, file, text)
  },
  modifiedMs(file) {
    try { return fs.statSync(file).mtimeMs } catch { return null }
  },
  run: (command, args) => new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()))
  }),
}

/** Registers the AppImage this process runs from (`$APPIMAGE`); null when it
 *  runs from none. The icon is copied out of the AppImage's mount (`$APPDIR`),
 *  which is gone once the app exits, into `userDataDir`. */
export function registerRunningAppImage(env: NodeJS.ProcessEnv, home: string, userDataDir: string): Promise<boolean> | null {
  const appImage = env.APPIMAGE
  if (!appImage || !path.posix.isAbsolute(appImage)) return null
  return registerAppImageFileTypes({ appImage, dataHome: xdgDataHome(env, home), icon: copyIcon(env.APPDIR, userDataDir) }, nodeIo)
}

function copyIcon(appDir: string | undefined, userDataDir: string): string | null {
  if (!appDir) return null
  try {
    const bytes = fs.readFileSync(path.posix.join(appDir, '.DirIcon'))
    const icon = path.posix.join(userDataDir, 'appimage-icon.png')
    if (!(fs.existsSync(icon) && fs.readFileSync(icon).equals(bytes))) fs.writeFileSync(icon, bytes)
    return icon
  } catch {
    return null
  }
}
