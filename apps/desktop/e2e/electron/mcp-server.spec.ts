import { test, expect } from '@playwright/test'
import { launchApp, invokeCmd, newProject, tmpDir } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { url: string; bearer_token: string }

async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  })
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('external MCP client connects, calls tools, and bearer is enforced', async () => {
  const { app, page } = await launchApp()

  // Discover the live server URL + token from the main process (panel is deferred).
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as Info

  // Field-shape assertion: streamable-HTTP url present, SSE fields gone.
  expect(info).toHaveProperty('url')
  expect(info).not.toHaveProperty('sse_url')
  expect(info.url).toMatch(/\/mcp$/)

  expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  expect(info.bearer_token).toHaveLength(64)

  // 401 without the token.
  await expect(connect(info.url)).rejects.toThrow()

  // With the token: ping + add_track parity + resource read.
  const client = await connect(info.url, info.bearer_token)

  // Use the real SDK client.listTools() so the call goes through the Zod
  // inputSchema validator: keyframe tools (easing/track props) must emit an
  // object schema, not bare `true`, or AssertObjectSchema rejects them.
  const toolsResult = await client.listTools()
  expect(toolsResult.tools.map((t) => t.name)).toContain('add_track')

  // An app-scope read answers with no project open.
  const session = await client.readResource({ uri: 'project://session' })
  expect(JSON.parse((session.contents[0] as { text: string }).text)).toMatchObject({ project: null })

  // The app booted to its start screen: no project is open, so a project tool
  // is refused with the remedy in its text and commits nothing into the
  // placeholder the user cannot see.
  const startScreen = (await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))) as { track_count: number }
  const refused = await client.callTool({ name: 'add_track', arguments: {} })
  expect((refused as { isError?: boolean }).isError).toBe(true)
  expect((refused.content as Array<{ text: string }>)[0].text).toContain('No project is open in WeftCut')
  expect((refused.structuredContent as { error?: string } | undefined)?.error).toBe('NoProjectOpen')
  const stillStartScreen = (await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))) as { track_count: number }
  expect(stillStartScreen.track_count).toBe(startScreen.track_count)

  await newProject(page, { parentFolder: tmpDir('weftcut-mcp-server-'), name: 'mcp-server', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })

  const before = (await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))) as { track_count: number }
  await client.callTool({ name: 'add_track', arguments: {} })
  const after = (await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))) as { track_count: number }
  expect(after.track_count).toBe(before.track_count + 1)

  const proj = await client.readResource({ uri: 'project://tracks' })
  expect(proj.contents[0].mimeType).toBe('application/json')

  // The keyframe record through the REAL SDK client (its schema validation
  // included): a 2-key opacity track on a Text layer, then the per-side and
  // per-track writers, each read back through get_param_track.
  const names = toolsResult.tools.map((t) => t.name)
  expect(names).toContain('update_keyframe')
  expect(names).toContain('set_param_track')
  const trackId = await invokeCmd<string>(page, 'add_track', {})
  const layerId = await invokeCmd<string>(page, 'add_text_layer', {
    trackId, content: 'MCP KEYFRAMES', tStartUs: 0, durationUs: 4_000_000,
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args })
    expect((res as { isError?: boolean }).isError, `${name} ${JSON.stringify(res.content)}`).toBeFalsy()
    return res
  }
  interface TrackView {
    track: { mode: string; extrapolate: { before: string; after: string }; value: Array<{ in: unknown; out: unknown; segment: unknown }> }
    keyframe_ids: string[]
    preset_ids: Array<string | null>
  }
  const readTrack = async (): Promise<TrackView> => {
    const res = await call('get_param_track', { layer_id: layerId, param_key: 'opacity' })
    return JSON.parse((res.content as Array<{ text: string }>)[0].text) as TrackView
  }
  await call('set_keyframe', { layer_id: layerId, param_key: 'opacity', t_us: 0, value: 0 })
  await call('set_keyframe', { layer_id: layerId, param_key: 'opacity', t_us: 2_000_000, value: 1 })
  const keyed = await readTrack()
  expect(keyed.track.mode).toBe('Keyframed')
  expect(keyed.keyframe_ids).toHaveLength(2)
  const [k0, k1] = keyed.keyframe_ids

  // One side per call; the two together are exactly the ease_in_out table entry.
  await call('update_keyframe', { layer_id: layerId, param_key: 'opacity', keyframe_id: k0, out: { x: 0.42, y: 0 } })
  await call('update_keyframe', { layer_id: layerId, param_key: 'opacity', keyframe_id: k1, in: { x: 0.58, y: 1 } })
  const shaped = await readTrack()
  expect(shaped.track.value[0].out).toEqual({ x: 0.42, y: 0, mode: 'Free' })
  expect(shaped.track.value[1].in).toEqual({ x: 0.58, y: 1, mode: 'Free' })
  expect(shaped.track.value[0].segment).toEqual({ kind: 'Spline' })
  expect(shaped.preset_ids[0]).toBe('ease_in_out')

  // The read's `track` is the write shape: change one field, send it back.
  await call('set_param_track', { layer_id: layerId, param_key: 'opacity', track: { ...shaped.track, extrapolate: { before: 'Hold', after: 'Loop' } } })
  const looped = await readTrack()
  expect(looped.track.extrapolate).toEqual({ before: 'Hold', after: 'Loop' })

  await client.close()
  await app.close()
})
