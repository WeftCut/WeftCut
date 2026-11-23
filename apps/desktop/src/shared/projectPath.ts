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
const bytes = (s: string) => utf8.encode(s).length

/** A name Windows opens as a device: `NUL`, `nul.mp4` and `nul.x.y` alike, so
 *  it is tested on the part before the first `.`. */
const DEVICE_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i

/** Why one name is not valid on every OS, or null when it is. */
function segmentProblem(seg: string): string | null {
  if (seg === '') return 'empty segment'
  if (seg === '.' || seg === '..') return `"${seg}" segment`
  if (/[\\/]/.test(seg)) return 'separator inside a segment'
  if (/[\x00-\x1f]/.test(seg)) return 'control character'
  if (/[<>:"|?*]/.test(seg)) return 'reserved character'
  if (/[. ]$/.test(seg)) return 'trailing dot or space'
  if (DEVICE_STEM.test(seg.split('.')[0]!)) return 'device name'
  if (/^[\x20-\x7e]*$/.test(seg)) return seg.length > MAX_SEGMENT_BYTES ? `segment over ${MAX_SEGMENT_BYTES} bytes` : null
  if (seg.normalize('NFC') !== seg) return 'not NFC'
  if (bytes(seg) > MAX_SEGMENT_BYTES) return `segment over ${MAX_SEGMENT_BYTES} bytes`
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

/** A portable file name for `name` that no existing name takes. `taken`
 *  receives a candidate already passed through `foldCase` and answers whether
 *  a name with that folded form exists (on disk or reserved).
 *
 *  Rewrites what a project path refuses: reserved and control characters
 *  become `_`, a trailing `.`/space goes, a device stem gains `_` (`CON.mp4` →
 *  `CON_.mp4`), nothing left becomes `media`, and the name is cut to 255 bytes
 *  keeping its extension. A taken name gets `-2`, `-3`… before the extension.
 *  Must stay identical to Rust `portable_file_name`; both pass the
 *  `portableFileName` vectors of `fixtures/project-paths.json`. */
export function portableFileName(name: string, taken: (folded: string) => boolean): string {
  const [stem, ext] = splitExt(cleanName(name))
  for (let n = 1; ; n++) {
    const candidate = fit(stem, n === 1 ? '' : `-${n}`, ext)
    if (!taken(foldCase(candidate))) return candidate
  }
}

/** `name` with every refused form rewritten; not yet length-capped. */
function cleanName(name: string): string {
  const trimmed = name.normalize('NFC').replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (trimmed === '') return 'media'
  const stem = trimmed.split('.')[0]!
  return DEVICE_STEM.test(stem) ? `${stem}_${trimmed.slice(stem.length)}` : trimmed
}

/** Splits off the last `.ext`. An extension over half the cap counts as stem,
 *  so cutting the stem for the cap always leaves a long, non-device stem. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 && bytes(name.slice(dot)) <= MAX_SEGMENT_BYTES / 2 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

/** `stem + suffix + ext` within the cap, the stem cut between characters. */
function fit(stem: string, suffix: string, ext: string): string {
  let budget = MAX_SEGMENT_BYTES - bytes(suffix) - bytes(ext)
  let cut = ''
  for (const ch of stem) {
    budget -= bytes(ch)
    if (budget < 0) break
    cut += ch
  }
  // A cut with no extension can end in `.`/space or leave a device stem.
  return cleanName(cut + suffix + ext)
}

/** The folder every imported file is copied into. */
export const MEDIA: ProjectPath = projectPathOf('Media')
