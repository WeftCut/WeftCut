// The host table (shared/agentHosts.ts): what every host's snippet must carry,
// and docs/mcp.md's host block, which is rendered from the table and must equal
// what the table renders now.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_HOSTS,
  httpSnippet,
  placePath,
  stdioCommand,
  stdioSnippet,
  type AgentConfigFormat,
  type AgentHost,
  type AgentHostSurface,
} from '../../shared/agentHosts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const DOC = path.join(repoRoot, 'docs/mcp.md')

const WIN_PATH = 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe'

describe('agent host snippets', () => {
  it('every stdio snippet runs the profile binary with `mcp` and sets no environment', () => {
    for (const host of AGENT_HOSTS) {
      const text = stdioSnippet(host, { command: WIN_PATH, args: ['mcp'] })
      // The path as the format encodes it: JSON escapes, which TOML and YAML
      // double-quoted strings share; the facts block prints it raw.
      const encoded = host.format === 'facts' ? WIN_PATH : JSON.stringify(WIN_PATH)
      expect(text, host.id).toContain(encoded)
      if (host.format === 'facts') expect(text, host.id).toMatch(/^arg:\s+mcp$/m)
      else expect(text, host.id).toContain('"mcp"')
      expect(text, host.id).not.toMatch(/\benv\b/i)
    }
  })

  it('the JSON hosts carry exactly the command and its argument', () => {
    for (const host of AGENT_HOSTS.filter((h) => h.format.endsWith('json'))) {
      const entry = JSON.parse(stdioSnippet(host, { command: WIN_PATH, args: ['mcp'] })).mcpServers.weftcut
      const { type, ...rest } = entry
      expect(rest, host.id).toEqual({ command: WIN_PATH, args: ['mcp'] })
      // Claude Code types its entries; the others take none.
      expect(type, host.id).toBe(host.format === 'claude-code-json' ? 'stdio' : undefined)
    }
  })

  it('a host without an HTTP form gets no HTTP snippet, and one with a form gets the token', () => {
    for (const host of AGENT_HOSTS) {
      const text = httpSnippet(host, 'http://127.0.0.1:4711/mcp', 'secret')
      if (host.http) expect(text, host.id).toContain('Bearer secret')
      else expect(text, host.id).toBeNull()
    }
  })

  it('host ids are unique, so tab ids and test lookups are too', () => {
    expect(new Set(AGENT_HOSTS.map((h) => h.id)).size).toBe(AGENT_HOSTS.length)
  })
})

// ── docs/mcp.md host block ──────────────────────────────────────────────────

const BEGIN = '<!-- agent-hosts:begin -->'
const END = '<!-- agent-hosts:end -->'

/// What the doc shows for the profile's copy of the binary.
const DOC_ENTRY = { command: '<userData>/cli/weftcut', args: ['mcp'] }

const FENCE: Record<AgentConfigFormat, string> = {
  'codex-toml': 'toml',
  'claude-code-json': 'json',
  'mcp-servers-json': 'json',
  'dsh-patch-yaml': 'yaml',
  facts: 'text',
}

const SURFACE: Record<AgentHostSurface, string> = {
  panel: 'side panel',
  browser: 'side browser',
  none: 'none',
}

const OS_NAME = { mac: 'macOS', windows: 'Windows', linux: 'Linux' } as const

function docPlaces(host: AgentHost): string {
  if (host.places.length === 0) return "the client's own docs"
  return host.places
    .map((place) => {
      const paths =
        typeof place.path === 'string'
          ? `\`${place.path}\``
          : (Object.keys(OS_NAME) as (keyof typeof OS_NAME)[])
              .map((os) => `${OS_NAME[os]} \`${placePath(place, os)}\``)
              .join(', ')
      return place.scope === 'project' ? `project: ${paths}` : paths
    })
    .join('; ')
}

function renderHostBlock(): string {
  const rows = AGENT_HOSTS.map(
    (h) => `| ${h.name} | ${docPlaces(h)} | ${h.http ? 'yes' : 'no'} | ${SURFACE[h.surface]} |`,
  )
  const sections = AGENT_HOSTS.flatMap((h) => {
    const command = stdioCommand(h, DOC_ENTRY)
    return [
      `**${h.name}**`,
      '',
      '```' + FENCE[h.format],
      stdioSnippet(h, DOC_ENTRY),
      '```',
      '',
      ...(command ? [`Or in a terminal: \`${command}\``, ''] : []),
    ]
  })
  return [
    BEGIN,
    '',
    '| Host | Config file | HTTP direct | Preview surface |',
    '|---|---|---|---|',
    ...rows,
    '',
    'The stdio entry per host, `<userData>/cli/weftcut` standing for the',
    "profile's copy of the binary:",
    '',
    ...sections,
    END,
  ].join('\n')
}

describe('docs/mcp.md', () => {
  it('shows the host block the table renders', () => {
    const doc = readFileSync(DOC, 'utf8')
    const start = doc.indexOf(BEGIN)
    const end = doc.indexOf(END)
    expect(start, `docs/mcp.md has no ${BEGIN} … ${END} block`).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    // On failure, the expected side is the block to paste between the markers.
    expect(doc.slice(start, end + END.length)).toBe(renderHostBlock())
  })
})
