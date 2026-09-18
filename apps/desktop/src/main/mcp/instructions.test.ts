// apps/desktop/src/main/mcp/instructions.test.ts
// `initialize` carries instructions: the ten-line etiquette, sent to
// every client, identical to the head of the shipped skill so the two cannot
// drift, and small enough that a session pays for it without noticing.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MCP_INSTRUCTIONS, MCP_INSTRUCTION_LINES } from './instructions'
import { buildMcpServer } from './server'

vi.mock('../motif/capture.js', () => ({ captureMotifFrameB64: async () => 'iVBOR' }))

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')

describe('initialize instructions', () => {
  it('are the head of the shipped skill, verbatim', () => {
    const skill = readFileSync(path.join(repoRoot, 'skills/weftcut/SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
    expect(skill).toContain('## In ten lines')
    expect(skill).toContain(MCP_INSTRUCTIONS)
    // The block sits ahead of the long form, where a reader lands first.
    expect(skill.indexOf(MCP_INSTRUCTIONS)).toBeLessThan(skill.indexOf('## Session etiquette'))
  })

  it('stay ten lines and under a session-sized budget', () => {
    expect(MCP_INSTRUCTION_LINES.length).toBeLessThanOrEqual(10)
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1400)
    for (const l of MCP_INSTRUCTION_LINES) expect(l.trim()).toBe(l)
  })

  it('reach the client on initialize, with the server name and version', async () => {
    const backend = { mcpCatalog: async () => RUST_CATALOG, mcpCallTool: async () => { throw new Error('unused') }, mcpReadResource: async () => '{"ok":true,"result":{"contents":[]}}' } as any
    const server = buildMcpServer(backend, { version: '1.2.3' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'instructions-test', version: '0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS)
    expect(client.getServerVersion()).toMatchObject({ name: 'weftcut', version: '1.2.3' })
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} })
  })
})
