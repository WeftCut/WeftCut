// `project://playhead` against the real editor: the user moves the playhead,
// selects and marks a range the way they would, and an agent reading the view
// gets where that is, down to the clip under the playhead, without asking.
import { test, expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { launchApp, newProject, tmpDir } from './helpers/driver'

interface Info { url: string; bearer_token: string }
interface Playhead {
  composition_id: string
  t_us: number
  timecode: string
  playing: boolean
  range: { t_start_us: number; t_end_us: number } | null
  selection: string[]
  under_playhead: Array<{ layer_id: string; track_id: string; label: string | null }>
}

async function connect(page: Page): Promise<Client> {
  const info = await page.evaluate(() => (window as any).api.mcp.getInfo()) as Info
  const client = new Client({ name: 'mcp-playhead-e2e', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  }))
  return client
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, `${name}: ${JSON.stringify(result)}`).toBeFalsy()
  return result.structuredContent as T
}

const readPlayhead = (client: Client): Promise<Playhead> => call<Playhead>(client, 'read_project', { view: 'playhead' })

/** The view through both doors, once the editor has settled: two reads of a
 *  live view taken while a change lands answer two moments. */
async function readSettled(client: Client): Promise<Playhead> {
  const tool = await readPlayhead(client)
  const resource = await client.readResource({ uri: 'project://playhead' })
  expect(JSON.parse((resource.contents[0] as { text: string }).text)).toEqual(tool)
  return tool
}

const playheadUs = (page: Page) => page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs() as number)

test('an agent reads where the user is: the clip under the playhead, the selection, the range', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  let client: Client | undefined
  try {
    client = await connect(page)

    // The start screen: refused with the cause, as every project read is.
    const refused = await client.callTool({ name: 'read_project', arguments: { view: 'playhead' } })
    expect(refused.isError).toBe(true)
    expect((refused.structuredContent as { error?: string }).error).toBe('NoProjectOpen')

    await newProject(page, { parentFolder: tmpDir('weftcut-mcp-playhead-'), name: 'mcp-playhead', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
    const track = await call<{ track_id: string }>(client, 'add_track', { label: 'Sequence' })
    const { layers } = await call<{ layers: Array<{ layer_id: string }> }>(client, 'add_layers', { layers: [
      { track_id: track.track_id, t_start_us: 0, t_end_us: 1_000_000, label: 'Opening', content: { kind: 'color', color: { r: 200, g: 40, b: 40, a: 255 } } },
      { track_id: track.track_id, t_start_us: 1_000_000, t_end_us: 2_000_000, label: 'Closing', content: { kind: 'color', color: { r: 40, g: 40, b: 200, a: 255 } } },
    ] })
    const [opening, closing] = layers.map((l) => l.layer_id)

    // The user parks on the second clip from the keyboard.
    await page.locator('[data-testid="timeline-ruler"]').click({ position: { x: 120, y: 10 } })
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(() => playheadUs(page)).toBe(1_000_000)

    const parked = await readSettled(client)
    expect(parked).toMatchObject({ t_us: 1_000_000, timecode: '00:00:01:00', playing: false, range: null })
    expect(parked.under_playhead.map((l) => l.layer_id)).toContain(closing)
    expect(parked.under_playhead.map((l) => l.layer_id)).not.toContain(opening)
    expect(parked.under_playhead.find((l) => l.layer_id === closing)).toMatchObject({ track_id: track.track_id, label: 'Closing' })

    // A selection and a marked range ride along, on the same clock.
    await page.keyboard.press('Home')
    await page.keyboard.press('i')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('o')
    await page.evaluate((id) => (window as any).__weftcutTest.revealLayer({ layerId: id }), opening)
    await expect.poll(async () => { const p = await readPlayhead(client!); return p.range !== null && p.selection.includes(opening!) }).toBe(true)
    const marked = await readSettled(client)
    expect(marked.selection).toContain(opening)
    expect(marked.range!.t_start_us).toBe(0)
    expect(marked.range!.t_end_us).toBeGreaterThan(1_000_000)
  } finally {
    await client?.close().catch(() => {})
    await app.close()
  }
})
