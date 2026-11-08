// apps/desktop/src/main/state/__tests__/mcp.error-vocabulary.test.ts
// No refusal is a bare variant name: `TrackLocked` or `LayerNotFound` alone is
// a dead end — no id echoed, no next step, and for a multi-id call no way to
// tell which id failed. This gate enumerates every `CommandError` variant with
// representative fields and asserts the message is prose that names its ids,
// plus the three refusals with a shape of their own: per-tool ripple remedies,
// overlap options that would actually succeed, and the two structured messages
// the descriptions promise.
//
// The second half sweeps the WHOLE catalog through `handleCallTool` (TS, Motif,
// export, render and the Rust snapshot), with every seam below the MCP layer
// failing in the raw words it really uses — Electron's IPC wrapper, errno
// text, admission JSON. Every refusal must come back in the error model's
// shape, and no result text may carry those words or name an event no MCP
// client receives.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_TOOL_DEFS, mapCommandError } from '../mcp-commands'
import type { CommandError } from '../errors'
import { handleCallTool } from '../../mcp/server'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { EXPORT_TOOL_DEFS } from '../../mcp/exportTools'
import { ExportJobError, ExportJobs } from '../../exportJobs'
import { AgentActivityService } from '../../agent/activity'
import { createActor } from '../actor'
import { createMediaImporter } from '../mediaImport'
import { uuidV7Gen } from '../ids'
import { blankProject, rootComposition } from '../model'
import { root } from './fixtures/project'
import { MotifRefusal, revisionConflict } from '../../motif/refusal'

/** A capture failing with the raw IPC text the model must never see. */
const failingCapture = async (): Promise<string> => { throw new Error("Error invoking remote method 'motif:capture': Error: capture failed") }

const L1 = '00000000-0000-7000-8000-000000000001'
const L2 = '00000000-0000-7000-8000-000000000002'
const T1 = '00000000-0000-7000-8000-0000000000aa'
const X1 = '00000000-0000-7000-8000-0000000000ee'

/** One sample per variant of the union — a variant added to
 *  shared/commandErrors.ts without a row here is the only way past this gate,
 *  and the default arm names it as such. */
const EVERY_VARIANT: CommandError[] = [
  { error: 'TrackNotFound', track: T1 },
  { error: 'LayerNotFound', layer: L1 },
  { error: 'CompositionNotFound', composition: X1 },
  { error: 'CrossCompositionMove', layer: L1, from: X1, to: T1 },
  { error: 'CrossCompositionSet', layer: L1, composition: X1, expected: T1 },
  { error: 'WrongLayerKind', layer: L1, expected: 'Audio' },
  { error: 'MarkerNotFound', marker: X1 },
  { error: 'TransitionNotFound', transition: X1 },
  { error: 'TransitionLayersNotAdjacent', from: L1, to: L2, duration: 500_000 },
  { error: 'TransitionUnsupportedLayerKind', layer: L1, kind: 'Audio' },
  { error: 'TransitionInsufficientHandle', layer: L1, available_us: 100 },
  { error: 'TransitionRestoreCollision', layer: L1 },
  { error: 'TransitionParticipantsShareLink', from: L1, to: L2 },
  { error: 'CheckpointNotFound', checkpoint: X1 },
  { error: 'MediaNotFound', media: X1 },
  { error: 'MediaInUse', media: X1, referenced_by: [L1, L2] },
  { error: 'TrackPositionOutOfRange', position: 7, len: 3 },
  { error: 'TrackNotEmpty', track: T1 },
  { error: 'TrackNotRemovable', track: T1 },
  { error: 'TrackReserved', track: T1 },
  { error: 'TrackLocked', track: T1 },
  { error: 'RippleInsideHole', layer: L1, hole: { s: 0, e: 5 } },
  { error: 'RippleCollision', moving: L1, blocking: L2, track: T1 },
  { error: 'RippleLinkStraddles', link: X1, hole: { s: 0, e: 5 } },
  { error: 'RippleLockedLayer', layer: L1 },
  { error: 'ShiftLinkStraddles', link: X1, from_t_us: 2_000_000 },
  { error: 'GapNotFound', track: T1, s: 1, e: 2 },
  { error: 'SplitOutsideLayer', layer: L1, at_t: 9 },
  { error: 'LinkLockedMember', link: X1, locked_layer: L1, touched: L2 },
  { error: 'TrimEdgeOutOfRange', layer: L1, new_t: 0, cur_start: 0, cur_end: 9 },
  { error: 'LayerParamsKindMismatch', layer: L1, actual: 'Text', patch: 'Color' },
  { error: 'LinkNotFound', link: X1 },
  { error: 'LayerAlreadyLinked', layer: L1, existing: X1 },
  { error: 'LinkCreateNeedsTwoLayers', got: 1 },
  { error: 'LayerNotInLink', link: X1, layer: L1 },
  { error: 'GroupLockedMember', layer: L1 },
  { error: 'GroupNotPlain', layer: L1, reason: 'opacity' },
  { error: 'CompositionInUse', composition: X1, ref_count: 2 },
  { error: 'RootComposition', composition: X1 },
  { error: 'NothingToUndo' },
  { error: 'NothingToRedo' },
  { error: 'HistoryLocked', reason: 'batch in progress' },
  { error: 'ValidationFailed', detail: { rule: 'DuplicateLayerId', layer: L1 } },
  { error: 'ValidationFailed', detail: { rule: 'MissingMedia', layer: L1, media: X1 } },
  { error: 'EmptyKeyframeTrack', layer: L1, param_key: 'opacity' },
  { error: 'UnknownKeyframeParam', layer: L1, param_key: 'wobble' },
  { error: 'EffectNotFound', effect: X1 },
  { error: 'EffectIndexOutOfRange', index: 4, len: 2 },
  { error: 'EffectKindNotApplicable', kind: 'audio.denoise', layer_kind: 'Text' },
  { error: 'AudioEffectParamStatic', effect: X1, param: 'strength' },
  { error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 3, locked_by: 'current' },
  { error: 'RetimeRejected', reason: { kind: 'Collision', layer_id: L1, blocking_layer_id: L2, requested_duration: { num: 9, den: 1 }, maximum_duration_us: 4_000_000, minimum_rate: { num: 3, den: 2 } } },
  { error: 'RetimeRejected', reason: { kind: 'Locked', layer_id: L1 } },
  { error: 'RetimeRejected', reason: { kind: 'Transition', transition_id: X1 } },
  { error: 'InvalidArgument', field: 'pad_us', detail: 'must be >= 0' },
  { error: 'Backend', detail: 'ffprobe exited 1' },
]

const ID_FIELDS = ['track', 'layer', 'composition', 'marker', 'transition', 'checkpoint', 'media', 'link', 'effect', 'from', 'to', 'moving', 'blocking', 'locked_layer', 'touched', 'existing'] as const

describe('every CommandError variant maps to prose that names its ids', () => {
  for (const e of EVERY_VARIANT) {
    it(`${e.error}${'detail' in e ? ` / ${(e.detail as { rule: string }).rule}` : ''}`, () => {
      const out = mapCommandError(e)
      expect(out.message).not.toBe(e.error)
      // InvalidArgument and Backend carry the caller's own detail as the message
      // — as long as the detail; every other arm writes a sentence.
      if (e.error !== 'InvalidArgument' && e.error !== 'Backend') expect(out.message.length).toBeGreaterThan(e.error.length + 10)
      // Every id the variant carries appears in the text, so a multi-id call can
      // tell WHICH one failed.
      for (const f of ID_FIELDS) {
        const v = (e as Record<string, unknown>)[f]
        if (typeof v === 'string') expect(out.message, `${e.error}.${f}`).toContain(v)
      }
      if (e.error === 'ValidationFailed') {
        for (const [k, v] of Object.entries(e.detail)) if (k !== 'rule' && typeof v === 'string') expect(out.message).toContain(v)
      }
      if (e.error === 'RetimeRejected') {
        for (const v of Object.values(e.reason)) if (typeof v === 'string' && v !== e.reason.kind) expect(out.message).toContain(v)
        expect(out.message).not.toContain('"kind"')
      }
      // Every arm names its variant (a rule's own name for the enriched
      // ValidationFailed rules), whether or not it wrote other data.
      const variant = (out.data as { error?: unknown } | undefined)?.error
      expect(typeof variant, e.error).toBe('string')
      if (e.error !== 'ValidationFailed') expect(variant).toBe(e.error)
    })
  }

  it('an unknown variant (a union widened without a mapper arm) still names itself and its fields rather than throwing', () => {
    const out = mapCommandError({ error: 'FromTheFuture', widget: 'w-1' } as unknown as CommandError)
    expect(out.message).toContain('FromTheFuture')
    expect(out.message).toContain('widget w-1')
  })
})

describe('the ripple remedies are per tool', () => {
  const inside: CommandError = { error: 'RippleInsideHole', layer: L1, hole: { s: 0, e: 5_000_000 } }

  it('delete_layers is told to widen or narrow layer_ids', () => {
    const out = mapCommandError(inside, 'delete_layers')
    expect(out.message).toContain('add ' + L1 + ' to layer_ids')
    expect(out.message).toContain('without ripple')
  })

  it('shift_layers and remove_pauses have no layer_ids and are told to move or delete the blocker first', () => {
    for (const tool of ['shift_layers', 'remove_pauses']) {
      const out = mapCommandError(inside, tool)
      expect(out.message, tool).not.toContain('layer_ids')
      expect(out.message, tool).toContain(`move_layers or delete_layers ${L1} first`)
      expect((out.data as { tool: string }).tool).toBe(tool)
    }
    expect(mapCommandError(inside, 'remove_pauses').message).toContain('the pause cut')
    expect(mapCommandError(inside, 'shift_layers').message).toContain('the shift')
  })

  it('move_layers { insert } is told to add the blocker to its set, or move without insert', () => {
    const out = mapCommandError(inside, 'move_layers')
    expect(out.message).toContain(`add ${L1} to layer_ids`)
    expect(out.message).toContain('without insert')
    expect((out.data as { options: Array<{ action: string }> }).options.map((o) => o.action)).toEqual(['add_to_set_then_retry', 'move_without_insert'])
  })

  it('the other three ripple refusals drop the layer_ids clause for the tools that lack it', () => {
    const collision: CommandError = { error: 'RippleCollision', moving: L1, blocking: L2, track: T1 }
    expect(mapCommandError(collision, 'delete_layers').message).toContain('narrow layer_ids')
    expect(mapCommandError(collision, 'remove_pauses').message).not.toContain('layer_ids')
    const straddle: CommandError = { error: 'RippleLinkStraddles', link: X1, hole: { s: 0, e: 5 } }
    expect(mapCommandError(straddle, 'delete_layers').message).toContain('add the straddling members to layer_ids')
    expect(mapCommandError(straddle, 'shift_layers').message).not.toContain('layer_ids')
    expect(mapCommandError(straddle, 'move_layers').message).toContain('add the straddling members to layer_ids')
    const locked: CommandError = { error: 'RippleLockedLayer', layer: L1 }
    expect(mapCommandError(locked, 'delete_layers').message).toContain('narrow layer_ids')
    // The unlock names set_layer_flags' own layer_ids; the narrowing clause is gone.
    expect(mapCommandError(locked, 'remove_pauses').message).not.toContain('narrow layer_ids')
  })
})

describe('LayerOverlap options are validated against the geometry', () => {
  const overlap = (a: [number, number], b: [number, number]): CommandError =>
    ({ error: 'ValidationFailed', detail: { rule: 'LayerOverlap', track: T1, a: L1, a_start: a[0], a_end: a[1], b: L2, b_start: b[0], b_end: b[1] } })
  const actions = (e: CommandError) => ((mapCommandError(e).data as { options: Array<{ action: string; edge?: string; t_edge_us?: number; t_cut_us?: number[] }> }).options)

  it('a request starting inside the blocker: trim its tail or split it there, plus the two that always work', () => {
    const opts = actions(overlap([0, 3_000_000], [2_000_000, 5_000_000]))
    expect(opts.map((o) => o.action)).toEqual(['create_new_track', 'move_layers', 'trim_existing', 'split_at_t'])
    expect(opts[2]).toMatchObject({ edge: 'out', t_edge_us: 2_000_000 })
    expect(opts[3]).toMatchObject({ t_cut_us: [2_000_000] })
  })

  it('a request starting at or before the blocker: never a split at the start, never a trim to the start', () => {
    // `split_at_t 0` would be SplitOutsideLayer and `trim_existing to 0` a
    // one-frame clip. The request covers the blocker's head, so the blocker's
    // START is what moves.
    const opts = actions(overlap([0, 3_000_000], [0, 1_000_000]))
    expect(opts.map((o) => o.action)).toEqual(['create_new_track', 'move_layers', 'trim_existing'])
    expect(opts[2]).toMatchObject({ edge: 'in', t_edge_us: 1_000_000 })
    const msg = mapCommandError(overlap([0, 3_000_000], [0, 1_000_000])).message
    expect(msg).not.toContain('split_layer')
    expect(msg).toContain("trim_layer " + L1 + " edge 'in' to 1000000")
  })

  it('a request that swallows the blocker whole offers only the two that always work', () => {
    const opts = actions(overlap([1_000_000, 2_000_000], [0, 3_000_000]))
    expect(opts.map((o) => o.action)).toEqual(['create_new_track', 'move_layers'])
  })
})

describe('the messages the descriptions promise', () => {
  it('HistoryLocked carries the reason and says wait or ask the user — never unlock another session', () => {
    const out = mapCommandError({ error: 'HistoryLocked', reason: 'rough cut in progress' })
    expect(out.code).toBe('invalid_request')
    expect(out.message).toContain('rough cut in progress')
    expect(out.message).toContain('ask the user')
    expect(out.message).not.toContain('set_history_lock')
    expect(out.data).toMatchObject({ error: 'HistoryLocked', reason: 'rough cut in progress', options: [{ action: 'wait_for_session_end' }, { action: 'ask_user' }] })
  })

  it('RetimeRejected says one sentence per reason, and a collision points at the blocker', () => {
    const out = mapCommandError({ error: 'RetimeRejected', reason: { kind: 'Collision', layer_id: L1, blocking_layer_id: L2, requested_duration: { num: 9, den: 1 }, maximum_duration_us: 4_000_000, minimum_rate: { num: 3, den: 2 } } })
    expect(out.message).toContain(`move_layers ${L2} out of the way`)
    expect(out.message).toContain('at most 4000000 µs fits')
    expect(out.message).toContain('3/2')
  })

  it('FpsLockedByContent carries current, requested, layer_count and locked_by, and says which scope blocked', () => {
    const current = mapCommandError({ error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 3, locked_by: 'current' })
    expect(current.message).toContain('30/1')
    expect(current.message).toContain('25/1')
    expect(current.message).toContain('3 layer(s)')
    expect(current.data).toEqual({ error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 3, locked_by: 'current' })
    const history = mapCommandError({ error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 0, locked_by: 'history' })
    expect(history.message).toContain('history snapshot or checkpoint')
    expect(history.message).not.toContain('0 layer(s)')
  })

  it('TrackLocked and MediaInUse name the fix, not the fact', () => {
    expect(mapCommandError({ error: 'TrackLocked', track: T1 }).message).toContain(`set_track_flags { track_id: "${T1}", locked: false }`)
    const inUse = mapCommandError({ error: 'MediaInUse', media: X1, referenced_by: [L1, L2] })
    expect(inUse.message).toContain('2 layer(s)')
    expect(inUse.message).toContain('force: true')
  })
})

// ── The catalog-wide sweep ───────────────────────────────────────────────────

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const CATALOG = mergeMcpCatalog(JSON.parse(RUST_CATALOG).tools, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS, ...EXPORT_TOOL_DEFS])
const NOWHERE = '00000000-0000-7000-8000-00000000dead'
/** The words no result text may carry. */
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ['an IPC wrapper', /Error invoking remote method/],
  ['an errno prefix', /\bE[A-Z]{3,}\b:/],
  ['an event no MCP client receives', /media:job_complete/],
]
const CODES = new Set(['invalid_params', 'invalid_request', 'internal', 'cancelled'])
const IPC_ENOENT = "Error invoking remote method 'backend:invoke': Error: ENOENT: no such file or directory, open '/nowhere/missing.bin'"
const ADMISSION = `Error invoking remote method 'resources:plan-export': Error: resource-capacity-exceeded: {"availableMiB":372,"kind":"blocked","reason":"busy","requestedMiB":414,"revision":3,"workMiB":512}`

/** A host whose every seam below MCP fails in its real raw words. */
function rawHost() {
  const idGen = uuidV7Gen()
  const initial = blankProject(idGen, 'sweep')
  rootComposition(initial).duration_us = 1_000_000
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const raw = () => { throw new Error(IPC_ENOENT) }
  const compute = new Proxy({}, { get: () => async () => raw() })
  const hybridDeps = {
    actor, compute, enqueueDerivatives: async () => {}, enqueueWorkspaceCopy: async () => {},
    workspaceDir: () => null, readFile: () => raw(), statPath: () => ({ kind: 'file' as const, readable: true }),
    snapshotComposition: () => root(actor.snapshot()),
  }
  const dir = mkdtempSync(join(tmpdir(), 'weftcut-vocab-'))
  const host: Record<string, unknown> = {
    actor, hybridDeps, mediaImporter: createMediaImporter(hybridDeps as never),
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    motifTool: raw,
    handleInvoke: async (channel: string) => { if (channel === 'export_settings_get') return null; return raw() },
    openedProject: () => ({ dir }),
    projects: { shuttingDown: () => false, open: async () => raw(), create: async () => raw() },
    projectStatus: () => ({ project: null, recent_projects: [], default_parent_folder: dir }),
    agent: new AgentActivityService(actor, () => {}),
    start: () => {}, stop: () => {},
  }
  // Only the output preparation fails, so a start_export is admitted and its
  // job fails with the raw text; cleanup succeeds.
  host.exportJobs = new ExportJobs({ host: () => host as never, send: () => {}, native: async (channel) => channel === 'export_prepare_output' ? raw() : null })
  return host
}
function rawBackend() {
  const envelope = JSON.stringify({ ok: false, error: { code: 'internal', message: IPC_ENOENT } })
  return {
    mcpCallTool: async () => envelope,
    mcpReadResource: async () => envelope,
    mcpCatalog: async () => RUST_CATALOG,
    mcpListPrompts: async () => '[]',
    mcpGetPrompt: async () => envelope,
  } as never
}

/** The smallest arguments the advertised schema accepts: every required field,
 *  each a value of its type (ids name nothing), so each call gets past the
 *  argument gate and into its route. */
function dummy(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return NOWHERE
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  const alt = (schema.oneOf ?? schema.anyOf) as Array<Record<string, unknown>> | undefined
  if (alt) return dummy(alt[0])
  const t = Array.isArray(schema.type) ? (schema.type as string[]).find((x) => x !== 'null') : schema.type
  switch (t) {
    case 'integer': case 'number': return Math.max(1, (schema.minimum as number | undefined) ?? 1)
    case 'boolean': return false
    case 'array': return Array.from({ length: Math.max(1, (schema.minItems as number | undefined) ?? 1) }, () => dummy(schema.items as Record<string, unknown> | undefined))
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      return Object.fromEntries(((schema.required ?? []) as string[]).map((k) => [k, dummy(props[k])]))
    }
    default: return NOWHERE
  }
}

type Block = { type: string; text?: string }
type Answer = { isError?: boolean; content?: Block[]; structuredContent?: Record<string, unknown> }

function assertInModel(tool: string, args: Record<string, unknown>, r: Answer) {
  const label = `${tool} ${JSON.stringify(args)}`
  for (const b of r.content ?? []) {
    if (b.type !== 'text') continue
    for (const [what, re] of FORBIDDEN) expect(b.text, `${label}: ${what}`).not.toMatch(re)
  }
  if (!r.isError) return
  const sc = r.structuredContent ?? {}
  expect(CODES.has(sc.code as string), `${label}: code ${String(sc.code)}`).toBe(true)
  expect(typeof sc.error, `${label}: error variant`).toBe('string')
  expect(sc.error as string, label).toMatch(/^[A-Z][A-Za-z]+$/)
  expect(sc.message, label).toBe(r.content?.map((c) => c.text).join('\n'))
}

describe('mcp.error-vocabulary over the whole catalog', () => {
  it('the catalog is the merged one: TS, Motif, export, render and Rust tools are all swept', () => {
    const names = new Set(CATALOG.map((t) => t.name))
    for (const n of ['undo', 'install_motif', 'export_motif', 'start_export', 'render_frames', 'list_export_presets', 'detect_pauses', 'analyze_audio']) expect(names.has(n), n).toBe(true)
  })

  for (const tool of CATALOG) {
    it(tool.name, async () => {
      const schema = tool.inputSchema as Record<string, unknown>
      for (const args of [{}, dummy(schema) as Record<string, unknown>]) {
        const host = rawHost()
        const r = await handleCallTool(rawBackend(), () => host as never, tool.name, args, undefined, undefined, undefined, undefined, undefined, failingCapture) as Answer
        assertInModel(tool.name, args, r)
      }
    })
  }

  it('no tool, resource or prompt text in the Rust MCP sources names media:job_complete', () => {
    const dir = 'native/src/mcp'
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.rs'))) expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('media:job_complete')
    expect(RUST_CATALOG).not.toContain('media:job_complete')
  })
})

describe('the export, render and Motif file routes refuse in the model', () => {
  it('export_motif to a missing parent folder is PathNotFound, not bare ENOENT', async () => {
    const host = rawHost()
    const target = join(mkdtempSync(join(tmpdir(), 'weftcut-vocab-')), 'no-such-folder', 'card.zip')
    host.motifTool = () => { writeFileSync(target, 'zip'); return null }
    const r = await handleCallTool(rawBackend(), () => host as never, 'export_motif', { motif_id: 'card', path: target }) as Answer
    expect(r.isError).toBe(true)
    assertInModel('export_motif', {}, r)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_params', error: 'PathNotFound', path: target })
    expect(r.content![0]!.text).toContain('folder that already exists')
  })

  it('render_frames during an export is ExportBusy (invalid_request), flat', async () => {
    const host = rawHost()
    host.exportJobs = { renderStills: async () => { throw new ExportJobError('export_active', 'An export is running; render frames after it finishes') } }
    const r = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0] }) as Answer
    expect(r.isError).toBe(true)
    assertInModel('render_frames', {}, r)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_request', error: 'ExportBusy' })
    expect(r.content![0]!.text).toContain('get_export_status')
  })

  it('render_frames refused by a busy admission budget is ResourceBusy with the MiB, not IPC text', async () => {
    const host = rawHost()
    host.exportJobs = { renderStills: async () => { throw new ExportJobError('render_failed', ADMISSION) } }
    const r = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0] }) as Answer
    expect(r.isError).toBe(true)
    assertInModel('render_frames', {}, r)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_request', error: 'ResourceBusy', reason: 'busy', requested_mib: 414, available_mib: 372, budget_mib: 512 })
    expect(r.content![0]!.text).toContain('414 MiB')
  })

  it('render_frames on a renderer that cannot draw the frames is RendererCannotDraw with its ids', async () => {
    const host = rawHost()
    const fault = { error: 'RendererCannotDraw', renderer: 'canvas', missing: ['effects'], layer_ids: [L1], needs: 'WebGPU or WebGL2', t_us: [2_000_000] }
    host.exportJobs = { renderStills: async () => { throw new ExportJobError('renderer_cannot_draw', `render_frames refused: this host renders with the canvas fallback (no WebGPU or WebGL2), which cannot draw effects, and layer(s) ${L1} carry them at t_us 2000000.`, fault) } }
    const r = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0, 2_000_000] }) as Answer
    expect(r.isError).toBe(true)
    assertInModel('render_frames', {}, r)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_request', ...fault })
    expect(r.content![0]!.text).toContain(L1)
  })

  it('a RendererCannotDraw that lacks only effects passes on its without option and names it in the text', async () => {
    const host = rawHost()
    const fault = { error: 'RendererCannotDraw', renderer: 'canvas', missing: ['effects'], layer_ids: [L1], needs: 'WebGPU or WebGL2', t_us: [2_000_000],
      options: [{ action: 'render_without_effects', tool: 'render_frames', without: ['effects'] }] }
    const message = `render_frames refused: … layer(s) ${L1} carry them at t_us 2000000. To look anyway, pass without: ["effects"]: the frames render with effects skipped, and the answer lists them as omitted.`
    host.exportJobs = { renderStills: async () => { throw new ExportJobError('renderer_cannot_draw', message, fault) } }
    const r = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [2_000_000] }) as Answer
    expect(r.isError).toBe(true)
    assertInModel('render_frames', {}, r)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_request', ...fault })
    expect(r.content![0]!.text).toContain('without: ["effects"]')
  })

  it('render_frames { without: ["effects"] } asks the renderer to skip them and answers omitted, [] when no frame held one', async () => {
    const host = rawHost()
    const seen: unknown[] = []
    let frames: Array<{ t_us: number; width: number; height: number; jpeg: Uint8Array; omitted?: string[] }> = []
    host.exportJobs = { renderStills: async (req: unknown) => { seen.push(req); return { frames } } }
    frames = [{ t_us: 0, width: 4, height: 2, jpeg: new Uint8Array(4) }, { t_us: 500_000, width: 4, height: 2, jpeg: new Uint8Array(4), omitted: ['effects'] }]
    const record = (r: Answer) => JSON.parse(r.content!.at(-1)!.text!) as Record<string, unknown>
    const skipped = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0, 500_000], sheet: false, without: ['effects'] }) as Answer
    expect(skipped.isError).toBeFalsy()
    expect(seen[0]).toMatchObject({ without: ['effects'] })
    expect(record(skipped)).toMatchObject({ omitted: ['effects'] })
    frames = [{ t_us: 0, width: 4, height: 2, jpeg: new Uint8Array(4) }]
    expect(record(await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0], sheet: false, without: ['effects'] }) as Answer)).toMatchObject({ omitted: [] })
    // Not asked, not answered: a plain render carries no omitted and sends no switch.
    const plain = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0], sheet: false }) as Answer
    expect(record(plain)).not.toHaveProperty('omitted')
    expect(seen[2]).not.toHaveProperty('without')
  })

  it('render_frames refuses a without other than ["effects"] as InvalidArgument', async () => {
    const host = rawHost()
    host.exportJobs = { renderStills: async () => { throw new Error('must not render') } }
    for (const without of [['crop'], ['effects', 'transitions'], [], 'effects']) {
      const r = await handleCallTool(rawBackend(), () => host as never, 'render_frames', { t_us: [0], without }) as Answer
      expect(r.isError).toBe(true)
      assertInModel('render_frames', {}, r)
      expect(r.structuredContent).toMatchObject({ code: 'invalid_params', error: 'InvalidArgument' })
      expect(r.content![0]!.text).toContain('["effects"]')
    }
  })

  it('start_export takes no without: it is refused as an unknown argument that render_frames takes', async () => {
    const r = await handleCallTool(rawBackend(), () => rawHost() as never, 'start_export', { without: ['effects'] }) as Answer
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_params', error: 'UnknownArgument', field: 'without' })
    expect(r.content![0]!.text).toContain('render_frames takes without')
  })

  it('a failed export job reports its cause without the IPC wrapper', async () => {
    const host = rawHost()
    const r = await handleCallTool(rawBackend(), () => host as never, 'start_export', {}) as Answer
    expect(r.isError).toBeFalsy()
    assertInModel('start_export', {}, r)
    expect(r.structuredContent).toMatchObject({ state: 'failed' })
    expect((r.structuredContent!.error as { message: string }).message).toContain('/nowhere/missing.bin')
  })

  it('an unknown export argument names the key and the tool that takes it', async () => {
    const r = await handleCallTool(rawBackend(), () => rawHost() as never, 'update_export_preset', { preset_id: 'p', settings: {}, request_id: 'x' }) as Answer
    expect(r.structuredContent).toMatchObject({ code: 'invalid_params', error: 'UnknownArgument', field: 'request_id' })
    expect(r.content![0]!.text).toContain('start_export takes request_id')
  })
})

describe('a Motif store refusal keeps its variant and data', () => {
  it('install_motif on a taken id is MotifIdTaken with the options; a stale revision names current_revision', async () => {
    const host = rawHost()
    host.motifTool = () => { throw new MotifRefusal("Motif id 'badge' is taken", { error: 'MotifIdTaken', id: 'badge', holder: 'installed', options: ['rename', 'replace'] }) }
    const taken = await handleCallTool(rawBackend(), () => host as never, 'install_motif', { motif_id: 'badge-draft', expected_revision: 'r' }) as Answer
    assertInModel('install_motif', {}, taken)
    expect(taken.structuredContent).toMatchObject({ code: 'invalid_params', error: 'MotifIdTaken', id: 'badge', options: ['rename', 'replace'] })
    host.motifTool = () => { throw revisionConflict('abc', 'read it again') }
    const stale = await handleCallTool(rawBackend(), () => host as never, 'update_motif_files', { motif_id: 'd', expected_revision: 'old', files: [{ path: 'a', text: 'b' }] }) as Answer
    expect(stale.structuredContent).toMatchObject({ error: 'RevisionConflict', current_revision: 'abc' })
    expect(stale.content![0]!.text).toContain('abc')
  })
})
