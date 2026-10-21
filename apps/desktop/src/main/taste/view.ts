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
import { validateMotifs, validateRoles, validateTokens, type MotifsByRole, type RoleDeclaration, type TasteDiagnostic, type TasteSource, type Tokens } from './schema'
import type { Manifest } from '../../shared/motifs/catalog'

export const DEFAULT_STYLE = 'weftcut-default'

export interface TasteRole { name: string; builtin: boolean; declared_by: 'builtin' | TasteSource; description?: string }

/** What the view says about one Motif a role is drawn with. */
export interface TasteMotif {
  id: string
  name: string
  size: [number, number]
  graphic_role: string | null
  props_schema: Manifest['props_schema']
}

/** A role's Motifs, in preference order, and which file named them. */
export interface TasteRoleMotifs { ids: string[]; source: TasteSource; motifs?: TasteMotif[] }

/** Looks a Motif up in the app's catalog; null when there is none by that id. */
export type MotifLookup = (id: string) => Manifest | null

export interface TasteView {
  style: { name: string; hash: string; origin: 'builtin' | 'user'; pinned: string | null; pin_matches: boolean | null }
  taste: { path: string | null; present: boolean }
  roles: TasteRole[]
  tokens: Tokens
  /** Graphic role → the Motifs the style (or TASTE.md) draws it with. */
  motifs: Record<string, TasteRoleMotifs>
  /** Font slot → which of its families this machine has (with the host's
   *  installed list; absent without one). */
  fonts?: Record<string, { wanted: string[]; resolved: string | null; missing: string[] }>
  /** Dotted token path → the layer that set it. */
  provenance: Record<string, TasteSource>
  prose: { style: string; taste: string | null }
  diagnostics: TasteDiagnostic[]
  /** Changes when the style package or TASTE.md changes. */
  revision: string
}

export interface StyleDirs { builtin: string; user: string | null }

const STYLE_KEYS = ['name', 'version', 'description', 'roles', 'tokens', 'motifs']
const TASTE_KEYS = ['extends', 'roles', 'tokens', 'motifs']

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
    return { roles: [] as RoleDeclaration[], tokens: {} as Tokens, motifs: {} as MotifsByRole }
  }
  unknownKeys(fm.data, STYLE_KEYS, 'style', diagnostics)
  if (fm.data.name !== undefined && fm.data.name !== pkg.name)
    diagnostics.push({ severity: 'warning', source: 'style', path: 'name', message: `name ${String(fm.data.name)} differs from the package folder ${pkg.name}; the folder name is the style's name` })
  const roles = validateRoles(fm.data.roles, 'style', diagnostics)
  const known = new Set<string>([...BUILTIN_GRAPHIC_ROLES, ...roles.map((r) => r.name)])
  return { roles, tokens: validateTokens(fm.data.tokens, 'style', known, diagnostics), motifs: validateMotifs(fm.data.motifs, 'style', known, diagnostics) }
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
  for (const [key, v] of Object.entries(tokens.motif ?? {})) into.set(`motif.${key}`, { value: v, source })
  // A slot's list is replaced whole: a TASTE that names one face means that face.
  for (const [slot, list] of Object.entries(tokens.fonts ?? {})) into.set(`fonts.${slot}`, { value: list, source })
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

/** Each role's Motifs: a TASTE.md list replaces its style's for that role.
 *  With a catalog to look in, an id it does not hold is dropped with a
 *  diagnostic, and the rest carry what the agent needs to place them. */
function mergeMotifs(style: MotifsByRole, taste: MotifsByRole, lookup: MotifLookup | undefined, diagnostics: TasteDiagnostic[]): Record<string, TasteRoleMotifs> {
  const out: Record<string, TasteRoleMotifs> = {}
  for (const [role, ids] of Object.entries({ ...style, ...taste })) {
    const source: TasteSource = role in taste ? 'taste' : 'style'
    if (!lookup) { out[role] = { ids, source }; continue }
    const motifs: TasteMotif[] = []
    for (const id of ids) {
      const m = lookup(id)
      if (!m) { diagnostics.push({ severity: 'error', source, path: `motifs.${role}`, message: `no Motif ${id} in the app's catalog; dropped` }); continue }
      motifs.push({ id, name: m.name, size: m.size, graphic_role: m.graphic_role ?? null, props_schema: m.props_schema })
    }
    if (motifs.length) out[role] = { ids: motifs.map((m) => m.id), source, motifs }
  }
  return out
}

/** The merged view for a project folder (null: no project open, so the
 *  default style alone). Throws only when the default style itself is
 *  missing — a broken install, not an authoring mistake. `motif` looks ids
 *  up in the Motif catalog; without it, role Motifs are listed unchecked. */
export function tasteView(dirs: StyleDirs, projectDir: string | null, opts: { motif?: MotifLookup; fonts?: ReadonlySet<string> | null } = {}): TasteView {
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
  const roleNames = new Set(roles.map((r) => r.name))
  const tasteTokens = data ? validateTokens(data.tokens, 'taste', roleNames, diagnostics) : {}
  const motifs = mergeMotifs(style.motifs, data ? validateMotifs(data.motifs, 'taste', roleNames, diagnostics) : {}, opts.motif, diagnostics)

  const flat = new Map<string, Leaf>()
  leaves(style.tokens, 'style', flat)
  leaves(tasteTokens, 'taste', flat)
  checkColorNames(flat, diagnostics)

  const tokens = unflatten(flat)
  const installed = opts.fonts
  const fonts = installed && tokens.fonts ? Object.fromEntries(Object.entries(tokens.fonts).map(([slot, wanted]) => {
    const has = (f: string) => installed.has(f.toLowerCase())
    return [slot, { wanted, resolved: wanted.find(has) ?? null, missing: wanted.filter((f) => !has(f)) }]
  })) : undefined
  const revision = createHash('sha256').update(pkg.hash).update('\0').update(file && 'text' in file ? file.text : '').digest('hex')
  return {
    style: { name: pkg.name, hash: pkg.hash, origin, pinned: ext.pin, pin_matches: pinMatches },
    taste: { path: file?.path ?? null, present: file !== null },
    roles,
    tokens,
    motifs,
    ...(fonts ? { fonts } : {}),
    provenance: Object.fromEntries([...[...flat].map(([k, l]) => [k, l.source] as const), ...Object.entries(motifs).map(([role, m]) => [`motifs.${role}`, m.source] as const)]),
    prose: { style: pkg.frontmatter.prose, taste: tasteData?.prose || null },
    diagnostics,
    revision,
  }
}
