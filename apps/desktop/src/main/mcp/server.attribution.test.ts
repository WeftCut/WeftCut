// An MCP call records as the agent that made it — on the history entry, the
// checkpoint, a hybrid's commits and the log pin-rows — and never as the
// production instance's `User`. Every case drives a DISTINCT client name:
// asserting the fallback is what let the literal spread unnoticed.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { handleCallTool } from './server'
import { createActor } from '../state/actor'
import { createTsActorHost } from '../state/ts-actor-host'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { CLIENT_MAX_BYTES, mcpActor, normalizeClientName } from '../state/mcp-actor'
import { root } from '../state/__tests__/fixtures/project'

const CLIENT = 'claude-desktop'
const AGENT = { kind: 'Agent', client: CLIENT }
const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => '{"ok":true,"result":{}}', mcpCatalog: async () => RUST_CATALOG } as any

/** A host whose actor is the production shape: no `actor` option, so the
 *  instance records as `{ kind: 'User' }`. */
function host() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'attr'), idGen, clock: () => '<TS>' })
  const cue = { start_us: 0, end_us: 1_000_000, text: 'a', style: { size_px: 54, outline_px: 3, shadow_px: 2 } }
  const hybridDeps = {
    actor,
    compute: {
      probeMedia: vi.fn(), hashMediaSource: vi.fn(),
      parseSubtitles: vi.fn(async () => JSON.stringify({ cues: [cue], simplified: false })), synthesizeSpeechCompute: vi.fn(),
    },
    enqueueDerivatives: vi.fn(async () => {}),
    enqueueWorkspaceCopy: vi.fn(async () => {}),
    workspaceDir: () => null,
    readFile: () => '',
    statPath: () => ({ kind: 'file' as const, readable: true }),
    snapshotComposition: () => root(actor.snapshot()),
  }
  return { actor, mcpCall: (n: string, a: string, c?: string) => actor.mcpCall(n, a, c), hybridDeps, handleInvoke: async () => null, start: () => {}, stop: () => {} } as any
}
const lastOp = (ts: any) => { const v = ts.actor.historyView(50); return v.ops[v.ops.length - 1] }

describe('MCP client attribution', () => {
  it('a table-exec mutation records as the calling agent, not the instance User', async () => {
    const ts = host()
    const track = root(ts.actor.snapshot()).tracks[0].id
    await handleCallTool(backend, () => ts, 'add_color_layer', { track_id: track, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }, undefined, undefined, undefined, CLIENT)
    expect(lastOp(ts).actor).toEqual(AGENT)
  })

  it('a checkpoint and a restore record as the calling agent', async () => {
    const ts = host()
    const made: any = await handleCallTool(backend, () => ts, 'create_checkpoint', { label: 'cp' }, undefined, undefined, undefined, CLIENT)
    expect(ts.actor.listCheckpoints()[0].actor).toEqual(AGENT)
    await handleCallTool(backend, () => ts, 'restore_checkpoint', { checkpoint_id: made.structuredContent.checkpoint_id }, undefined, undefined, undefined, CLIENT)
    expect(lastOp(ts).actor).toEqual(AGENT)
  })

  it("a hybrid's commits record as the calling agent", async () => {
    const ts = host()
    const out: any = await handleCallTool(backend, () => ts, 'apply_subtitles', { body: '1\n00:00:00,000 --> 00:00:01,000\na\n', format: 'srt' }, undefined, undefined, undefined, CLIENT)
    expect(out.isError).toBeFalsy()
    expect(lastOp(ts).actor).toEqual(AGENT)
  })

  it('the renderer path on the same actor still records as User', () => {
    const ts = host()
    ts.actor.dispatch('add_track', { label: 'mine' })
    expect(lastOp(ts).actor).toEqual({ kind: 'User' })
  })

  it('an MCP call with no named client records as the transport fallback', () => {
    const ts = host()
    ts.actor.mcpCall('add_track', JSON.stringify({ label: 'x' }))
    expect(lastOp(ts).actor).toEqual({ kind: 'Agent', client: 'mcp' })
  })

  it("the host's checkpoint and restore pin-rows name the client", () => {
    const emitLog = vi.fn()
    const deps = {
      send: () => {}, mcpNotify: () => {}, fileExists: () => false,
      fs: { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} },
      join: (...p: string[]) => p.join('/'),
      napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: async () => {} },
      compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
      enqueueWorkspaceCopy: async () => {}, readFile: () => '', statPath: () => ({ kind: 'file' as const, readable: true }), workspaceDir: () => null,
      emitLog,
    }
    const h = createTsActorHost(deps as any)
    h.start()
    const made = h.mcpCall('create_checkpoint', JSON.stringify({ label: 'cp' }), CLIENT) as any
    h.mcpCall('restore_checkpoint', JSON.stringify({ checkpoint_id: made.result.structuredContent.checkpoint_id }), CLIENT)
    const kinds = emitLog.mock.calls.map(([e]) => e).filter((e) => e.details?.kind === 'Checkpoint' || e.details?.kind === 'Restore')
    expect(kinds.map((e) => e.details.kind)).toEqual(['Checkpoint', 'Restore'])
    for (const e of kinds) expect(e.source).toEqual(AGENT)
  })
})

describe('client name normalization', () => {
  it('strips control characters and trims', () => {
    expect(normalizeClientName('  claude\u0000-\u001bcode\u0085 ')).toBe('claude-code')
  })
  it('falls back to mcp when nothing is left', () => {
    expect(normalizeClientName('')).toBe('mcp')
    expect(normalizeClientName(' \u0007 ')).toBe('mcp')
    expect(normalizeClientName(undefined)).toBe('mcp')
    expect(mcpActor()).toEqual({ kind: 'Agent', client: 'mcp' })
  })
  it(`clamps to ${CLIENT_MAX_BYTES} UTF-8 bytes on a code-point boundary`, () => {
    expect(normalizeClientName('x'.repeat(4096))).toBe('x'.repeat(CLIENT_MAX_BYTES))
    const cjk = normalizeClientName('客'.repeat(40)) // 3 bytes each
    expect(Buffer.byteLength(cjk, 'utf8')).toBeLessThanOrEqual(CLIENT_MAX_BYTES)
    expect(cjk).toBe('客'.repeat(21))
  })
})
