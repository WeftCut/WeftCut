// apps/desktop/src/main/mcp/argCheck.ts
//
// A light JSON-schema check for the tools whose arguments are parsed in Rust
// or by a hybrid arm — the ones with no TS parser of their own. Without it a
// call missing `text` and `voice` reaches serde and comes back as
// `missing field \`text\` at line 1 column 2`: one field at a time, with the
// column of a buffer the caller never saw. This names every missing or
// mistyped top-level field in one sentence, in the tool's own vocabulary,
// BEFORE anything is dispatched.
//
// Deliberately narrow: `required`, `type`, `enum`, and one level of nested
// `properties`. Not a validator — a field this does not understand passes
// through to the real parser. An explicit `null` on a field that is not
// required reads as omitted: the catalog stopped advertising `['T', 'null']`
// on optional fields (a `null` arm is kept only where null means something of
// its own), and a client that still sends `format: null` deserves the same
// answer as one that leaves it out.

interface SchemaLike {
  required?: string[]
  properties?: Record<string, SchemaLike>
  type?: string | string[]
  enum?: unknown[]
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'object') return 'an object'
  if (typeof v === 'number' && !Number.isFinite(v)) return 'a non-finite number'
  if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 37)}...` : v}"`
  return String(v)
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'boolean': return typeof v === 'boolean'
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    case 'array': return Array.isArray(v)
    case 'null': return v === null
    default: return true // an unknown type word constrains nothing
  }
}

/** Every problem the schema can see in `args`, as sentences. Empty = pass. */
export function schemaProblems(schema: unknown, args: Record<string, unknown>, path = ''): string[] {
  const s = (schema ?? {}) as SchemaLike
  const out: string[] = []
  const at = (k: string): string => (path ? `${path}.${k}` : k)
  const required = s.required ?? []
  for (const r of required) {
    if (args[r] === undefined) out.push(`missing required \`${at(r)}\``)
  }
  for (const [k, prop] of Object.entries(s.properties ?? {})) {
    const v = args[k]
    if (v === undefined || (v === null && !required.includes(k))) continue
    const types = prop.type === undefined ? [] : Array.isArray(prop.type) ? prop.type : [prop.type]
    if (types.length > 0 && !types.some((t) => matchesType(t, v))) {
      const want = types.filter((t) => t !== 'null').map((t) => (t === 'integer' ? 'an integer' : t === 'array' ? 'an array' : t === 'object' ? 'an object' : `a ${t}`)).join(' or ')
      out.push(`\`${at(k)}\` must be ${want}, got ${describe(v)}`)
      continue
    }
    if (Array.isArray(prop.enum) && !prop.enum.includes(v)) {
      out.push(`\`${at(k)}\` must be one of ${prop.enum.filter((e) => e !== null).map((e) => JSON.stringify(e)).join(' | ')}, got ${describe(v)}`)
      continue
    }
    if (prop.properties && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...schemaProblems(prop, v as Record<string, unknown>, at(k)))
    }
  }
  return out
}

/** The one-line refusal for a tool whose args fail the check, or null. */
export function argProblemMessage(tool: string, schema: unknown, args: Record<string, unknown>): string | null {
  const problems = schemaProblems(schema, args)
  if (problems.length === 0) return null
  return `${tool}: ${problems.join('; ')}`
}
