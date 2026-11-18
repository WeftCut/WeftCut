// The one value type for a path inside a project folder: `/`-separated,
// relative, every segment a valid name on every OS. The conversion to and from
// an OS path lives in main (src/main/state/projectPathNative.ts) because this
// tree builds without Node types. Rust twin: native/src/state/project_path.rs;
// both test against fixtures/project-paths.json.

declare const projectPathBrand: unique symbol
/** A path relative to the project folder that passed `parseProjectPath`. */
export type ProjectPath = string & { readonly [projectPathBrand]: true }

/** Per-segment byte cap of NTFS, APFS and ext4. */
const MAX_SEGMENT_BYTES = 255

const utf8 = new TextEncoder()

/** Why one name is not valid on every OS, or null when it is. */
function segmentProblem(seg: string): string | null {
  if (seg === '') return 'empty segment'
  if (seg === '.' || seg === '..') return `"${seg}" segment`
  if (/[\\/]/.test(seg)) return 'separator inside a segment'
  if (/[\x00-\x1f]/.test(seg)) return 'control character'
  if (/[<>:"|?*]/.test(seg)) return 'reserved character'
  if (/[. ]$/.test(seg)) return 'trailing dot or space'
  // Windows resolves these names to devices whatever the extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(seg)) return 'device name'
  if (/^[\x20-\x7e]*$/.test(seg)) return seg.length > MAX_SEGMENT_BYTES ? `segment over ${MAX_SEGMENT_BYTES} bytes` : null
  if (seg.normalize('NFC') !== seg) return 'not NFC'
  if (utf8.encode(seg).length > MAX_SEGMENT_BYTES) return `segment over ${MAX_SEGMENT_BYTES} bytes`
  return null
}

/** Whether one file or folder name is valid on every OS. Producers normalize to
 *  NFC first: a non-NFC name is refused, never rewritten. */
export function isPortableSegment(seg: string): boolean {
  return segmentProblem(seg) === null
}

function pathProblem(s: string): string | null {
  if (s === '') return 'empty'
  if (s.includes('\\')) return 'backslash'
  for (const seg of s.split('/')) {
    const why = segmentProblem(seg)
    if (why) return why
  }
  return null
}

/** The path as a `ProjectPath`; throws an Error naming the rule it breaks. */
export function parseProjectPath(s: string): ProjectPath {
  const why = pathProblem(s)
  if (why) throw new Error(`Invalid project path ${JSON.stringify(s)}: ${why}`)
  return s as ProjectPath
}

export function isProjectPath(s: string): s is ProjectPath {
  return pathProblem(s) === null
}

/** The path naming `segments` in order; throws when there are none or one is not
 *  a portable name (a `/` inside a segment included). */
export function projectPathOf(...segments: string[]): ProjectPath {
  if (segments.length === 0) throw new Error('Invalid project path: no segments')
  for (const seg of segments) {
    const why = segmentProblem(seg)
    if (why) throw new Error(`Invalid project path segment ${JSON.stringify(seg)}: ${why}`)
  }
  return segments.join('/') as ProjectPath
}

export function projectPathSegments(p: ProjectPath): string[] {
  return p.split('/')
}

/** The last segment: the file or folder name. */
export function projectPathBase(p: ProjectPath): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** The comparison key for a case-only collision on a case-insensitive volume
 *  (Windows, macOS). `toLowerCase`, never `toLocaleLowerCase`: the fold must
 *  match the Rust twin's `to_lowercase` whatever the machine's locale. */
export function foldCase(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** The folder every imported file is copied into. */
export const MEDIA: ProjectPath = projectPathOf('Media')
