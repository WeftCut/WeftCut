// apps/desktop/src/main/mcp/instructions.test.ts
// `initialize` carries instructions: the ten-line etiquette, sent to
// every client over either transport, its etiquette identical to the head of
// the shipped skill so the two cannot drift, closed by the version a skill copy
// must match, and small enough that a session pays for it without noticing.
// That the `weftcut` binary sends the same text over stdio is asserted on the
// binary itself (`src/cli/integration.test.ts`, "initialize").
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MCP_INSTRUCTION_LINES, mcpInstructions } from './instructions'
import { buildMcpServer } from './server'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')

describe('initialize instructions', () => {
  it('open with the head of the shipped skill, verbatim', () => {
    const skill = readFileSync(path.join(repoRoot, 'skills/weftcut/SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
    const etiquette = MCP_INSTRUCTION_LINES.join('\n')
    expect(skill).toContain('## In ten lines')
    expect(skill).toContain(etiquette)
    expect(mcpInstructions('1.2.3').startsWith(`${etiquette}\n`)).toBe(true)
    // The block sits ahead of the long form, where a reader lands first.
    expect(skill.indexOf(etiquette)).toBeLessThan(skill.indexOf('## Session etiquette'))
  })

  it('close with the served skill and the version a local copy must carry', () => {
    const last = mcpInstructions('1.2.3').split('\n').at(-1)!
    expect(last).toContain('`skill://weftcut/SKILL.md`')
    expect(last).toContain('`metadata.version` is not 1.2.3 is stale')
  })

  it('stay ten lines and under a session-sized budget', () => {
    // A long pre-release tag, so the budget holds for any version string.
    const sent = mcpInstructions('10.20.30-beta.12')
    expect(sent.split('\n').length).toBeLessThanOrEqual(10)
    // 1400 → 1550: line 8 says a working directory holding project.json is a
    // project whose files change only through tools (ADR 0152). Every client
    // reads this, with or without the skill, and an agent working in the
    // folder would otherwise edit project.json beside the app's autosave.
    expect(sent.length).toBeLessThanOrEqual(1550)
    for (const l of sent.split('\n')) expect(l.trim()).toBe(l)
  })

  it('reach the client on initialize, with the server name and version', async () => {
    const backend = { mcpCatalog: async () => RUST_CATALOG, mcpCallTool: async () => { throw new Error('unused') }, mcpReadResource: async () => '{"ok":true,"result":{"contents":[]}}' } as any
    const server = buildMcpServer(backend, { version: '1.2.3' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'instructions-test', version: '0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    expect(client.getInstructions()).toBe(mcpInstructions('1.2.3'))
    expect(client.getServerVersion()).toMatchObject({ name: 'weftcut', version: '1.2.3' })
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} })
  })
})
