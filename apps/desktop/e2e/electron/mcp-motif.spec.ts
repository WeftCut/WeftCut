import { test, expect } from '@playwright/test'
import { launchApp, newProject, tmpDir } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { url: string; bearer_token: string }

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'e2e-motifs', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('MCP motif tools are advertised and callable', async () => {
  const { app, page } = await launchApp()
  // add_motif_layer places into the open project; project tools refuse on the
  // start screen, so create one first.
  await newProject(page, { parentFolder: tmpDir('weftcut-mcp-motif-'), name: 'mcp-motif', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })

  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as Info
  const client = await connect(info.url, info.bearer_token)

  // list_motifs, add_motif_layer, preview_motif_draft must appear in listTools
  const toolsResult = await client.listTools()
  const names = toolsResult.tools.map((t) => t.name)
  expect(names).toContain('list_motifs')
  expect(names).toContain('add_motif_layer')
  expect(names).toContain('preview_motif_draft')

  // list_motifs returns the catalog
  const listResult = await client.callTool({ name: 'list_motifs', arguments: {} })
  expect(listResult.content[0]).toMatchObject({ type: 'text' })
  const catalog = JSON.parse((listResult.content[0] as { type: string; text: string }).text)
  expect(Array.isArray(catalog)).toBe(true)
  expect(catalog.length).toBeGreaterThan(0)
  const countdown = catalog.find((m: { id: string }) => m.id === 'countdown')
  expect(countdown).toBeDefined()

  // add_motif_layer places a layer and returns its record
  const addResult = await client.callTool({
    name: 'add_motif_layer',
    arguments: { motif_id: 'countdown', t_start_us: 0 },
  })
  const layerId = (JSON.parse((addResult.content[0] as { type: string; text: string }).text) as { layer_id: string }).layer_id
  expect(layerId).toMatch(/^[0-9a-f-]{36}$/)

  // preview_motif_draft returns image content (JS-side capture)
  const previewResult = await client.callTool({
    name: 'preview_motif_draft',
    arguments: { id: 'countdown', t_sec: 0 },
  })
  expect(previewResult.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })

  // motifs://current resource is readable
  const motifRes = await client.readResource({ uri: 'motifs://current' })
  expect(motifRes.contents[0].mimeType).toBe('application/json')

  await client.close()
  await app.close()
})
