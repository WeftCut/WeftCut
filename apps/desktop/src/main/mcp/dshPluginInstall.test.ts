// The DeepSeek Harness plugin the app writes (ADR 0183): where it goes, what
// its patch runs, that a start rewrites only what changed, and the names and
// link format its plain-JS halves share with the app, since nothing compiles
// them against it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SERVER_NAME, dshPluginDir, stdioEntry } from '../../shared/agentHosts'
import { loadOrCreatePageKey } from '../companion/pageKey'
import { OPEN_COMPANION } from './companionTool'
import { DSH_PLUGIN_NAME, dshPluginFiles, installDshPlugin } from './dshPluginInstall'

let profile: string
let cliPath: string

beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-'))
  cliPath = path.join(profile, 'cli', 'weftcut')
})
afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

const files = (version = '1.2.3') => dshPluginFiles({ cliPath, version })
const file = (rel: string, version?: string) => files(version).get(rel)!

/// A `const NAME = …` initializer from client.js or index.js, as written.
function constant(source: string, name: string): string {
  const m = new RegExp(`^\\s*const ${name} = (.+)$`, 'm').exec(source)
  if (m === null) throw new Error(`no const ${name}`)
  return m[1]!.trim()
}

/// The double-quoted scalar after `key:` in the generated YAML, decoded.
function yamlString(yaml: string, key: string): string {
  const m = new RegExp(`^\\s*${key}: (".*")$`, 'm').exec(yaml)
  if (m === null) throw new Error(`no ${key}`)
  return JSON.parse(m[1]!) as string
}

describe('dshPluginDir', () => {
  it('is the dsh-plugin folder beside the binary\'s cli folder, in either separator', () => {
    expect(dshPluginDir('/home/u/.config/WeftCut/cli/weftcut')).toBe('/home/u/.config/WeftCut/dsh-plugin')
    expect(dshPluginDir('C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe'))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\WeftCut\\dsh-plugin')
  })
})

describe('installDshPlugin', () => {
  it('writes every file of the plugin into the profile\'s dsh-plugin folder', () => {
    const dir = installDshPlugin({ cliPath, version: '1.2.3' })
    expect(dir).toBe(path.join(profile, 'dsh-plugin'))
    for (const [rel, content] of files()) {
      expect(fs.readFileSync(path.join(dir!, rel), 'utf8'), rel).toBe(content)
    }
  })

  it('leaves a file whose content is already right untouched, and replaces one that changed', () => {
    const dir = installDshPlugin({ cliPath, version: '1.2.3' })!
    const inode = (rel: string) => fs.statSync(path.join(dir, rel)).ino
    const before = new Map([...files().keys()].map((rel) => [rel, inode(rel)]))
    installDshPlugin({ cliPath, version: '1.2.4' })
    for (const [rel, ino] of before) {
      // A rewrite renames a new file into place; only the manifest carries the version.
      if (rel === 'package.json') expect(inode(rel), rel).not.toBe(ino)
      else expect(inode(rel), rel).toBe(ino)
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.2.4')
  })
})

describe('the plugin\'s files', () => {
  it('run this profile\'s binary as the weftcut server', () => {
    for (const binary of [cliPath, 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe']) {
      const patch = dshPluginFiles({ cliPath: binary, version: '1.2.3' }).get('cordis.patch.yml')!
      expect(yamlString(patch, 'command')).toBe(stdioEntry(binary).command)
      expect(patch).toContain(`args: [${stdioEntry(binary).args.map((a) => JSON.stringify(a)).join(', ')}]`)
      expect(patch).toContain(`serverName: ${SERVER_NAME}`)
      expect(patch).toContain(`name: '${DSH_PLUGIN_NAME}'`)
    }
  })

  it('key the tool row and /weftcut to the names dsh gives the server\'s tools', () => {
    const client = file('client.js')
    const index = file('index.js')
    expect(constant(client, 'TOOL')).toBe(`'mcp__${SERVER_NAME}__${OPEN_COMPANION}'`)
    expect(constant(index, 'SERVER')).toBe(`'${SERVER_NAME}'`)
    expect(constant(index, 'OPEN')).toBe(`\`mcp__\${SERVER}__${OPEN_COMPANION}\``)
    // The binary answers launch_weftcut itself; its name lives in the Go source.
    const tools = fs.readFileSync(path.resolve(__dirname, '../../../cli/tools.go'), 'utf8')
    const launch = /^\s*toolLaunch\s*=\s*"([^"]+)"/m.exec(tools)?.[1]
    expect(launch).toBeDefined()
    expect(constant(index, 'LAUNCH')).toBe(`\`mcp__\${SERVER}__${launch}\``)
    expect(constant(client, 'COMMAND')).toBe("'weftcut'")
    expect(index).toContain("name: 'weftcut',")
  })

  it('frame links of the documented shape, with a real page key, and nothing else', () => {
    const literal = /^\/(.+)\/$/.exec(constant(file('client.js'), 'LINK'))![1]!
    const link = new RegExp(literal)
    // The shape docs/mcp.md § Companion page gives: the MCP listener's
    // /companion with the page key in the fragment. The port is any port.
    const key = loadOrCreatePageKey(profile)
    expect(link.test(`http://127.0.0.1:1/companion#k=${key}`)).toBe(true)
    expect(link.test(`http://127.0.0.1:1/mcp#k=${key}`)).toBe(false)
    expect(link.test(`http://example.com:1/companion#k=${key}`)).toBe(false)
    expect(link.test(`http://127.0.0.1:1/companion#k=${key}&x=javascript:`)).toBe(false)
  })

  it('form a bundle dsh accepts: its module ids are the package name, its exports exist', () => {
    const manifest = JSON.parse(file('package.json')) as { name: string; exports: Record<string, string>; dsh: { bundle: { patch: string } } }
    expect(manifest.name).toBe(DSH_PLUGIN_NAME)
    expect(file('client.js')).toContain(`id: '${DSH_PLUGIN_NAME}'`)
    expect(constant(file('client.js'), 'ID')).toBe(`'${DSH_PLUGIN_NAME}'`)
    const present = new Set(files().keys())
    expect(present.has(manifest.dsh.bundle.patch.replace(/^\.\//, ''))).toBe(true)
    for (const target of Object.values(manifest.exports)) {
      if (target.includes('*')) continue
      expect(present.has(target.replace(/^\.\//, '')), target).toBe(true)
    }
  })

  it('name the plugin in both baseline languages dsh requires', () => {
    for (const locale of ['en', 'zh']) {
      const meta = (JSON.parse(file(`locale/${locale}.json`)) as { meta: Record<string, string> }).meta
      expect(meta.title, locale).toBeTruthy()
      expect(meta.description, locale).toBeTruthy()
    }
  })
})
