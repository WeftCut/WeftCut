// The host table (shared/agentHosts.ts): what every host's snippet must carry,
// and docs/mcp.md's host block, which is rendered from the table and must equal
// what the table renders now.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_HOSTS,
  claudeExtensionPath,
  dshPluginDir,
  httpCommand,
  httpSnippet,
  stdioCommand,
  stdioEntry,
  stdioSnippet,
  type AgentConfigFormat,
  type AgentHost,
  type AgentHostSurface,
} from '../../shared/agentHosts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const DOC = path.join(repoRoot, 'docs/mcp.md')

const WIN_PATH = 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe'

describe('agent host snippets', () => {
  it('a stdio entry is the binary and its `mcp` subcommand, nothing else', () => {
    expect(stdioEntry(WIN_PATH)).toEqual({ command: WIN_PATH, args: ['mcp'] })
  })

  it("Claude Code's one-liners remove an existing weftcut entry, then add theirs whatever the remove found", () => {
    const claude = AGENT_HOSTS.find((h) => h.cli === 'claude')!
    for (const line of [stdioCommand(claude, stdioEntry(WIN_PATH)), httpCommand(claude, 'http://127.0.0.1:4711/mcp', 'secret')]) {
      // `&&` would skip the add on a machine with nothing to remove.
      const [remove, add, ...rest] = line!.split('; ')
      expect(remove).toBe('claude mcp remove weftcut -s user')
      expect(add).toMatch(/^claude mcp add .*-s user/)
      expect(rest).toEqual([])
    }
  })

  it('every stdio snippet runs the profile binary with `mcp` and sets no environment', () => {
    // The dsh plugin's and the Claude Desktop extension's entries are written
    // by the app; their tests hold them (dshPluginInstall.test.ts,
    // claudeExtensionInstall.test.ts).
    for (const host of AGENT_HOSTS.filter((h) => h.format !== 'dsh-plugin' && h.format !== 'claude-extension')) {
      const text = stdioSnippet(host, stdioEntry(WIN_PATH))
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
      const entry = JSON.parse(stdioSnippet(host, stdioEntry(WIN_PATH))).mcpServers.weftcut
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

  it('DeepSeek Harness is handed the plugin folder the app writes, by path', () => {
    const dsh = AGENT_HOSTS.find((h) => h.format === 'dsh-plugin')!
    const dir = 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\dsh-plugin'
    expect(stdioSnippet(dsh, stdioEntry(WIN_PATH))).toBe(dir)
    expect(dshPluginDir(WIN_PATH)).toBe(dir)
    expect(stdioCommand(dsh, stdioEntry(WIN_PATH))).toBe(`dsh plugin --profile web add '${dir}'`)
  })

  it('Claude Desktop is handed the extension the app writes, by path, and no terminal command', () => {
    const claude = AGENT_HOSTS.find((h) => h.format === 'claude-extension')!
    const file = 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\claude-desktop\\weftcut.mcpb'
    expect(stdioSnippet(claude, stdioEntry(WIN_PATH))).toBe(file)
    expect(claudeExtensionPath(WIN_PATH)).toBe(file)
    expect(stdioCommand(claude, stdioEntry(WIN_PATH))).toBeNull()
  })

  it('host ids are unique, so tab ids and test lookups are too', () => {
    expect(new Set(AGENT_HOSTS.map((h) => h.id)).size).toBe(AGENT_HOSTS.length)
  })
})

describe('one-liners', () => {
  const codex = AGENT_HOSTS.find((h) => h.id === 'codex')!
  it('keep a path verbatim in PowerShell and a POSIX shell: nothing inside the quotes expands', () => {
    // A profile under a user name with `$` (or a backtick) in it: double quotes
    // would have PowerShell substitute `$review`.
    expect(stdioCommand(codex, stdioEntry('C:\\Users\\$review\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe')))
      .toBe("codex mcp add weftcut -- 'C:\\Users\\$review\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe' mcp")
    expect(stdioCommand(codex, stdioEntry('/home/u/$HOME `x`/WeftCut/cli/weftcut')))
      .toBe("codex mcp add weftcut -- '/home/u/$HOME `x`/WeftCut/cli/weftcut' mcp")
  })
  it('spell a single quote inside the way the path\'s own shell reads it', () => {
    expect(stdioCommand(codex, stdioEntry("C:\\Users\\o'neil\\cli\\weftcut.exe")))
      .toBe("codex mcp add weftcut -- 'C:\\Users\\o''neil\\cli\\weftcut.exe' mcp")
    expect(stdioCommand(codex, stdioEntry("/home/o'neil/cli/weftcut")))
      .toBe("codex mcp add weftcut -- '/home/o'\\''neil/cli/weftcut' mcp")
  })
  it('leave a plain path bare', () => {
    expect(stdioCommand(codex, stdioEntry('/home/u/.config/WeftCut/cli/weftcut'))).toBe('codex mcp add weftcut -- /home/u/.config/WeftCut/cli/weftcut mcp')
  })
})

// ── docs/mcp.md host block ──────────────────────────────────────────────────

const BEGIN = '<!-- agent-hosts:begin -->'
const END = '<!-- agent-hosts:end -->'

/// What the doc shows for the profile's copy of the binary.
const DOC_ENTRY = stdioEntry('<userData>/cli/weftcut')

const FENCE: Record<AgentConfigFormat, string> = {
  'codex-toml': 'toml',
  'claude-code-json': 'json',
  'mcp-servers-json': 'json',
  'dsh-plugin': 'text',
  'claude-extension': 'text',
  facts: 'text',
}

const SURFACE: Record<AgentHostSurface, string> = {
  panel: 'side panel',
  browser: 'side browser',
  none: 'none',
}

function docPlaces(host: AgentHost): string {
  if (host.format === 'dsh-plugin') return 'none: a plugin WeftCut writes'
  if (host.format === 'claude-extension') return 'none: an extension WeftCut writes'
  if (host.places.length === 0) return "the client's own docs"
  return host.places
    .map((place) => (place.scope === 'project' ? `project: \`${place.path}\`` : `\`${place.path}\``))
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
      ...(h.format === 'dsh-plugin' ? ['The plugin folder, whose patch carries the stdio entry:', ''] : []),
      ...(h.format === 'claude-extension'
        ? ['The extension file, whose manifest carries the stdio entry; open it in Claude Desktop:', '']
        : []),
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
