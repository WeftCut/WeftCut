// The content plugin in plugins/weftcut (ADR 0167): its two manifests describe
// one plugin, its files are pinned to its version, and it carries content only.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const PLUGIN = path.join(repoRoot, 'plugins/weftcut')
const LOCK = 'content.lock.json'

type Manifest = Record<string, unknown> & { name: string; version: string; description: string }

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(PLUGIN, rel), 'utf8')) as T
const claude = readJson<Manifest>('.claude-plugin/plugin.json')
const agentPlugins = readJson<Manifest>('plugin.json')

/// Every file of the plugin but the lock, as POSIX paths relative to its root.
function pluginFiles(dir = PLUGIN): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return pluginFiles(full)
    const rel = path.relative(PLUGIN, full).split(path.sep).join('/')
    return rel === LOCK ? [] : [rel]
  })
}

/// One hash over the file set: each file's path and content hash, in path
/// order, so a rename, an added file and an edit all change it. The checkout
/// writes text with LF on every OS (.gitattributes), so the bytes agree.
function contentHash(): string {
  const all = createHash('sha256')
  for (const rel of pluginFiles().sort()) {
    const file = createHash('sha256').update(readFileSync(path.join(PLUGIN, rel))).digest('hex')
    all.update(`${rel}\0${file}\n`)
  }
  return `sha256:${all.digest('hex')}`
}

function frontmatter(md: string): string {
  return /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? ''
}

function description(md: string): string {
  return /^description: (.*)$/m.exec(frontmatter(md))?.[1] ?? ''
}

describe('plugins/weftcut', () => {
  it('the Claude and Agent Plugins manifests agree on name, version and description', () => {
    for (const key of ['name', 'version', 'description'] as const) {
      expect(agentPlugins[key], key).toBe(claude[key])
    }
  })

  it('its files are the ones recorded for its version', () => {
    const lock = readJson<Record<string, string>>(LOCK)
    const hash = contentHash()
    expect(
      lock[claude.version],
      `plugins/weftcut changed while its version stayed ${claude.version}. Raise "version" in both ` +
        `manifests and add "<new version>": "${hash}" to ${LOCK}.`,
    ).toBe(hash)
  })

  it('declares no MCP server, hook or executable: the app registers the server', () => {
    for (const manifest of [claude, agentPlugins]) {
      expect(Object.keys(manifest)).not.toContain('mcpServers')
      expect(Object.keys(manifest)).not.toContain('hooks')
    }
    for (const rel of ['.mcp.json', 'mcp.json', 'hooks', 'bin']) {
      expect(existsSync(path.join(PLUGIN, rel)), rel).toBe(false)
    }
  })

  it('its skill fires on the full skill\'s requests and pins no version', () => {
    const small = readFileSync(path.join(PLUGIN, 'skills/weftcut/SKILL.md'), 'utf8')
    const full = readFileSync(path.join(repoRoot, 'skills/weftcut/SKILL.md'), 'utf8')
    expect(description(small).startsWith(description(full))).toBe(true)
    // A `version` key, at the top or under `metadata`, as the app stamps its copy.
    expect(frontmatter(small)).not.toMatch(/^\s*version:/m)
    // The full guidance is the app's served copy, read before any tool call.
    expect(small).toContain('skill://weftcut/SKILL.md')
  })
})
