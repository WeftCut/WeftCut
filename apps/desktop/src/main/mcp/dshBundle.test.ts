// The DeepSeek Harness bundle in plugins/dsh: plain files dsh loads as they
// are, so nothing compiles them against the app. These checks hold the names
// and the link format it shares with the app, and the manifest dsh validates.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_HOSTS, stdioEntry, stdioSnippet } from '../../shared/agentHosts'
import { loadOrCreatePageKey } from '../companion/pageKey'
import { OPEN_COMPANION } from './companionTool'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const BUNDLE = path.join(repoRoot, 'plugins/dsh')
const read = (rel: string) => readFileSync(path.join(BUNDLE, rel), 'utf8')
const client = read('client.js')
const pkg = JSON.parse(read('package.json')) as {
  name: string
  files: string[]
  exports: Record<string, string>
  dsh: { bundle: { patch: string } }
}

/// A `const NAME = …` initializer from client.js, as written.
function constant(name: string): string {
  const m = new RegExp(`^\\s*const ${name} = (.+)$`, 'm').exec(client)
  if (m === null) throw new Error(`client.js has no const ${name}`)
  return m[1]!.trim()
}

function bundleFiles(dir = BUNDLE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? bundleFiles(full) : [path.relative(BUNDLE, full).split(path.sep).join('/')]
  })
}

describe('plugins/dsh', () => {
  it('keys its row to the tool name dsh gives open_side_preview under the server name the app writes', () => {
    const host = AGENT_HOSTS.find((h) => h.format === 'dsh-patch-yaml')!
    const serverName = /serverName: (\S+)/.exec(stdioSnippet(host, stdioEntry('/home/u/weftcut')))![1]
    expect(constant('TOOL')).toBe(`'mcp__${serverName}__${OPEN_COMPANION}'`)
  })

  it('frames the link the app hands out and nothing else', () => {
    const literal = /^\/(.+)\/$/.exec(constant('LINK'))![1]!
    const link = new RegExp(literal)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-bundle-'))
    try {
      // The app's link: the MCP listener's /companion with the page key in the
      // fragment (docs/mcp.md § Companion page).
      const key = loadOrCreatePageKey(dir)
      expect(link.test(`http://127.0.0.1:37347/companion#k=${key}`)).toBe(true)
      expect(link.test(`http://127.0.0.1:37347/mcp#k=${key}`)).toBe(false)
      expect(link.test(`http://example.com:37347/companion#k=${key}`)).toBe(false)
      expect(link.test(`http://127.0.0.1:37347/companion#k=${key}&x=javascript:`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a bundle dsh accepts: one patch row named after the package, its files published', () => {
    expect(read(pkg.dsh.bundle.patch)).toContain(`name: '${pkg.name}'`)
    expect(client).toContain(`id: '${pkg.name}'`)
    for (const target of Object.values(pkg.exports)) {
      if (target.includes('*')) continue
      expect(bundleFiles(), target).toContain(target.replace(/^\.\//, ''))
    }
    // npm packs package.json whatever `files` says; every other file must be named.
    const published = (rel: string) => rel === 'package.json' || pkg.files.some((pattern) =>
      pattern === rel || new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]+')}$`).test(rel))
    for (const rel of bundleFiles()) expect(published(rel), rel).toBe(true)
  })

  it('names itself in both baseline languages dsh requires', () => {
    for (const locale of ['en', 'zh']) {
      const meta = (JSON.parse(read(`locale/${locale}.json`)) as { meta: Record<string, string> }).meta
      expect(meta.title, locale).toBeTruthy()
      expect(meta.description, locale).toBeTruthy()
    }
  })
})
