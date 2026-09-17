import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer, handleCallTool, handleReadResource } from './server'
import { HOST_RESOURCE_DEFS, HOST_RESOURCE_TEMPLATES } from './hostResources'
import { mediaItemTemplate } from '../state/mutations/media'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'res'), idGen, clock: () => '<TS>' })
  return { actor, motifTool: () => [] } as any
}
function fakeBackend(spy: (u: string, s?: string) => Promise<string>) {
  return { mcpReadResource: spy } as any
}
function contents(out: unknown) {
  return (out as { contents: Array<{ text: string; mimeType: string }> }).contents
}

describe('handleReadResource', () => {
  it('serves project://current from the actor without calling the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"contents":[]}}')
    const out = await handleReadResource(fakeBackend(spy), () => ts, 'project://current')
    expect(spy).not.toHaveBeenCalled()
    expect(contents(out)[0].mimeType).toBe('application/json')
    expect(JSON.parse(contents(out)[0].text).project_id).toBe(ts.actor.snapshot().project_id)
  })
  it('serves project://history from the actor (no backend call)', async () => {
    const ts = tsHostStub()
    const out = await handleReadResource(fakeBackend(async () => { throw new Error('no backend') }), () => ts, 'project://history')
    const body = JSON.parse(contents(out)[0].text)
    expect(Array.isArray(body.ops)).toBe(true)
  })
  it('forwards project://compiled to the backend with the injected project', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[{"uri":"project://compiled","mimeType":"application/json","text":"{}"}]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'project://compiled')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('project://compiled')
    expect(JSON.parse(spy.mock.calls[0][1] as string).project.project_id).toBe(ts.actor.snapshot().project_id)
  })
  it('forwards media://{id} with the resolved MediaItem (null when absent)', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'media://gone/thumbnail')
    const injected = JSON.parse(spy.mock.calls[0][1] as string)
    expect('media' in injected).toBe(true)
    expect(injected.media).toBeNull()
  })
  // media://{id}/description is the READ half of the description cache key, and
  // the tool is the write half (`server.flip.test.ts`). One provider fills both,
  // so the whole view has to reach both — a missing axis here does not fail, it
  // reports every source as undescribed, which reads as lost prose.
  it('forwards media://{id}/description with the WHOLE describe view, preference included', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'media://m1/description', () => ({
      config: { qwen3_vl: { kind: 'local' } },
      preferred: 'byo_endpoint',
      language: 'zh-CN',
      fps: 2.5,
      focus: 'shot-type',
    }))
    const injected = JSON.parse(spy.mock.calls[0][1] as string)
    expect(injected.vlm_config).toEqual({ qwen3_vl: { kind: 'local' } })
    expect(injected.language).toBe('zh-CN')
    expect(injected.describe_fps).toBe(2.5)
    expect(injected.describe_focus).toBe('shot-type')
    expect(injected.describe_preferred).toBe('byo_endpoint')
  })
  it('forwards composition://meter with no state injection', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'composition://meter')
    expect(spy.mock.calls[0][1]).toBe('{}')
  })
})

describe('resources/templates/list and resources/list (audit S4)', () => {
  const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
  async function connected() {
    const ts = tsHostStub()
    const backend = { mcpCatalog: async () => RUST_CATALOG, mcpReadResource: async () => '{"ok":true,"result":{"contents":[]}}' } as any
    const server = buildMcpServer(backend, { getTsHost: () => ts })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'resources-test', version: '0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return client
  }

  it('advertises every parameterised family as an RFC 6570 template with a description', async () => {
    const client = await connected()
    const { resourceTemplates } = await client.listResourceTemplates()
    const templates = resourceTemplates.map((t) => t.uriTemplate).sort()
    expect(templates).toEqual(HOST_RESOURCE_TEMPLATES.map((t) => t.uriTemplate).sort())
    for (const want of ['project://layers/{id}', 'project://tracks{?composition}', 'project://composition{?composition}', 'media://{id}/frame/{t_us}', 'media://{id}/thumbnail']) expect(templates).toContain(want)
    for (const t of resourceTemplates) expect(typeof t.description, t.uriTemplate).toBe('string')
  })

  it('resources/list carries the TS-served views, the TS description winning over the Rust one for the same URI', async () => {
    const client = await connected()
    const { resources } = await client.listResources()
    const byUri = new Map(resources.map((r) => [r.uri, r]))
    for (const d of HOST_RESOURCE_DEFS) expect(byUri.get(d.uri)?.description, d.uri).toBe(d.description)
    expect(byUri.get('project://tracks')?.description).toContain('ENVELOPES')
    expect(resources.filter((r) => r.uri === 'project://tracks')).toHaveLength(1)
    for (const uri of ['project://links', 'project://transitions', 'project://settings', 'project://session']) expect(byUri.has(uri), uri).toBe(true)
  })
})

describe('read_project picture views answer an image block from the media reader', () => {
  const MID = '00000000-0000-0000-0000-0000000000aa'
  function host() {
    const ts = tsHostStub()
    ts.actor.dispatch('add_media_item', { media: mediaItemTemplate(MID, 'Video', 4_000_000) })
    ts.mcpCall = (n: string, a: string) => ts.actor.mcpCall(n, a)
    return ts
  }
  it('media_thumbnail reads media://{id}/thumbnail and returns the blob as an image', async () => {
    const ts = host()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[{"uri":"media://x/thumbnail","mimeType":"image/jpeg","blob":"/9j/AAAA"}]}}')
    const out = await handleCallTool(fakeBackend(spy), () => ts, 'read_project', { view: 'media_thumbnail', id: MID }) as { content: Array<Record<string, unknown>> }
    expect(spy.mock.calls[0][0]).toBe(`media://${MID}/thumbnail`)
    expect(out.content[0]).toEqual({ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' })
  })
  it('media_frame needs t_us and reads media://{id}/frame/{t_us}', async () => {
    const ts = host()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[{"uri":"u","mimeType":"image/jpeg","blob":"QUJD"}]}}')
    await handleCallTool(fakeBackend(spy), () => ts, 'read_project', { view: 'media_frame', id: MID, t_us: 1_500_000 })
    expect(spy.mock.calls[0][0]).toBe(`media://${MID}/frame/1500000`)
    const refused = await handleCallTool(fakeBackend(spy), () => ts, 'read_project', { view: 'media_frame', id: MID }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('t_us')
    const noId = await handleCallTool(fakeBackend(spy), () => ts, 'read_project', { view: 'media_thumbnail' }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(noId.isError).toBe(true)
    expect(noId.content[0].text).toContain('media id')
  })
})
