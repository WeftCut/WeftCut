// apps/desktop/src/main/mcp/server.alias.test.ts
// The retired-name seam, driven through the real server rather than around it.
//
// `mcp.tool-aliases.test.ts` pins the table and the rewrite in isolation; both
// would still pass if `buildMcpServer` never called the rewrite, which is the
// mistake that costs a released agent its tool. So this drives an MCP client
// over a transport: a retired name has to come back with a result, and the
// catalog that client reads has to teach the new name and only the new name.
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'alias'), idGen, clock: () => '<TS>' })
  return { actor, mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    handleInvoke: async () => null, start: () => {}, stop: () => {}, beginAgentSessionSlot: () => {} } as never
}
const backend = { mcpCatalog: async () => '{"tools":[],"resources":[],"prompts":[]}',
  mcpCallTool: async () => { throw new Error('rust must not be called') } } as never

async function connected() {
  const server = buildMcpServer(backend, { getTsHost: () => tsHostStub() })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'alias-test', version: '0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

describe('a retired tool name, over the wire', () => {
  it('still dispatches — `checkpoint` lands on create_checkpoint', async () => {
    const client = await connected()
    const out = await client.callTool({ name: 'checkpoint', arguments: { label: 'cp1' } })
    const content = out.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toMatch(/^[0-9a-f-]{36}$/) // the new checkpoint's id
  })

  it('is absent from the catalog the same client reads', async () => {
    const client = await connected()
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const retired of ['checkpoint', 'add_motif', 'set_composition', 'compositions_delete'])
      expect(names, retired).not.toContain(retired)
    for (const now of ['create_checkpoint', 'add_motif_layer', 'update_composition', 'delete_composition'])
      expect(names, now).toContain(now)
  })

  it('leaves an unknown name unknown — the table is a rename map, not a fallback', async () => {
    const client = await connected()
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow()
  })
})
