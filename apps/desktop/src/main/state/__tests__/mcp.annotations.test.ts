import { EXPORT_TOOL_DEFS } from "../../mcp/exportTools";
// apps/desktop/src/main/state/__tests__/mcp.annotations.test.ts
// Annotations are the single source of the read/write and destructive split:
// every def carries `annotations`, `tools/list` emits them, and the activity
// service takes `readOnlyHint` from the same merged catalog — one statement of
// the fact, visible to the client. A second classifier (a regex over tool
// names) would drift from it invisibly, which is what these pins refuse.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MCP_TOOL_DEFS, ANN_READ, type ToolAnnotations } from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'
import { buildMcpServer } from '../../mcp/server'
import { AgentActivityService } from '../../agent/activity'
import { createActor } from '../actor'
import { seededGen, uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

vi.mock('../../motif/capture.js', () => ({ captureMotifFrameB64: async () => 'iVBOR' }))

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const rust = JSON.parse(RUST_CATALOG) as {
  tools: Array<{ name: string; description: string; input_schema?: unknown; inputSchema?: unknown; annotations?: Record<string, unknown> }>
}
const merged = mergeMcpCatalog(
  rust.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? t.input_schema) as Record<string, unknown>, annotations: t.annotations as ToolAnnotations | undefined })),
  [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS, ...EXPORT_TOOL_DEFS],
)
type Ann = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
const ann = (name: string): Ann => {
  const t = merged.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return (t.annotations ?? {}) as Ann
}

describe('every advertised tool carries annotations', () => {
  it('Rust, TS and motif tools alike, each stating read-only or a destructive hint', () => {
    const bare = merged.filter((t) => {
      const a = (t.annotations ?? {}) as Ann
      return a.readOnlyHint !== true && typeof a.destructiveHint !== 'boolean'
    }).map((t) => t.name)
    expect(bare).toEqual([])
  })

  it('a read-only tool claims nothing else; a write says whether it destroys', () => {
    for (const t of merged) {
      const a = (t.annotations ?? {}) as Ann
      if (a.readOnlyHint === true) expect(a.destructiveHint, t.name).toBeUndefined()
      else expect(typeof a.destructiveHint, t.name).toBe('boolean')
    }
  })
})

describe('the read set', () => {
  // A name-shaped fixture the read set is pinned against: the tools this
  // pattern names must be exactly the annotated reads, so a read tool whose
  // name starts with a verb is caught HERE if its annotation is wrong.
  const OLD_RULE = /^(get_|list_|read_|ping$|view_|analyze_|describe_|transcribe_|compare_|detect_|extract_|preview_)/
  // Reads whose names the pattern does not match — each one a review
  // decision, listed here so a stray annotation is still caught.
  const READS_BEYOND_THE_REGEX = ['export_captions', 'check_composition', 'render_frames']
  it('is exactly the set the retired name regex named, plus the reads added since', () => {
    const byAnnotation = merged.filter((t) => (t.annotations as Ann | undefined)?.readOnlyHint === true).map((t) => t.name).sort()
    const byRegex = [...merged.filter((t) => OLD_RULE.test(t.name)).map((t) => t.name), ...READS_BEYOND_THE_REGEX].sort()
    expect(byAnnotation).toEqual(byRegex)
    for (const n of ['read_project', 'get_param_track', 'preview_motif', 'extract_clip_audio', 'detect_pauses', 'ping']) expect(byAnnotation).toContain(n)
  })

  it('every TS read tool commits nothing — the snapshot and the history are what they were', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'reads'), idGen: gen, clock: () => '<TS>' })
    const aRoll = root(actor.snapshot()).tracks[0].id
    const added = actor.mcpCall('add_layers', JSON.stringify({ layers: [{ track_id: aRoll, t_start_us: 0, t_end_us: 1_000_000, content: { kind: 'color', color: { r: 0, g: 0, b: 0, a: 255 } } }] }))
    if (!added.ok) throw new Error(added.error.message)
    const layerId = (JSON.parse(added.result.content[0].text) as { layers: Array<{ layer_id: string }> }).layers[0]!.layer_id
    const argsFor: Record<string, Record<string, unknown>> = {
      read_project: { view: 'current' },
      get_param_track: { layer_id: layerId, param_key: 'color' }, // a Color layer animates its colour
      export_captions: { format: 'srt' },
      check_composition: {},
    }
    const reads = MCP_TOOL_DEFS.filter((d) => d.annotations.readOnlyHint === true).map((d) => d.name)
    expect(reads.sort()).toEqual(Object.keys(argsFor).sort()) // a new TS read tool needs its probe here
    for (const name of reads) {
      const before = actor.snapshot()
      const len = actor.historyStatus().len
      const r = actor.mcpCall(name, JSON.stringify(argsFor[name]))
      expect(r.ok, `${name}: ${r.ok ? '' : r.error.message}`).toBe(true)
      expect(actor.snapshot(), name).toBe(before) // the same object: nothing was replaced
      expect(actor.historyStatus().len, name).toBe(len)
    }
  })
})

describe('the destructive set', () => {
  it('is every removal and revert, and no read', () => {
    const destructive = merged.filter((t) => (t.annotations as Ann | undefined)?.destructiveHint === true).map((t) => t.name)
    for (const n of ['delete_layers', 'delete_track', 'delete_media', 'delete_marker', 'delete_effect', 'delete_transition', 'delete_link',
      'delete_composition', 'delete_keyframe', 'delete_motif',
      // Whole-track replacers: what they discard, undo is the way back to.
      'set_param_track', 'set_position',
      'remove_pauses', 'auto_split_by_shot', 'undo', 'redo', 'jump_to', 'restore_checkpoint', 'install_motif']) {
      expect(destructive, n).toContain(n)
    }
    for (const n of destructive) expect(n, 'a destructive read is a contradiction').not.toMatch(/^(get_|list_|read_)/)
    // Creation and setting are writes, not destruction.
    for (const n of ['add_layers', 'translate_position', 'update_layer_params', 'create_link', 'set_project_settings']) expect(ann(n).destructiveHint).toBe(false)
  })

  it('a set is idempotent, a creation is not', () => {
    expect(ann('set_position').idempotentHint).toBeUndefined() // replacement generates fresh node/key IDs
    expect(ann('set_param_track').idempotentHint).toBeUndefined()
    expect(ann('rename_layer').idempotentHint).toBe(true)
    expect(ann('set_layer_flags').idempotentHint).toBe(true)
    expect(ann('move_layers').idempotentHint).toBeUndefined() // a delta is not idempotent
    expect(ann('shift_layers').idempotentHint).toBeUndefined()
    expect(ann('add_track').idempotentHint).toBeUndefined()
    expect(ann('paste_layers').idempotentHint).toBeUndefined()
  })
})

describe('the wire and the activity service read the same fact', () => {
  async function connected() {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 'ann'), idGen, clock: () => '<TS>' })
    const agent = new AgentActivityService(actor, vi.fn())
    agent.start()
    const ts = {
      actor, agent,
      mcpCall: (n: string, a: string) => actor.mcpCall(n, a),
      hybridDeps: { actor, compute: {}, enqueueDerivatives: vi.fn(), enqueueWorkspaceCopy: vi.fn(), workspaceDir: () => null, readFile: () => '', statPath: () => null, snapshotComposition: () => root(actor.snapshot()) },
      motifTool: () => null, handleInvoke: async () => null, start: () => {}, stop: () => {},
    } as any
    const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => '{"ok":true,"result":{"contents":[]}}', mcpCatalog: async () => RUST_CATALOG, mcpListPrompts: async () => '[]' } as any
    const server = buildMcpServer(backend, { getTsHost: () => ts })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'annotations-test', version: '0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return { client, agent, actor }
  }

  it('tools/list carries the annotations', async () => {
    const { client } = await connected()
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t.annotations as Ann | undefined]))
    expect(byName.get('read_project')?.readOnlyHint).toBe(true)
    expect(byName.get('delete_layers')?.destructiveHint).toBe(true)
    expect(byName.get('ping')?.readOnlyHint).toBe(true)
    expect(byName.get('list_motifs')?.readOnlyHint).toBe(true)
    expect(tools.every((t) => t.annotations !== undefined)).toBe(true)
  })

  it('a read tool is logged as a read, a write as an operation — from the catalog, not the name', async () => {
    const { client, agent, actor } = await connected()
    const aRoll = root(actor.snapshot()).tracks[0].id
    await client.callTool({ name: 'read_project', arguments: { view: 'current' } })
    await client.callTool({ name: 'add_layers', arguments: { layers: [{ track_id: aRoll, t_start_us: 0, t_end_us: 1_000_000, content: { kind: 'color', color: { r: 0, g: 0, b: 0, a: 255 } } }] } })
    const kinds = Object.fromEntries(agent.snapshot().activities.filter((a) => a.tool === 'read_project' || a.tool === 'add_layers').map((a) => [a.tool, a.kind]))
    expect(kinds).toEqual({ read_project: 'read', add_layers: 'operation' })
  })
})

describe('an unrecorded mutator says so', () => {
  it('in one word, at the end, on every tool whose write undo walks past', () => {
    const desc = (name: string): string => merged.find((t) => t.name === name)?.description ?? ''
    for (const n of ['set_track_flags', 'create_checkpoint']) expect(desc(n), n).toMatch(/Unrecorded\.$/)
    for (const n of ['update_composition', 'set_project_settings', 'set_role_flags', 'delete_media', 'import_media']) expect(desc(n), n).toContain('Unrecorded')
    // The session tools write too — a view, a lock, a checkpoint pin — and undo
    // walks past all three.
    for (const n of ['begin_agent_session', 'end_agent_session']) expect(desc(n), n).toContain('Unrecorded')
    // and a recorded edit does not carry the word
    for (const n of ['add_layers', 'delete_layers', 'rename_composition', 'set_role_gain']) expect(desc(n), n).not.toContain('Unrecorded')
  })
  it('ANN_READ is what the TS reads carry', () => {
    for (const n of ['read_project', 'get_param_track', 'export_captions']) expect(MCP_TOOL_DEFS.find((d) => d.name === n)!.annotations).toBe(ANN_READ)
  })
})
