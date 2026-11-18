// A project path meets a path library in one place only: projectPathNative.ts
// (toNative / fromNative). A `join(dir, path_rel)` elsewhere writes the host's
// separator into a project path or reads a foreign one as a single file name,
// so a project authored on one OS misses its media on another. This repo has
// no linter, so the rule is enforced by reading the source.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/main', 'src/shared', 'src/preload']
const OWNERS = new Set(['src/shared/projectPath.ts', 'src/main/state/projectPathNative.ts'])

/** Files that still convert by hand. The path-hygiene work packages remove
 *  each entry as its file moves onto projectPath; the last test below fails
 *  on an entry that no longer violates, so the list only shrinks. */
const PENDING = [
  'src/main/state/importSource.ts',
  'src/main/state/mediaImport.ts',
  'src/main/state/relink.ts',
]

/** Comments talk about the rule on purpose; only code is under it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The text between the parenthesis at `open` and its match. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/** What a source joins or splits by hand: a `join(`/`resolve(` whose arguments
 *  name `path_rel` or `MEDIA_DIR`, or a path_rel-like value split on an OS
 *  separator. */
function violationsIn(source: string): string[] {
  const src = code(source)
  const found: string[] = []
  for (const m of src.matchAll(/\b(?:join|resolve)\s*\(/g)) {
    const args = argsAt(src, m.index + m[0].length - 1)
    if (/\b(?:path_rel|MEDIA_DIR)\b/.test(args)) found.push(`${m[0]}${args})`)
  }
  for (const m of src.matchAll(/([\w.]+)[!?]?\.split\s*\(/g)) {
    const receiver = m[1]!.split('.').at(-1)!
    if (!/^(?:path_rel|rel|\w*Rel)$/.test(receiver)) continue
    const args = argsAt(src, m.index + m[0].length - 1).trim()
    // A regex, a backslash or a platform `sep` splits on a separator; `'/'`
    // is the project path's own and `'.'` an extension, both fine.
    if (args.startsWith('/') || args.includes('\\') || /\bsep\b/.test(args)) found.push(`${m[0]}${args})`)
  }
  return found
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) return sourceFiles(p)
    return /\.ts$/.test(e.name) && !/\.(?:test|spec|d)\.ts$/.test(e.name) ? [p] : []
  })
}

const VIOLATIONS = new Map(
  ROOTS.flatMap(sourceFiles)
    .filter((f) => !OWNERS.has(f))
    .map((f) => [f, violationsIn(readFileSync(f, 'utf8'))] as const)
    .filter(([, v]) => v.length > 0),
)

describe('project paths convert only through projectPathNative', () => {
  it('the scan recognizes each hand conversion', () => {
    expect(violationsIn('const a = join(dir, item.path_rel)')).toHaveLength(1)
    expect(violationsIn('lib.resolve(\n  dir,\n  pending.path_rel,\n)')).toHaveLength(1)
    expect(violationsIn("path.join(MEDIA_DIR, name)")).toHaveLength(1)
    expect(violationsIn('return rel.split(/[\\\\/]/).pop()')).toHaveLength(1)
    expect(violationsIn('item.path_rel!.split(/\\\\/)')).toHaveLength(1)
    expect(violationsIn('const parts = pathRel.split(path.sep)')).toHaveLength(1)
    expect(violationsIn("const parts = rel.split('/')")).toEqual([])
    expect(violationsIn('const [stem] = rel.split(".")')).toEqual([])
    expect(violationsIn('join(dir, MOTIF_MEDIA_DIR)')).toEqual([])
    expect(violationsIn('// join(dir, path_rel)')).toEqual([])
  })

  it('no file outside the owners joins or splits a path_rel by hand', () => {
    const unexpected = Object.fromEntries([...VIOLATIONS].filter(([f]) => !PENDING.includes(f)))
    expect(unexpected).toEqual({})
  })

  it('every PENDING file still violates', () => {
    expect(PENDING.filter((f) => !VIOLATIONS.has(f))).toEqual([])
  })
})
