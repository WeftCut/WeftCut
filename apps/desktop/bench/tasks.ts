// apps/desktop/bench/tasks.ts
//
// Task files (bench/tasks/*.json) and the setup-argument templating. The
// format is shared with the fixture and checklist owners; README.md documents
// it for task authors.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SetupCall {
  tool: string
  args: Record<string, unknown>
  /** Names this call's structured result for `{ref:<as>.<field>}` in later
   *  calls. */
  as?: string
}

export interface ChecklistItem {
  id: string
  description: string
  check: unknown
}

export interface BenchTask {
  id: string
  fixtures: string[]
  project: { width: number; height: number; fps: { num: number; den: number } }
  setup: SetupCall[]
  prompt: string
  /** What the stand-in user answers, once, when the agent ends its first
   *  turn having changed nothing — usually a plan waiting for a go-ahead.
   *  Absent: the runner's default; false: never answer (a task where asking
   *  first is the right outcome). */
  go_ahead?: string | false
  checklist: ChecklistItem[]
}

export const TASKS_DIR = fileURLToPath(new URL('./tasks', import.meta.url))

/** Shallow shape check — enough that a typo fails before an app is launched
 *  and a model is paid for, not halfway into setup. */
function parseTask(file: string, json: unknown): BenchTask {
  const t = json as Partial<BenchTask>
  const fail = (why: string): never => { throw new Error(`${file}: ${why}`) }
  if (typeof t.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id)) fail('id must be kebab-case')
  if (!Array.isArray(t.fixtures)) fail('fixtures must be an array (empty for synthetic-only tasks)')
  const p = t.project
  if (!p || !Number.isInteger(p.width) || !Number.isInteger(p.height) || !Number.isInteger(p.fps?.num) || !Number.isInteger(p.fps?.den))
    fail('project needs integer width, height and fps { num, den }')
  if (!Array.isArray(t.setup) || t.setup.some((c) => typeof c?.tool !== 'string')) fail('setup must be an array of { tool, args }')
  if (typeof t.prompt !== 'string' || !t.prompt.trim()) fail('prompt is required')
  if (!Array.isArray(t.checklist)) fail('checklist must be an array')
  return t as BenchTask
}

/** `*` and `?` only — task ids are kebab-case, so nothing richer is needed. */
function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

/** Every task whose id matches one of `selectors` (exact ids or globs), in
 *  file-name order. A selector matching nothing is an error: a misspelt id
 *  must not read as an empty, green bench. */
export function loadTasks(selectors: readonly string[], dir = TASKS_DIR): BenchTask[] {
  const all = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
        .map((f) => parseTask(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    : []
  const picked = new Map<string, BenchTask>()
  for (const selector of selectors) {
    const re = globToRegExp(selector)
    const hits = all.filter((t) => re.test(t.id))
    if (!hits.length) throw new Error(`no task in ${dir} matches '${selector}' (have: ${all.map((t) => t.id).join(', ') || 'none'})`)
    for (const t of hits) picked.set(t.id, t)
  }
  return [...picked.values()]
}

/** One step of a `{ref:…}` path: a field name, or `[key=value]` — the first
 *  array element whose `key` reads as `value`. The selector is what reaches a
 *  track by role (`tracks[role=ARoll].id`) without leaning on list order. */
type RefStep = { field: string } | { where: [string, string] }

function parseRefPath(path: string): RefStep[] {
  const steps: RefStep[] = []
  const re = /\[([^=\]]+)=([^\]]*)\]|([^.[\]]+)|\./gy
  let m: RegExpExecArray | null
  while (re.lastIndex < path.length && (m = re.exec(path))) {
    if (m[1] !== undefined) steps.push({ where: [m[1], m[2] ?? ''] })
    else if (m[3] !== undefined) steps.push({ field: m[3] })
  }
  if (re.lastIndex !== path.length) throw new Error(`{ref:${path}}: cannot parse the path`)
  return steps
}

function walkRef(value: unknown, step: RefStep): unknown {
  if ('field' in step) return (value as Record<string, unknown> | null | undefined)?.[step.field]
  if (!Array.isArray(value)) return undefined
  const [k, v] = step.where
  return value.find((el) => String((el as Record<string, unknown> | null)?.[k]) === v)
}

/** Substitute `{fixture:<id>}` and `{ref:<name>.<path>}` placeholders in a
 *  setup call's args. A string that is exactly one placeholder takes the
 *  referenced value's own type (a numeric field stays a number); one embedded
 *  in longer text is spliced in as a string. */
export function resolveArgs(
  value: unknown,
  fixtures: ReadonlyMap<string, string>,
  refs: ReadonlyMap<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, fixtures, refs))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArgs(v, fixtures, refs)]))
  if (typeof value !== 'string') return value
  const lookup = (kind: string, key: string): unknown => {
    if (kind === 'fixture') {
      const p = fixtures.get(key)
      if (p === undefined) throw new Error(`{fixture:${key}} is not in the task's fixtures list`)
      return p
    }
    const [first, ...rest] = parseRefPath(key)
    if (!first || !('field' in first) || !refs.has(first.field)) throw new Error(`{ref:${key}} names no earlier setup call's \`as\``)
    const field = rest.reduce<unknown>(walkRef, refs.get(first.field))
    if (field === undefined) throw new Error(`{ref:${key}}: the result has no such field (got ${JSON.stringify(refs.get(first.field)).slice(0, 2000)})`)
    return field
  }
  const whole = /^\{(fixture|ref):([^}]+)\}$/.exec(value)
  if (whole) return lookup(whole[1], whole[2])
  return value.replace(/\{(fixture|ref):([^}]+)\}/g, (_, kind: string, key: string) => String(lookup(kind, key)))
}
