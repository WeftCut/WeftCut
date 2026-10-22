// apps/desktop/src/main/state/__tests__/mcp.skill-conformance.test.ts
// Anti-drift gate for the shipped agent-skill sources.
//
// The skill bundle (repo-root skills/weftcut/ + docs/motif-authoring.md, staged
// by scripts/build-skills.mjs) name-drops MCP tools, resources, and prompts in
// backticks. Those files ship to end users' agents, so a rename that leaves a
// stale name behind teaches every connected agent to call something that no
// longer exists — silently. This suite pins every backticked reference to the
// advertised catalog, the same fixture-plus-TS-tables union the bijection gate
// uses (REGEN-FREE: no napi addon at test time).
//
// Contract for prose authors: a bare backticked `snake_case` token in these
// files is an MCP tool name unless it is listed in KNOWN_NON_TOOLS below.
// Adding prose that backticks a new non-tool identifier means adding it there —
// that friction is the point, it is what makes renames fail loudly.
// URI references likewise require catalog membership or an exact entry in
// KNOWN_NON_MCP_URIS for application URLs that are not MCP resources.
// Recipe stage and signal names are the harness's own closed vocabulary
// (src/shared/harness.ts) and pass as references to it.
//
// The skill's layer folders are scanned the same way, and every
// recipes/<name>.md must compose stages and signals from that vocabulary
// (ADR 0123): a recipe naming anything else fails here.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { EXPORT_TOOL_DEFS } from '../../mcp/exportTools'
import { MOTIF_TOOL_DEFS, MOTIF_RESOURCE_DEFS } from '../../mcp/motifToolDefs'
import { HOST_RESOURCE_DEFS } from '../../mcp/hostResources'
import { parse as parseYaml } from 'yaml'
import { MAX_ROUNDS, SIGNALS, STAGES } from '../../../shared/harness'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const CRAFT_DIR = path.join(repoRoot, 'skills/weftcut/craft')
const RECIPES_DIR = path.join(repoRoot, 'skills/weftcut/recipes')
const markdownIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f))
const SKILL_SOURCES = [
  path.join(repoRoot, 'skills/weftcut/SKILL.md'),
  path.join(repoRoot, 'docs/motif-authoring.md'),
  path.join(repoRoot, 'docs/motif-workspaces.md'),
  path.join(repoRoot, 'docs/motif-three-model.md'),
  ...markdownIn(CRAFT_DIR),
  ...markdownIn(RECIPES_DIR),
]
const RECIPE_FILES = markdownIn(RECIPES_DIR).filter((f) => path.basename(f) !== 'README.md')
const HARNESS_WORDS = new Set<string>([...STAGES, ...SIGNALS])

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string }>
  resources: Array<{ uri: string }>
  prompts: Array<{ name: string }>
}
const toolNames = new Set([
  ...rust.tools.map((t) => t.name),
  ...MCP_TOOL_DEFS.map((d) => d.name),
  ...MOTIF_TOOL_DEFS.map((d) => d.name),
  ...EXPORT_TOOL_DEFS.map(d => d.name),
])
const resourceUris = new Set([
  ...rust.resources.map((r) => r.uri),
  ...MOTIF_RESOURCE_DEFS.map((r) => r.uri),
  ...HOST_RESOURCE_DEFS.map((r) => r.uri),
])
const promptNames = new Set(rust.prompts.map((p) => p.name))

// Backticked snake_case tokens in the skill sources that are NOT tool names:
// manifest fields, props_schema variants, lifecycle identifiers, tool params.
// Every entry must occur in the sources (pruned below) and must never collide
// with a live tool name (checked below).
const KNOWN_NON_TOOLS = new Set([
  'request_id', 'awaiting_retry', 'output_path', 'filename',
  // SKILL.md — tool params
  'pad_us', 't_start_us', 'segments', 'word_timing', 'source_us', 'playback_rate', 'time_fraction', 't_local_us', 'preset_id', 'src_out_us',
  // SKILL.md — fields of a mutator's committed record (mcp-results.ts)
  'adjusted', 'siblings',
  // SKILL.md — tack feedback: a mutating call's and end_agent_session's
  // result fields (activity.ts, server.ts)
  'affected_tacks', 'tacks_to_review',
  // SKILL.md — the MCP protocol method whose `instructions` the head mirrors
  'initialize',
  // motif-authoring.md — manifest fields
  'id', 'version', 'name', 'size', 'default_duration_s', 'max_duration_s',
  'max_duration_prop', 'content_duration_s', 'settle_rafs', 'fonts',
  'props_schema', 'graphic_role',
  // motif-authoring.md — props_schema variants + their constraint fields
  'string', 'color', 'number', 'enum', 'default', 'max_length', 'multiline',
  'min', 'max', 'options',
  // motif-authoring.md — lifecycle / code identifiers
  'motif', 'setup', 'ctx', 't', 'duration', 'await', 'bg_color',
  // motif-authoring.md — npm package example and private draft metadata file
  'three', 'target', 'model', 'eval',
  // motif-authoring.md — the Style Motif props a leaving Motif declares (ADR 0130)
  'duration_s', 'exit',
  // The `media` prop variant and its frame time (ADR 0132).
  'media', 't_us',
  // TASTE.md pace tokens (`tokens.pace`), named in the recipe and craft/rules.md.
  'beat_every_s', 'bare_talk_max_s', 'scenes_per_min',
  // SKILL.md — Text entrance/exit patch fields
  'intro', 'outro',
  // SKILL.md, motif-workspaces.md — update_motif_files partial-edit fields
  'edits', 'old', 'new',
  // craft/rules.md — finding severities and the caption tokens that tighten rules
  'hard', 'warning', 'review', 'max_chars_per_line', 'max_lines', 'min_cue_s', 'max_cue_s',
  // recipes/README.md — recipe frontmatter keys
  'description', 'stages', 'until',
])

// Exact examples only: do not exempt entire schemes and hide misspelled URIs.
const KNOWN_NON_MCP_URIS = new Set([
  // Electron's local Motif asset protocol, not an MCP resource (ADR 0079).
  'motif://<id>/',
])

const BARE_IDENT = /^[a-z][a-z0-9_]*$/
const URI = /^[a-z]+:\/\//

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
}

describe('shipped skill sources ↔ MCP catalog (anti-drift gate)', () => {
  const byFile = SKILL_SOURCES.map((file) => ({
    file: path.relative(repoRoot, file),
    tokens: backticked(readFileSync(file, 'utf8')),
  }))
  const allTokens = byFile.flatMap((f) => f.tokens)

  it('every bare backticked identifier is an advertised tool or a known non-tool', () => {
    const offenders = byFile.flatMap(({ file, tokens }) =>
      tokens
        .filter((t) => BARE_IDENT.test(t))
        .filter((t) => !toolNames.has(t) && !KNOWN_NON_TOOLS.has(t) && !HARNESS_WORDS.has(t))
        .map((t) => `${file}: \`${t}\``),
    )
    // A hit here is either a renamed/removed tool still referenced by the
    // shipped prose (fix the prose), or new prose backticking a non-tool
    // identifier (add it to KNOWN_NON_TOOLS).
    expect(offenders).toEqual([])
  })

  it('every backticked URI is an advertised resource or a known non-MCP URL', () => {
    const offenders = byFile.flatMap(({ file, tokens }) =>
      tokens
        .filter((t) => URI.test(t))
        .filter((t) => !resourceUris.has(t) && !KNOWN_NON_MCP_URIS.has(t))
        .map((t) => `${file}: \`${t}\``),
    )
    expect(offenders).toEqual([])
  })

  it('every backticked /slash reference is an advertised prompt', () => {
    const offenders = byFile.flatMap(({ file, tokens }) =>
      tokens
        .filter((t) => /^\/[a-z-]+$/.test(t))
        .filter((t) => !promptNames.has(t.slice(1)))
        .map((t) => `${file}: \`${t}\``),
    )
    expect(offenders).toEqual([])
  })

  it('the extraction is alive: the sources still reference a healthy number of tools', () => {
    // Guards the gate itself — an extraction regression (or a gutted SKILL.md)
    // would otherwise pass every membership test vacuously.
    const referenced = new Set(allTokens.filter((t) => toolNames.has(t)))
    expect(referenced.size).toBeGreaterThanOrEqual(15)
  })

  it('KNOWN_NON_TOOLS carries no dead entries and no tool-name collisions', () => {
    const present = new Set(allTokens)
    expect([...KNOWN_NON_TOOLS].filter((t) => !present.has(t))).toEqual([])
    // A collision means prose ambiguity: a token the gate can no longer tell
    // apart from a tool reference. Rename one side.
    expect([...KNOWN_NON_TOOLS].filter((t) => toolNames.has(t))).toEqual([])
  })

  it('stage and signal names collide with no tool and no known non-tool', () => {
    // Either collision would let a backticked word pass as the wrong thing.
    expect([...HARNESS_WORDS].filter((w) => toolNames.has(w) || KNOWN_NON_TOOLS.has(w))).toEqual([])
  })

  it('KNOWN_NON_MCP_URIS carries no dead entries and no resource-URI collisions', () => {
    const present = new Set(allTokens)
    expect([...KNOWN_NON_MCP_URIS].filter((uri) => !present.has(uri))).toEqual([])
    expect([...KNOWN_NON_MCP_URIS].filter((uri) => resourceUris.has(uri))).toEqual([])
  })
})

// ── Recipes: stages and signals from the closed catalog ─────────────────────

const RECIPE_KEYS = ['name', 'description', 'stages', 'until']
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const RECIPE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const STAGE_LIST: readonly string[] = STAGES
const SIGNAL_LIST: readonly string[] = SIGNALS

type UntilToken = { kind: 'join' | 'cmp' | 'num' | 'ident'; text: string }

/// The tokens of an `until` expression, or the text from the first character
/// no token accepts.
function tokenizeUntil(expr: string): UntilToken[] | { rest: string } {
  const re = /(\|\||&&)|(>=|<=|==|!=|>|<)|(\d+)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/y
  const tokens: UntilToken[] = []
  let i = 0
  while (i < expr.length) {
    if (/\s/.test(expr[i]!)) {
      i++
      continue
    }
    re.lastIndex = i
    const m = re.exec(expr)
    if (!m) return { rest: expr.slice(i) }
    const kind = m[1] ? 'join' : m[2] ? 'cmp' : m[3] ? 'num' : 'ident'
    tokens.push({ kind, text: m[0] })
    i = re.lastIndex
  }
  return tokens
}

function splitOn(tokens: UntilToken[], join: string): UntilToken[][] {
  const parts: UntilToken[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'join' && t.text === join) parts.push([])
    else parts[parts.length - 1]!.push(t)
  }
  return parts
}

/// `until` is an OR of ANDs over boolean signals and `rounds >= N`. One OR
/// branch must be the round bound alone, or nothing guarantees the loop ends.
function checkUntil(expr: string, stages: readonly string[]): string[] {
  const tokens = tokenizeUntil(expr)
  if (!Array.isArray(tokens)) return [`until: cannot read \`${tokens.rest}\``]
  const unknown = tokens.filter((t) => t.kind === 'ident' && !SIGNAL_LIST.includes(t.text))
  if (unknown.length) return unknown.map((t) => `unknown signal \`${t.text}\``)
  const errors: string[] = []
  let bounded = false
  for (const branch of splitOn(tokens, '||').map((b) => splitOn(b, '&&'))) {
    for (const atom of branch) {
      const text = atom.map((t) => t.text).join(' ')
      if (atom.length === 1 && atom[0]!.kind === 'ident' && atom[0]!.text !== 'rounds') {
        // A signal named after a stage can only be observed if that stage runs.
        const stage = atom[0]!.text.split('.')[0]!
        if (STAGE_LIST.includes(stage) && !stages.includes(stage)) {
          errors.push(`\`${atom[0]!.text}\` needs the ${stage} stage`)
        }
      } else if (atom.length === 3 && atom[0]!.text === 'rounds' && atom[1]!.text === '>=' && atom[2]!.kind === 'num') {
        const n = Number(atom[2]!.text)
        if (n < 1 || n > MAX_ROUNDS) errors.push(`\`${text}\`: at most ${MAX_ROUNDS} rounds`)
        else if (branch.length === 1) bounded = true
      } else {
        errors.push(`until: \`${text || '(empty)'}\` is neither a signal nor \`rounds >= N\``)
      }
    }
  }
  if (!bounded) errors.push(`until needs a \`rounds >= N\` branch of its own (N at most ${MAX_ROUNDS})`)
  return errors
}

/// Every way `fileName`'s source departs from the recipe format the shipped
/// recipes/README.md documents; empty when it conforms.
function checkRecipe(fileName: string, source: string): string[] {
  const fm = FRONTMATTER.exec(source)
  if (!fm) return ['no YAML frontmatter']
  let meta: unknown
  try {
    meta = parseYaml(fm[1]!)
  } catch (e) {
    return [`frontmatter is not YAML: ${(e as Error).message}`]
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return ['frontmatter is not a mapping']
  const m = meta as Record<string, unknown>
  const errors: string[] = []
  for (const key of Object.keys(m)) {
    if (!RECIPE_KEYS.includes(key)) errors.push(`unknown frontmatter key \`${key}\``)
  }
  const stem = fileName.replace(/\.md$/, '')
  if (!RECIPE_NAME.test(stem)) errors.push(`\`${fileName}\` is not lowercase words joined by hyphens`)
  if (m.name !== stem) errors.push(`name must be the file name, \`${stem}\``)
  if (typeof m.description !== 'string' || !m.description.trim()) errors.push('description is missing')

  const listed: unknown[] = Array.isArray(m.stages) ? m.stages : []
  if (listed.length === 0) errors.push('stages must be a non-empty list')
  for (const s of listed) {
    if (typeof s !== 'string' || !STAGE_LIST.includes(s)) errors.push(`unknown stage \`${String(s)}\``)
  }
  const stages = listed.filter((s): s is string => typeof s === 'string' && STAGE_LIST.includes(s))
  for (let i = 1; i < stages.length; i++) {
    if (STAGE_LIST.indexOf(stages[i]!) <= STAGE_LIST.indexOf(stages[i - 1]!)) {
      errors.push(`stage \`${stages[i]}\` is repeated or out of catalog order`)
    }
  }

  const hasBuild = stages.includes('build')
  if (m.until === undefined) {
    if (hasBuild) errors.push('a recipe with build needs until, bounded by rounds')
  } else if (typeof m.until !== 'string') {
    errors.push('until must be a string')
  } else if (!hasBuild) {
    errors.push('until without build: there are no rounds to end')
  } else {
    errors.push(...checkUntil(m.until, stages))
  }

  const sections = [...source.slice(fm[0].length).matchAll(/^## +(.+?)\s*$/gm)].map((h) => h[1]!)
  if (sections.join(',') !== stages.join(',')) {
    errors.push(`body sections [${sections.join(', ')}] must be one "## <stage>" per listed stage, in order`)
  }
  return errors
}

/// The backticked list items under a `## heading` of a markdown document.
function listedUnder(md: string, heading: string): string[] {
  const section = md.split(/^## +/m).find((s) => s.startsWith(`${heading}\n`)) ?? ''
  return [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!)
}

describe('shipped recipes compose the closed stage and signal catalog', () => {
  const readme = readFileSync(path.join(RECIPES_DIR, 'README.md'), 'utf8').replace(/\r\n/g, '\n')

  it('both skill layer folders ship a README stating their contract', () => {
    expect(markdownIn(CRAFT_DIR).map((f) => path.basename(f))).toContain('README.md')
    expect(readme).toMatch(/^# Recipes/)
  })

  it('every recipe file names only catalog stages and signals', () => {
    const offenders = RECIPE_FILES.flatMap((f) =>
      checkRecipe(path.basename(f), readFileSync(f, 'utf8')).map((e) => `${path.relative(repoRoot, f)}: ${e}`),
    )
    expect(offenders).toEqual([])
  })

  it('the recipes README lists exactly the catalog, in catalog order', () => {
    expect(listedUnder(readme, 'Stages')).toEqual([...STAGES])
    expect(listedUnder(readme, 'Signals')).toEqual([...SIGNALS])
  })

  it("the README's format example is itself a valid recipe", () => {
    const example = /```markdown\n([\s\S]*?)\n```/.exec(readme)?.[1]
    expect(example).toBeDefined()
    const name = /^name: (.+)$/m.exec(example!)?.[1]
    expect(checkRecipe(`${name}.md`, `${example}\n`)).toEqual([])
  })
})

describe('recipe validator', () => {
  // recipes/ ships empty for now; these prove the gate above bites anyway.
  const recipe = (stages: string[], until?: string, extra = '') =>
    [
      '---',
      'name: tidy-pauses',
      'description: Cut pauses.',
      `stages: [${stages.join(', ')}]`,
      ...(until === undefined ? [] : [`until: "${until}"`]),
      ...(extra ? [extra] : []),
      '---',
      '',
      ...stages.map((s) => `## ${s}\nWhat to do.\n`),
    ].join('\n')
  const check = (src: string) => checkRecipe('tidy-pauses.md', src)

  it('accepts a well-formed recipe, with and without a build loop', () => {
    expect(check(recipe(['intake', 'plan', 'build', 'audit', 'handoff'], 'audit.clean || rounds >= 3'))).toEqual([])
    expect(check(recipe(['intake', 'build', 'critique', 'handoff'], 'critique.clear && user.confirmed || rounds>=2'))).toEqual([])
    expect(check(recipe(['intake', 'audit', 'look', 'critique', 'handoff']))).toEqual([])
  })

  it('rejects a stage outside the catalog', () => {
    expect(check(recipe(['intake', 'polish', 'handoff']))).toContain('unknown stage `polish`')
  })

  it('rejects a signal outside the vocabulary', () => {
    expect(check(recipe(['build', 'audit'], 'audit.passed || rounds >= 3'))).toEqual(['unknown signal `audit.passed`'])
    expect(check(recipe(['build'], 'looks_good || rounds >= 3'))).toEqual(['unknown signal `looks_good`'])
  })

  it('rejects stages out of catalog order or repeated', () => {
    expect(check(recipe(['plan', 'intake']))).toContain('stage `intake` is repeated or out of catalog order')
    expect(check(recipe(['intake', 'intake']))).toContain('stage `intake` is repeated or out of catalog order')
  })

  it('bounds the build loop at three rounds, as a branch of its own', () => {
    expect(check(recipe(['build', 'audit'], 'audit.clean || rounds >= 5'))).toContain('`rounds >= 5`: at most 3 rounds')
    expect(check(recipe(['build', 'audit'], 'audit.clean'))).toContain(
      'until needs a `rounds >= N` branch of its own (N at most 3)',
    )
    expect(check(recipe(['build', 'audit'], 'audit.clean && rounds >= 3'))).toContain(
      'until needs a `rounds >= N` branch of its own (N at most 3)',
    )
    expect(check(recipe(['build']))).toContain('a recipe with build needs until, bounded by rounds')
    expect(check(recipe(['audit'], 'audit.clean'))).toContain('until without build: there are no rounds to end')
  })

  it('rejects a malformed until expression', () => {
    expect(check(recipe(['build'], 'user.confirmed | rounds >= 3'))).toEqual(['until: cannot read `| rounds >= 3`'])
    expect(check(recipe(['build'], 'rounds >= 3 ||'))).toContain(
      'until: `(empty)` is neither a signal nor `rounds >= N`',
    )
    expect(check(recipe(['build'], 'user.confirmed || rounds < 3'))).toContain(
      'until: `rounds < 3` is neither a signal nor `rounds >= N`',
    )
  })

  it('rejects a signal whose stage the recipe never runs', () => {
    expect(check(recipe(['build', 'audit'], 'critique.clear || rounds >= 3'))).toEqual([
      '`critique.clear` needs the critique stage',
    ])
  })

  it('rejects body sections that do not match the listed stages', () => {
    const src = recipe(['intake', 'handoff']).replace('## handoff', '## wrap-up')
    expect(check(src)).toEqual(['body sections [intake, wrap-up] must be one "## <stage>" per listed stage, in order'])
  })

  it('rejects unknown frontmatter keys and a name that is not the file name', () => {
    expect(check(recipe(['intake'], undefined, 'style: vox'))).toEqual(['unknown frontmatter key `style`'])
    expect(checkRecipe('other.md', recipe(['intake']))).toEqual(['name must be the file name, `other`'])
    expect(checkRecipe('Tidy_Pauses.md', recipe(['intake']))).toContain(
      '`Tidy_Pauses.md` is not lowercase words joined by hyphens',
    )
    expect(check('## intake\n')).toEqual(['no YAML frontmatter'])
  })
})
