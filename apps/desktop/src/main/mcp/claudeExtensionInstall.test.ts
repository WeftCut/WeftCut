// The Claude Desktop extension the app writes (ADR 0187): the names Claude
// keys it by, the binary it runs, a version that moves with its content and
// nothing else, the bundle's files, and that a start rewrites it only when
// it changed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { SERVER_NAME, claudeExtensionPath, stdioEntry } from '../../shared/agentHosts'
import {
  CLAUDE_EXTENSION_AUTHOR,
  claudeExtensionBundle,
  claudeExtensionFiles,
  installClaudeExtension,
} from './claudeExtensionInstall'

const ICON_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../claude-extension/icon.png')

let profile: string
let cliPath: string

beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-extension-'))
  cliPath = path.join(profile, 'with space', 'cli', 'weftcut')
})
afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

interface Manifest {
  manifest_version: string
  name: string
  display_name?: string
  version: string
  description: string
  author: { name: string }
  icon: string
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env?: unknown } }
}

const manifestOf = (binary = cliPath) => JSON.parse(claudeExtensionFiles({ cliPath: binary }).manifest) as Manifest

describe('claudeExtensionPath', () => {
  it('is weftcut.mcpb in the claude-desktop folder beside the binary\'s cli folder, in either separator', () => {
    expect(claudeExtensionPath('/home/u/.config/WeftCut/cli/weftcut'))
      .toBe('/home/u/.config/WeftCut/claude-desktop/weftcut.mcpb')
    expect(claudeExtensionPath('C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe'))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\WeftCut\\claude-desktop\\weftcut.mcpb')
  })
})

describe('the manifest', () => {
  it('names the server weftcut, the key every other host registers it under', () => {
    // Claude keys the server by `display_name || name`, case-sensitive.
    const m = manifestOf()
    expect(m.name).toBe(SERVER_NAME)
    expect(m).not.toHaveProperty('display_name')
  })

  it('keeps the name and author Claude derives the extension\'s id from', () => {
    // A change installs a second extension beside the first instead of
    // offering an update to it.
    const m = manifestOf()
    expect(m.name).toBe('weftcut')
    expect(m.author.name).toBe('WeftCut')
    expect(CLAUDE_EXTENSION_AUTHOR).toBe('WeftCut')
  })

  it('runs this profile\'s binary with mcp, and sets no environment', () => {
    for (const binary of [cliPath, 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe']) {
      const { server } = manifestOf(binary)
      expect(server.type).toBe('binary')
      expect(server.mcp_config).toEqual({ command: stdioEntry(binary).command, args: [...stdioEntry(binary).args] })
      expect(server.entry_point).toBe(binary)
    }
  })

  it('carries the fields the MCPB 0.3 schema requires', () => {
    const m = manifestOf()
    expect(m.manifest_version).toBe('0.3')
    expect(m.description).toBeTruthy()
    expect(m.icon).toBe('icon.png')
  })
})

describe('the version', () => {
  it('is a semver whose prerelease is the content hash', () => {
    // A numeric prerelease may not start with 0, so the hash rides behind a letter.
    expect(manifestOf().version).toMatch(/^1\.0\.0-c[0-9a-f]{12}$/)
  })

  it('changes with the binary it names', () => {
    expect(manifestOf('/home/u/a/cli/weftcut').version).not.toBe(manifestOf('/home/u/b/cli/weftcut').version)
  })

  it('stays put, and the bundle with it, while the content does', () => {
    expect(manifestOf().version).toBe(manifestOf().version)
    expect(Buffer.from(claudeExtensionBundle({ cliPath })).equals(Buffer.from(claudeExtensionBundle({ cliPath })))).toBe(true)
  })
})

describe('the bundle', () => {
  it('holds exactly the manifest and the app icon', () => {
    const entries = unzipSync(claudeExtensionBundle({ cliPath }))
    expect(Object.keys(entries).sort()).toEqual(['icon.png', 'manifest.json'])
    expect(new TextDecoder().decode(entries['manifest.json'])).toBe(claudeExtensionFiles({ cliPath }).manifest)
    // The inlined icon decodes to the committed PNG.
    expect(Buffer.from(entries['icon.png']!).equals(fs.readFileSync(ICON_FILE))).toBe(true)
  })
})

describe('installClaudeExtension', () => {
  it('writes the bundle into the profile and returns its path', () => {
    const dest = installClaudeExtension({ cliPath })
    expect(dest).toBe(path.join(profile, 'with space', 'claude-desktop', 'weftcut.mcpb'))
    expect(fs.readFileSync(dest!).equals(Buffer.from(claudeExtensionBundle({ cliPath })))).toBe(true)
  })

  it('leaves an equal bundle untouched, and replaces one that differs', () => {
    const dest = installClaudeExtension({ cliPath })!
    const inode = fs.statSync(dest).ino
    expect(installClaudeExtension({ cliPath })).toBe(dest)
    expect(fs.statSync(dest).ino).toBe(inode)

    // A rewrite renames a new file into place.
    fs.writeFileSync(dest, 'stale')
    const stale = fs.statSync(dest).ino
    installClaudeExtension({ cliPath })
    expect(fs.statSync(dest).ino).not.toBe(stale)
    expect(fs.readFileSync(dest).equals(Buffer.from(claudeExtensionBundle({ cliPath })))).toBe(true)
  })

  it('answers null when the bundle cannot be written', () => {
    // A file where the folder should be.
    fs.mkdirSync(path.join(profile, 'with space'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'with space', 'claude-desktop'), '')
    expect(installClaudeExtension({ cliPath })).toBeNull()
  })
})
