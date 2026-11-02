// A clip-compute call over a real MCP client (ADR 0121): progress to a caller
// that asked for it, the Activity row's live phase, the client's explicit
// cancel reaching native, a closed connection NOT reaching it, and the user's
// cancel answering the agent with a cancelled result.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from './server'
import { AgentActivityService } from '../agent/activity'
import { ComputeJobs } from '../compute/jobs'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { root } from '../state/__tests__/fixtures/project'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const VID = '00000000-0000-0000-0000-0000000000cc'
const OK = JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: '{"backend":"whisper_cpp","segments":[]}' }] } })

async function setup() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'compute'), idGen, clock: () => '<TS>' })
  const track = root(actor.snapshot()).tracks[0]!.id
  actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 6_000_000 })
  const add = actor.dispatch('add_layer', { track, kind: 'video', media: VID, src_in_us: 0, src_out_us: 6_000_000, t_start_us: 0, t_end_us: 6_000_000 })
  if (!add.ok) throw new Error(JSON.stringify(add.error))
  const layerId = add.value as string
  // transcribe_clip reads the audio that plays, so it is pointed at an Audio layer.
  const AUD = '00000000-0000-0000-0000-0000000000cd'
  actor.dispatch('add_media', { id: AUD, kind: 'Audio', duration_us: 6_000_000 })
  const addAudio = actor.dispatch('add_layer', { track: root(actor.snapshot()).tracks[1]!.id, kind: 'audio', media: AUD, src_in_us: 0, src_out_us: 6_000_000, t_start_us: 0, t_end_us: 6_000_000 })
  if (!addAudio.ok) throw new Error(JSON.stringify(addAudio.error))
  const audioId = addAudio.value as string
  const agent = new AgentActivityService(actor, vi.fn())
  agent.start()
  const pending: Array<{ args: Record<string, unknown>; resolve: (s: string) => void }> = []
  const backend = {
    mcpCatalog: async () => RUST_CATALOG,
    mcpCallTool: vi.fn((_name: string, argsJson: string) => new Promise<string>((resolve) => { pending.push({ args: JSON.parse(argsJson) as Record<string, unknown>, resolve }) })),
  }
  const cancel = vi.fn((_id: string) => true)
  const computeJobs = new ComputeJobs({ call: (n, a) => backend.mcpCallTool(n, a), cancel, beginModelUse: () => () => {} })
  const ts = {
    actor, agent, computeJobs,
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    motifTool: () => [], handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as never
  const server = buildMcpServer(backend as never, { getTsHost: () => ts })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'compute-test', version: '0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  const started = async () => { await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)); return computeJobs.snapshot().jobs[0]!.job_id }
  return { client, layerId, audioId, pending, cancel, computeJobs, agent, started }
}

describe('a clip-compute call over MCP', () => {
  it('sends progress on attach and on every phase, and keeps the Activity row on the phase', async () => {
    const h = await setup()
    const progress: Array<{ progress: number; message?: string }> = []
    const call = h.client.callTool({ name: 'transcribe_clip', arguments: { layer_ids: [h.audioId] } }, undefined, { onprogress: (p) => { progress.push(p) } })
    const jobId = await h.started()
    expect(h.pending[0]!.args.job_id).toBe(jobId)
    h.computeJobs.phase({ job_id: jobId, phase: { kind: 'loading_model' } })
    await vi.waitFor(() => expect(progress.map((p) => p.message)).toEqual(['Queued', 'Loading model']))
    expect(progress[1]!.progress).toBeGreaterThan(progress[0]!.progress)
    const row = h.agent.snapshot().activities.find((a) => a.tool === 'transcribe_clip')!
    expect(row).toMatchObject({ state: 'running', compute: { job_id: jobId, phase: { kind: 'loading_model' } } })
    h.pending[0]!.resolve(OK)
    const result = await call as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBeFalsy()
    // One envelope per layer, each naming the clip it read for apply_transcripts.
    const body = JSON.parse(result.content[0]!.text) as { transcripts: Array<{ source: { layer_id: string; signature: string }; backend: string }> }
    expect(body.transcripts).toHaveLength(1)
    expect(body.transcripts[0]).toMatchObject({ source: { layer_id: h.audioId }, backend: 'whisper_cpp' })
    expect(typeof body.transcripts[0]!.source.signature).toBe('string')
    expect(h.agent.snapshot().activities.find((a) => a.tool === 'transcribe_clip')!.state).toBe('done')
  })

  it('refuses the old single layer_id naming layer_ids, and lists a layer that plays nothing under failed', async () => {
    const h = await setup()
    const old = await h.client.callTool({ name: 'transcribe_clip', arguments: { layer_id: h.audioId } }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(old.isError).toBe(true)
    expect(old.content[0]!.text).toContain('layer_ids')
    const call = h.client.callTool({ name: 'transcribe_clip', arguments: { layer_ids: [h.layerId, h.audioId] } })
    await vi.waitFor(() => expect(h.pending.length).toBeGreaterThan(0))
    h.pending[0]!.resolve(OK)
    const result = await call as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(result.content[0]!.text) as { transcripts: unknown[]; failed: Array<{ layer_id: string; message: string }> }
    expect(body.transcripts).toHaveLength(1)
    expect(body.failed).toEqual([{ layer_id: h.layerId, message: expect.stringContaining('plays no sound') }])
  })

  it("forwards the client's explicit cancel to native", async () => {
    const h = await setup()
    const abort = new AbortController()
    const call = h.client.callTool({ name: 'transcribe_clip', arguments: { layer_ids: [h.audioId] } }, undefined, { signal: abort.signal })
    const jobId = await h.started()
    abort.abort('changed my mind')
    await expect(call).rejects.toThrow()
    await vi.waitFor(() => expect(h.cancel).toHaveBeenCalledExactlyOnceWith(jobId))
  })

  it('leaves the job running when the connection closes, and the row ends with the job', async () => {
    const h = await setup()
    void h.client.callTool({ name: 'describe_clip', arguments: { layer_id: h.layerId } }).catch(() => {})
    const jobId = await h.started()
    await h.client.close()
    await vi.waitFor(() => expect(h.computeJobs.snapshot().jobs[0]).toMatchObject({ job_id: jobId, caller_disconnected: true }))
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.agent.snapshot().activities.find((a) => a.tool === 'describe_clip')!.state).toBe('running')
    h.pending[0]!.resolve(OK)
    await vi.waitFor(() => expect(h.agent.snapshot().activities.find((a) => a.tool === 'describe_clip')!.state).toBe('done'))
  })

  it("answers a cancelled result when the user cancels the agent's job", async () => {
    const h = await setup()
    const call = h.client.callTool({ name: 'transcribe_clip', arguments: { layer_ids: [h.audioId] } })
    const jobId = await h.started()
    expect(h.computeJobs.cancel(jobId)).toBe(true)
    const result = await call as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Cancelled in WeftCut by the user')
    expect(result.structuredContent).toMatchObject({ code: 'cancelled', job_id: jobId, cancelled_by: 'user' })
  })

  it('runs describe_clip by media_id as a job a layer-addressed call over the same span joins', async () => {
    const h = await setup()
    const byMedia = h.client.callTool({ name: 'describe_clip', arguments: { media_id: VID } })
    const jobId = await h.started()
    expect(h.computeJobs.snapshot().jobs[0]).toMatchObject({ job_id: jobId, layer_id: '', media_id: VID, src_window: { src_start_us: 0, src_end_us: 6_000_000 } })
    expect(h.pending[0]!.args).toMatchObject({ media_id: VID, layer: null, job_id: jobId })
    const byLayer = h.client.callTool({ name: 'describe_clip', arguments: { layer_id: h.layerId, src_start_us: 0, src_end_us: 6_000_000 } })
    await vi.waitFor(() => expect(h.computeJobs.snapshot().jobs[0]!.callers).toBe(2))
    expect(h.computeJobs.cancel(jobId)).toBe(true)
    await Promise.all([byMedia, byLayer])
    expect(h.pending).toHaveLength(1)
  })

  it('joins a retry into the job still running', async () => {
    const h = await setup()
    const first = h.client.callTool({ name: 'transcribe_clip', arguments: { layer_ids: [h.audioId] } })
    await h.started()
    const second = h.client.callTool({ name: 'transcribe_clip', arguments: { layer_ids: [h.audioId] } })
    await vi.waitFor(() => expect(h.computeJobs.snapshot().jobs[0]!.callers).toBe(2))
    h.pending[0]!.resolve(OK)
    await Promise.all([first, second])
    expect(h.pending).toHaveLength(1)
  })
})
