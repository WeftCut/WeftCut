// Conversion between a ProjectPath and an OS path. The only place a project path
// meets a path library; src/main/state/projectPath.conformance.test.ts keeps it so.
import path from 'node:path'
import { isProjectPath, projectPathSegments, type ProjectPath } from '../../shared/projectPath'

/** Which path rules to apply: the host's by default, or another OS's in tests. */
export type PathPlatform = NodeJS.Platform | 'posix'

function lib(platform: PathPlatform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The OS path of `p` inside `projectDir`. Never outside it: a ProjectPath has
 *  no `..`, root, drive or separator other than `/`. */
export function toNative(projectDir: string, p: ProjectPath, platform: PathPlatform = process.platform): string {
  return lib(platform).join(projectDir, ...projectPathSegments(p))
}

/** The ProjectPath of an OS path, or null when it is outside `projectDir`, is
 *  the folder itself, or names a segment that is not portable. Refuses rather
 *  than rewrites: a `.` or `..` in `abs`, or a name valid on this OS only, is
 *  null, never a different file. */
export function fromNative(projectDir: string, abs: string, platform: PathPlatform = process.platform): ProjectPath | null {
  const l = lib(platform)
  const sep = platform === 'win32' ? /[\\/]/ : /\//
  if (abs.split(sep).some((seg) => seg === '.' || seg === '..')) return null
  const rel = l.relative(projectDir, abs)
  if (rel === '' || l.isAbsolute(rel)) return null
  const segments = rel.split(l.sep)
  if (segments[0] === '..') return null
  const joined = segments.join('/')
  return isProjectPath(joined) ? joined : null
}
