// apps/desktop/src/main/mcp/server.errors.test.ts
// The error CHANNEL of a tool call. MCP reserves JSON-RPC errors for a
// malformed request and an unknown tool; everything that goes wrong inside a
// tool is a `CallToolResult { isError: true }`, which is the channel the model
// reads. Before this gate every refusal — a bad argument, a stale id, a blocked
// ripple, a compute failure — travelled as a JSON-RPC error whose `data` no
// client shows and whose code some clients count as a server fault.
//
// Driven two ways: `handleCallTool` directly for each route, and over a real
// in-memory transport so the CLIENT's view is what is asserted — a refusal
// resolves, an unknown tool rejects.
import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readFileSync } from 'node:fs'
import { buildMcpServer, handleCallTool } from './server'
import { isToolError, thrownToToolError, toolErrorResult, UnknownToolError } from './toolResult'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { mediaItemTemplate } from '../state/mutations/media'
import { root } from '../state/__tests__/fixtures/project'

vi.mock('../motif/capture.js', () => ({ captureMotifFrameB64: async () => { throw new Error('no renderer in a unit test') } }))

const MID = '00000000-0000-0000-0000-0000000000aa'
const NOWHERE = '00000000-0000-7000-8000-00000000dead'
const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')

function tsHostStub(overrides: { compute?: Record<string, unknown>; motifTool?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'errors'), idGen, clock: () => '<TS>' })
  const hybridDeps = {
    actor,
    compute: {
      probeMedia: vi.fn(async () => JSON.stringify(mediaItemTemplate(MID, 'Video', 4_000_000))),
      hashMediaSource: vi.fn(async () => 'h'),
      parseSubtitles: vi.fn(), synthesizeSpeechCompute: vi.fn(async () => '{}'),
      ...overrides.compute,
    },
    enqueueDerivatives: vi.fn(async () => {}),
    enqueueWorkspaceCopy: vi.fn(async () => {}),
    workspaceDir: () => null,
    readFile: () => '',
    snapshotComposition: () => root(actor.snapshot()),
  }
  return {
    actor, hybridDeps,
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    motifTool: overrides.motifTool ?? (() => { throw new Error("unknown draft 'd1'") }),
    handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
}
function fakeBackend(mcpCallTool: (n: string, a: string) => Promise<string> = async () => { throw new Error('rust must not be called') }) {
  return {
    mcpCallTool,
    mcpReadResource: async () => '{"ok":true,"result":{"contents":[]}}',
    mcpCatalog: async () => RUST_CATALOG,
    mcpListPrompts: async () => '[]',
    mcpGetPrompt: async () => '{"ok":true,"result":{"messages":[]}}',
  } as any
}
type ErrResult = { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }
const asErr = (r: unknown): ErrResult => { expect(isToolError(r), JSON.stringify(r)).toBe(true); return r as ErrResult }

describe('handleCallTool — every route answers a refusal as an isError result', () => {
  it('a TS parser refusal (bad argument) is a result, with the code and the message mirrored in structuredContent', async () => {
    const out = asErr(await handleCallTool(fakeBackend(), () => tsHostStub(), 'move_layer', {}))
    expect(out.content[0].text).toContain('layer_id not a UUID')
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params', message: out.content[0].text })
  })

  it('a TS actor refusal (stale id) is a result; the mapper\'s data rides in structuredContent', async () => {
    const ts = tsHostStub()
    const trackId = root(ts.actor.snapshot()).tracks[0].id
    const args = { track_id: trackId, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }
    const first = await handleCallTool(fakeBackend(), () => ts, 'add_color_layer', args)
    expect(isToolError(first)).toBe(false)
    const out = asErr(await handleCallTool(fakeBackend(), () => ts, 'add_color_layer', args))
    expect(out.content[0].text).toContain('layer overlap')
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params', error: 'LayerOverlap', track: trackId })
    expect(Array.isArray(out.structuredContent.options)).toBe(true)
  })

  it('a hybrid arm that throws a CommandError JSON gets the same mapper every table tool gets', async () => {
    // remove_pauses on a layer that does not exist: the hybrid resolves the
    // subject first and throws — the thrown text must NOT reach the agent as a
    // raw JSON struct.
    const ts = tsHostStub({ compute: { detectPauses: vi.fn(async () => ({ pauses: [], noise_floor_amp: 0, peaks_source: 'raw' })) } })
    const out = asErr(await handleCallTool(fakeBackend(), () => ts, 'remove_pauses', { layer_id: NOWHERE }))
    expect(out.content[0].text).not.toMatch(/^\{/)
    expect(out.content[0].text).toContain(NOWHERE)
  })

  it('a hybrid whose args miss the TS def\'s parser is refused before any compute runs', async () => {
    const ts = tsHostStub()
    const out = asErr(await handleCallTool(fakeBackend(), () => ts, 'remove_pauses', { layer_id: 'not-a-uuid' }))
    expect(out.structuredContent.code).toBe('invalid_params')
    expect(out.content[0].text).toContain('layer_id not a UUID')
  })

  it('a Rust-sourced hybrid with missing fields is refused in one sentence naming every field, before compute', async () => {
    const ts = tsHostStub()
    const out = asErr(await handleCallTool(fakeBackend(), () => ts, 'synthesize_speech', {}))
    expect(out.content[0].text).toBe('synthesize_speech: missing required `text`; missing required `voice`')
    expect(ts.hybridDeps.compute.synthesizeSpeechCompute).not.toHaveBeenCalled()
  })

  it('a compute failure inside a hybrid is a result, not a throw, and keeps the message', async () => {
    const ts = tsHostStub({ compute: { probeMedia: vi.fn(async () => { throw new Error('open C:/nope.mp4: no such file (os error 2)') }) } })
    const out = asErr(await handleCallTool(fakeBackend(), () => ts, 'import_media', { path: 'C:/nope.mp4' }))
    expect(out.content[0].text).toContain('nope.mp4')
    expect(out.structuredContent.code).toBe('internal')
  })

  it('a motif-store failure is the caller\'s: invalid_params with the store\'s message', async () => {
    const out = asErr(await handleCallTool(fakeBackend(), () => tsHostStub(), 'install_motif', { draft_id: 'd1', mode: 'new' }))
    expect(out.content[0].text).toBe("unknown draft 'd1'")
    expect(out.structuredContent.code).toBe('invalid_params')
  })

  it('a Rust envelope refusal is a result', async () => {
    const backend = fakeBackend(async () => '{"ok":false,"error":{"code":"invalid_params","message":"layer x not found","data":{"layer":"x"}}}')
    const out = asErr(await handleCallTool(backend, () => tsHostStub(), 'ping', {}))
    expect(out.content[0].text).toBe('layer x not found')
    expect(out.structuredContent).toEqual({ code: 'invalid_params', message: 'layer x not found', layer: 'x' })
  })

  it('a clip-compute refusal thrown as an SDK-shaped error maps its code back', async () => {
    const backend = fakeBackend(async () => '{"ok":false,"error":{"code":"invalid_params","message":"layer gone not found"}}')
    const out = asErr(await handleCallTool(backend, () => tsHostStub(), 'analyze_clip', { layer_id: NOWHERE }))
    expect(out.structuredContent.code).toBe('invalid_params')
  })

  it('a bare-core call (no host) still answers a refusal as a result', async () => {
    const backend = fakeBackend(async () => '{"ok":false,"error":{"code":"invalid_params","message":"stub"}}')
    const out = asErr(await handleCallTool(backend, () => null, 'ping', {}))
    expect(out.content[0].text).toBe('stub')
  })

  it('the preview capture failing is a result too', async () => {
    const out = asErr(await handleCallTool(fakeBackend(), () => tsHostStub({ motifTool: () => [] }), 'preview_motif_draft', { id: 'x' }))
    expect(out.content[0].text).toContain('no renderer')
  })

  it('an unknown tool NAME is the one refusal that still throws — a malformed request, not a tool\'s answer', async () => {
    await expect(handleCallTool(fakeBackend(), () => tsHostStub(), 'no_such_tool', {})).rejects.toBeInstanceOf(UnknownToolError)
    const rustSaysUnknown = fakeBackend(async () => '{"ok":false,"error":{"code":"not_found","message":"unknown tool \'zzz\'"}}')
    await expect(handleCallTool(rustSaysUnknown, () => null, 'zzz', {})).rejects.toMatchObject({ code: -32602, message: 'Unknown tool: zzz' })
  })

  it('a success is untouched', async () => {
    const ts = tsHostStub()
    const out = await handleCallTool(fakeBackend(), () => ts, 'add_track', { label: 'x' })
    expect(isToolError(out)).toBe(false)
    expect((out as { content: Array<{ text: string }> }).content[0].text).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('over the wire, the client sees a result for a refusal and a rejection for an unknown tool', () => {
  async function connected() {
    const server = buildMcpServer(fakeBackend(), { getTsHost: () => tsHostStub() })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'errors-test', version: '0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return client
  }

  it('a refusal RESOLVES with isError and the text the model reads', async () => {
    const client = await connected()
    const out = await client.callTool({ name: 'move_layer', arguments: {} })
    expect(out.isError).toBe(true)
    expect((out.content as Array<{ text: string }>)[0].text).toContain('layer_id not a UUID')
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params' })
  })

  it('an unknown tool REJECTS with the spec\'s invalid-params code', async () => {
    const client = await connected()
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toMatchObject({ code: -32602 })
  })
})

describe('thrownToToolError', () => {
  it('parses a hybrid\'s CommandError JSON through the mapper', () => {
    const out = thrownToToolError(new Error(JSON.stringify({ error: 'RippleInsideHole', layer: 'L1', hole: { s: 0, e: 5 } })))
    expect(out.code).toBe('invalid_params')
    expect(out.message).toContain('L1')
    expect(out.message).toContain('[0, 5)')
  })

  it('classifies serde text as an argument fault and drops the buffer position', () => {
    const out = thrownToToolError(new Error('invalid args for synthesize_speech: missing field `text` at line 1 column 2'))
    expect(out).toEqual({ code: 'invalid_params', message: 'invalid args for synthesize_speech: missing field `text`' })
  })

  it('classifies the hybrid arms\' own argument prose as an argument fault', () => {
    expect(thrownToToolError(new Error('remove_pauses: layer_id is required')).code).toBe('invalid_params')
    expect(thrownToToolError(new Error('pad_us -1 must be a whole number of microseconds ≥ 0')).code).toBe('invalid_params')
  })

  it('a plain message takes the fallback code', () => {
    expect(thrownToToolError(new Error('pause detection is not available in this build')).code).toBe('internal')
    expect(thrownToToolError(new Error("unknown draft 'd1'"), 'invalid_params').code).toBe('invalid_params')
  })

  it('maps a thrown SDK-shaped envelope error back onto its envelope code and keeps data', () => {
    const e = Object.assign(new Error('layer x not found'), { code: -32602, data: { layer: 'x' } })
    expect(thrownToToolError(e)).toEqual({ code: 'invalid_params', message: 'layer x not found', data: { layer: 'x' } })
  })

  it('toolErrorResult flattens object data beside code and message, and boxes anything else', () => {
    expect((toolErrorResult({ code: 'invalid_params', message: 'm', data: { a: 1 } }) as { structuredContent: unknown }).structuredContent)
      .toEqual({ code: 'invalid_params', message: 'm', a: 1 })
    expect((toolErrorResult({ code: 'internal', message: 'm', data: [1] }) as { structuredContent: unknown }).structuredContent)
      .toEqual({ code: 'internal', message: 'm', data: [1] })
    expect((toolErrorResult({ code: 'internal', message: 'm' }) as { structuredContent: unknown }).structuredContent)
      .toEqual({ code: 'internal', message: 'm' })
  })
})
