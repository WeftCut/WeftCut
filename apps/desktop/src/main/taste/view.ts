// apps/desktop/src/main/taste/view.ts
//
// The merged taste a project is in: its style's tokens with the project's
// TASTE.md overrides on top, each leaf carrying where it came from. This is
// what `project://taste` serves and what layer creation and the lint read
// (spec H1-D2). The app never writes TASTE.md; it only reads and reports.
//
// Merge depth is fixed by the schema, not by the data: palette entries, each
// role's text fields, caption fields and floors merge one key at a time;
// `outline`, `shadow`, `position` and `anchor` are whole values, so a TASTE
// that sets an outline width alone does not inherit a colour it never chose.

import { createHash } from 'node:crypto'
import { BUILTIN_GRAPHIC_ROLES } from '../../shared/graphicRole'
import { listStyleDirs, readStylePackage, readTasteFile, type StylePackage } from './packages'
import { validateRoles, validateTokens, type RoleDeclaration, type TasteDiagnostic, type TasteSource, type Tokens } from './schema'

export const DEFAULT_STYLE = 'weftcut-default'

export interface TasteRole { name: string; builtin: boolean; declared_by: 'builtin' | TasteSource; description?: string }

export interface TasteView {
  style: { name: string; hash: string; origin: 'builtin' | 'user'; pinned: string | null; pin_matches: boolean | null }
  taste: { path: string | null; present: boolean }
  roles: TasteRole[]
  tokens: Tokens
  /** Dotted token path → the layer that set it. */
  provenance: Record<string, TasteSource>
  prose: { style: string; taste: string | null }
  diagnostics: TasteDiagnostic[]
  /** Changes when the style package or TASTE.md changes. */
  revision: string
}

export interface StyleDirs { builtin: string; user: string | null }

const STYLE_KEYS = ['name', 'version', 'description', 'roles', 'tokens']
const TASTE_KEYS = ['extends', 'roles', 'tokens']

type Located = { pkg: StylePackage; origin: 'builtin' | 'user' }

/** Built-ins shadow user packages of the same name: `weftcut-default` always
 *  means the shipped one. */
export function findStyle(dirs: StyleDirs, name: string): Located | null {
  const builtin = listStyleDirs(dirs.builtin).get(name)
  if (builtin) { const pkg = readStylePackage(builtin); return pkg ? { pkg, origin: 'builtin' } : null }
  const user = listStyleDirs(dirs.user).get(name)
  if (user) { const pkg = readStylePackage(user); return pkg ? { pkg, origin: 'user' } : null }
  return null
}

export function listStyles(dirs: StyleDirs): Array<{ name: string; origin: 'builtin' | 'user' }> {
  const builtin = listStyleDirs(dirs.builtin)
  return [...[...builtin.keys()].map((name) => ({ name, origin: 'builtin' as const })),
    ...[...listStyleDirs(dirs.user).keys()].filter((n) => !builtin.has(n)).map((name) => ({ name, origin: 'user' as const }))]
}

function unknownKeys(data: Record<string, unknown>, known: string[], source: TasteSource, diagnostics: TasteDiagnostic[]) {
  for (const k of Object.keys(data)) if (!known.includes(k)) diagnostics.push({ severity: 'warning', source, path: k, message: 'unknown frontmatter key; ignored' })
}

/** Read one package's roles and tokens. A diagnostic here is the style
 *  author's; the view still serves whatever validated. */
function styleLayer(pkg: StylePackage, diagnostics: TasteDiagnostic[]) {
  const fm = pkg.frontmatter
  if (fm.error || !fm.data) {
    diagnostics.push({ severity: 'error', source: 'style', message: `${pkg.name}/STYLE.md: ${fm.error ?? 'no frontmatter'}` })
    return { roles: [] as RoleDeclaration[], tokens: {} as Tokens }
  }
  unknownKeys(fm.data, STYLE_KEYS, 'style', diagnostics)
  if (fm.data.name !== undefined && fm.data.name !== pkg.name)
    diagnostics.push({ severity: 'warning', source: 'style', path: 'name', message: `name ${String(fm.data.name)} differs from the package folder ${pkg.name}; the folder name is the style's name` })
  const roles = validateRoles(fm.data.roles, 'style', diagnostics)
  const known = new Set<string>([...BUILTIN_GRAPHIC_ROLES, ...roles.map((r) => r.name)])
  return { roles, tokens: validateTokens(fm.data.tokens, 'style', known, diagnostics) }
}

/** `name` or `name@<hex>`; the hex is a prefix of the package hash. */
function parseExtends(raw: unknown, diagnostics: TasteDiagnostic[]): { name: string; pin: string | null } {
  if (raw === undefined) return { name: DEFAULT_STYLE, pin: null }
  const m = typeof raw === 'string' ? /^([a-z0-9][a-z0-9_-]{0,63})(?:@([0-9a-f]{8,64}))?$/.exec(raw) : null
  if (!m) {
    diagnostics.push({ severity: 'error', source: 'taste', path: 'extends', message: `expected <style> or <style>@<hash>; using ${DEFAULT_STYLE}` })
    return { name: DEFAULT_STYLE, pin: null }
  }
  return { name: m[1]!, pin: m[2] ?? null }
}

type Leaf = { value: unknown; source: TasteSource }

/** Flatten tokens to dotted leaves at the schema's merge depth. */
function leaves(tokens: Tokens, source: TasteSource, into: Map<string, Leaf>) {
  for (const [name, c] of Object.entries(tokens.palette ?? {})) into.set(`palette.${name}`, { value: c, source })
  for (const [role, block] of Object.entries(tokens.text ?? {}))
    for (const [k, v] of Object.entries(block)) into.set(`text.${role}.${k}`, { value: v, source })
  for (const [k, v] of Object.entries(tokens.caption ?? {})) into.set(`caption.${k}`, { value: v, source })
  for (const [rule, n] of Object.entries(tokens.floors ?? {})) into.set(`floors.${rule}`, { value: n, source })
}

function unflatten(flat: Map<string, Leaf>): Tokens {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, { value }] of flat) {
    const parts = key.split('.')
    const group = (out[parts[0]!] ??= {})
    if (parts[0] === 'text') ((group[parts[1]!] ??= {}) as Record<string, unknown>)[parts[2]!] = value
    else group[parts[1]!] = value
  }
  return out as Tokens
}

const COLOR_FIELDS = new Set(['color'])

/** Palette names must resolve against the merged palette; an unresolved one
 *  is dropped so consumers never see a colour they cannot paint. */
function checkColorNames(flat: Map<string, Leaf>, diagnostics: TasteDiagnostic[]) {
  const named = (v: unknown) => typeof v === 'string' && !v.startsWith('#')
  for (const [key, leaf] of [...flat]) {
    const field = key.split('.').pop()!
    const refs: string[] = []
    if (COLOR_FIELDS.has(field) && named(leaf.value)) refs.push(leaf.value as string)
    if ((field === 'outline' || field === 'shadow') && leaf.value && named((leaf.value as { color: unknown }).color))
      refs.push((leaf.value as { color: string }).color)
    for (const ref of refs) if (!flat.has(`palette.${ref}`)) {
      diagnostics.push({ severity: 'error', source: leaf.source, path: `tokens.${key}`, message: `palette has no colour named ${ref}` })
      flat.delete(key)
    }
  }
}

/** The merged view for a project folder (null: no project open, so the
 *  default style alone). Throws only when the default style itself is
 *  missing — a broken install, not an authoring mistake. */
export function tasteView(dirs: StyleDirs, projectDir: string | null): TasteView {
  const diagnostics: TasteDiagnostic[] = []
  const file = readTasteFile(projectDir)
  const tasteData = file && 'frontmatter' in file ? file.frontmatter : null
  if (file && 'error' in file) diagnostics.push({ severity: 'error', source: 'taste', message: `TASTE.md: ${file.error}` })
  if (tasteData?.error) diagnostics.push({ severity: 'error', source: 'taste', message: `TASTE.md: ${tasteData.error}; using its style alone` })
  const data = tasteData?.data ?? null
  if (data) unknownKeys(data, TASTE_KEYS, 'taste', diagnostics)

  const ext = parseExtends(data?.extends, diagnostics)
  let located = findStyle(dirs, ext.name)
  if (!located) {
    diagnostics.push({ severity: 'error', source: 'taste', path: 'extends', message: `no style named ${ext.name}; using ${DEFAULT_STYLE}` })
    located = findStyle(dirs, DEFAULT_STYLE)
  }
  if (!located) throw new Error(`the built-in style ${DEFAULT_STYLE} is missing from ${dirs.builtin}`)
  const { pkg, origin } = located
  const pinMatches = ext.pin === null || pkg.name !== ext.name ? null : pkg.hash.startsWith(ext.pin)
  if (pinMatches === false)
    diagnostics.push({ severity: 'warning', source: 'taste', path: 'extends', message: `pinned ${ext.name}@${ext.pin}, but the installed package is @${pkg.hash.slice(0, 12)}; its tokens may have changed since this project pinned it` })

  const style = styleLayer(pkg, diagnostics)
  const tasteRoles = data ? validateRoles(data.roles, 'taste', diagnostics) : []
  const roles: TasteRole[] = [
    ...BUILTIN_GRAPHIC_ROLES.map((name) => ({ name, builtin: true, declared_by: 'builtin' as const })),
    ...style.roles.map((r) => ({ ...r, builtin: false, declared_by: 'style' as const })),
    ...tasteRoles.filter((r) => !style.roles.some((s) => s.name === r.name)).map((r) => ({ ...r, builtin: false, declared_by: 'taste' as const })),
  ]
  const tasteTokens = data ? validateTokens(data.tokens, 'taste', new Set(roles.map((r) => r.name)), diagnostics) : {}

  const flat = new Map<string, Leaf>()
  leaves(style.tokens, 'style', flat)
  leaves(tasteTokens, 'taste', flat)
  checkColorNames(flat, diagnostics)

  const revision = createHash('sha256').update(pkg.hash).update('\0').update(file && 'text' in file ? file.text : '').digest('hex')
  return {
    style: { name: pkg.name, hash: pkg.hash, origin, pinned: ext.pin, pin_matches: pinMatches },
    taste: { path: file?.path ?? null, present: file !== null },
    roles,
    tokens: unflatten(flat),
    provenance: Object.fromEntries([...flat].map(([k, l]) => [k, l.source])),
    prose: { style: pkg.frontmatter.prose, taste: tasteData?.prose || null },
    diagnostics,
    revision,
  }
}
