// Which file a launch asks WeftCut to open (ADR 0181): read from the command
// line an association builds (Windows `"%1"`, Linux `%U`, a terminal), and from
// the handoff a second launch passes the running app. Only an absolute path
// with an owned extension is a target; anything else asks for nothing.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNED_FILE_TYPES } from './fileTypes.js'

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

/** Whether `file` is an absolute path WeftCut opens on request. On Windows
 *  that is one with a drive or a UNC share: a root without a drive (`\a`)
 *  means the drive of whichever process reads it. */
export function isOpenTarget(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' ? !/^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(file) : !path.posix.isAbsolute(file)) return false
  const lower = file.toLowerCase()
  return OWNED_FILE_TYPES.some((type) => lower.endsWith(`.${type.ext}`))
}

/** The file named on a launch's command line, absolute. Switches are never a
 *  target, so neither Chromium's nor a value one carries counts; the
 *  executable, and the app path of an unpackaged run, have no owned
 *  extension. A `file://` URL (a Linux `%U`) becomes its path; a relative
 *  path resolves against `cwd`. */
export function openTargetFromArgv(argv: readonly string[], cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    let file = arg
    if (arg.startsWith('file:')) {
      try { file = fileURLToPath(arg, { windows: platform === 'win32' }) } catch { continue }
    }
    file = pathFor(platform).resolve(cwd, file)
    if (isOpenTarget(file, platform)) return file
  }
  return null
}

/** What a second launch hands the running app through the single-instance
 *  lock: its own target, resolved where it was launched. Electron passes it
 *  untouched; the argv the running app receives instead has been through
 *  Chromium's switch parsing. */
export function openHandoff(target: string | null): Record<string, string> | undefined {
  return target === null ? undefined : { open: target }
}

/** The target in a second launch's handoff. Another process wrote it, so it
 *  is checked as any outside input is. */
export function openTargetFromHandoff(data: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof data !== 'object' || data === null) return null
  const open = (data as { open?: unknown }).open
  return typeof open === 'string' && isOpenTarget(open, platform) ? open : null
}
