// apps/desktop/src/main/state/__tests__/mcp.no-silent-outcomes.test.ts
// Constraint 1 of docs/mcp.md ("No silent no-op, no silent degrade"), as a
// gate. A write that ignores, drops or does not apply an argument must refuse,
// so every optional and every nullable field of every WRITE tool in the merged
// catalog (TS, Motif, export and the Rust snapshot) is sent ALONE, on a fixture
// project, through the same `handleCallTool` a client reaches:
//
// - a value probe is the tool's base call plus that one field. It must refuse,
//   or leave the app in a state other than the base call alone leaves it in —
//   so a creating tool that drops `label` fails here, not just an update that
//   writes nothing;
// - a null probe sends that field as `null` and must refuse or change the
//   state of the fixture (null means something of its own, or it is refused).
//
// A tool or a field that cannot be probed on a fixture project is an explicit
// EXCEPTION with its reason. A new write tool, or a new optional field, with
// neither a case nor an exception fails the coverage tests below.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { handleCallTool } from '../../mcp/server'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { EXPORT_TOOL_DEFS } from '../../mcp/exportTools'
import { ExportJobs } from '../../exportJobs'
import { AgentActivityService } from '../../agent/activity'
import { createActor, type ActorHandle } from '../actor'
import { createMediaImporter } from '../mediaImport'
import { seededGen } from '../ids'
import { blankProject, type MediaItem } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { canonicalString } from '../canonical'
import { serializeProject } from '../serialize'
import { root } from './fixtures/project'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const CATALOG = mergeMcpCatalog(JSON.parse(RUST_CATALOG).tools, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS, ...EXPORT_TOOL_DEFS])
const WRITES = CATALOG.filter((t) => t.annotations?.readOnlyHint !== true)

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[] }
type Answer = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }

// ── The probes a schema advertises ───────────────────────────────────────────

/** `field` is a top-level property, or `patch.<key>` for a key of a `patch`
 *  object. `nullArm`: the schema's type admits null, so null is probed too. */
interface Probe { field: string; nullArm: boolean; required: boolean }
const nullable = (s: Schema | undefined) => Array.isArray(s?.type) && s!.type.includes('null')
function probesOf(schema: Schema): Probe[] {
  const out: Probe[] = []
  const required = new Set(schema.required ?? [])
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (!required.has(k) || nullable(s)) out.push({ field: k, nullArm: nullable(s), required: required.has(k) })
    if (k === 'patch' && s.properties) {
      const inner = new Set(s.required ?? [])
      for (const [pk, ps] of Object.entries(s.properties)) if (!inner.has(pk)) out.push({ field: `patch.${pk}`, nullArm: nullable(ps), required: false })
    }
  }
  return out
}

// ── The fixture world ────────────────────────────────────────────────────────

const VIDEO = '00000000-0000-7000-8000-0000000000a1'
const IMAGE = '00000000-0000-7000-8000-0000000000a2'
const AUDIO = '00000000-0000-7000-8000-0000000000a3'
const S = 1_000_000

function media(id: string, kind: MediaItem['kind'], durationUs: number | null, withAudio = false): MediaItem {
  const m = mediaItemTemplate(id, kind, durationUs, withAudio)
  if (kind !== 'Audio') m.metadata.video = { width: 1920, height: 1080, fps_num: 30, fps_den: 1 }
  return { ...m, path_abs: `/fixture/${kind.toLowerCase()}.bin` }
}

/** The ids a case reaches for. Every world is built by the same calls from the
 *  same seeded generator, so a base world and a probe world agree on them. */
interface Ids {
  tA: string; tB: string; tV: string; tT: string
  c: string; c2: string; x: string; cap: string; tail: string; vl: string; al: string; t1: string; t2: string
  link: string; link2: string; group: string; groupComp: string; groupTrack: string; groupTrack2: string; groupInner: string
  marker: string; region: string; k0: string; k1: string; effect: string; transition: string; tack: string
}
interface World { actor: ActorHandle; agent: AgentActivityService; host: Record<string, unknown>; ids: Ids }

const backend = {
  mcpCallTool: async () => JSON.stringify({ ok: false, error: { code: 'internal', message: 'no native compute in this fixture' } }),
  mcpReadResource: async () => JSON.stringify({ ok: false, error: { code: 'internal', message: 'no native compute in this fixture' } }),
  mcpCatalog: async () => RUST_CATALOG,
  mcpListPrompts: async () => '[]',
} as never

async function call(w: Pick<World, 'agent' | 'host'>, name: string, args: Record<string, unknown>): Promise<Answer> {
  return w.agent.run('sweep', 'sweep-client', name, args, false, () => handleCallTool(backend, () => w.host as never, name, args)) as Promise<Answer>
}
async function must(w: Pick<World, 'agent' | 'host'>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(w, name, args)
  if (r.isError) throw new Error(`fixture: ${name} ${JSON.stringify(args)} refused: ${r.content?.[0]?.text}`)
  return r.structuredContent ?? {}
}
const id = (r: Record<string, unknown>, key: string): string => {
  const v = r[key]
  if (typeof v !== 'string') throw new Error(`fixture: no ${key} in ${JSON.stringify(r)}`)
  return v
}
/** The one layer an `add_layers` call of one placed. */
const added = (r: Record<string, unknown>): string => id((r.layers as Array<Record<string, unknown>>)[0]!, 'layer_id')

async function world(): Promise<World> {
  const idGen = seededGen()
  const p = blankProject(idGen, 'sweep')
  for (const m of [media(VIDEO, 'Video', 10 * S, true), media(IMAGE, 'Image', null), media(AUDIO, 'Audio', 10 * S, true)]) p.media_pool[m.id] = m
  const actor = createActor({ initial: p, idGen, clock: () => '<TS>' })
  const agent = new AgentActivityService(actor, () => {})
  agent.start()
  const dir = mkdtempSync(join(tmpdir(), 'weftcut-sweep-'))
  const fail = () => { throw new Error('no native compute in this fixture') }
  const hybridDeps = {
    actor, compute: new Proxy({}, { get: () => async () => fail() }), enqueueDerivatives: async () => {}, enqueueWorkspaceCopy: async () => null,
    workspaceDir: () => null, readFile: () => fail(), statPath: () => ({ kind: 'file' as const, readable: true }),
    snapshotComposition: () => root(actor.snapshot()),
  }
  const host: Record<string, unknown> = {
    actor, agent, hybridDeps, mediaImporter: createMediaImporter(hybridDeps as never),
    mcpCall: (name: string, argsJson: string, client?: string) => actor.mcpCall(name, argsJson, client),
    motifTool: () => { throw new Error('no Motif store in this fixture') },
    handleInvoke: async (channel: string) => (channel === 'export_settings_get' ? null : fail()),
    openedProject: () => ({ dir }),
    projects: { shuttingDown: () => false, open: async () => fail(), create: async () => fail() },
    projectStatus: () => ({ project: null, recent_projects: [], default_parent_folder: dir }),
    start: () => {}, stop: () => {},
  }
  host.exportJobs = new ExportJobs({ host: () => host as never, send: () => {}, native: async () => null })
  const w = { actor, agent, host }
  const r = root(actor.snapshot())
  const [tA, tB] = [r.tracks[0]!.id, r.tracks[1]!.id]
  const red = { r: 200, g: 0, b: 0, a: 255 }
  // The settings the probes flip, and a pinned root duration to unpin.
  await must(w, 'set_project_settings', { patch: { auto_pair_audio_on_import: false, shot_review: { sensitivity: 0.5, min_shot_us: S }, pause_review: { threshold_db: -26, min_pause_us: S, pad_us: 100_000 } } })
  await must(w, 'rename_track', { track_id: tA, label: 'A cam' })
  const c = added(await must(w, 'add_layers', { layers: [{ track_id: tA, t_start_us: 0, t_end_us: 2 * S, content: { kind: 'color', color: red } }] }))
  const c2 = added(await must(w, 'add_layers', { layers: [{ track_id: tA, t_start_us: 2 * S, t_end_us: 4 * S, content: { kind: 'color', color: red } }] }))
  await must(w, 'rename_layer', { layer_id: c, label: 'C' })
  const x = added(await must(w, 'add_layers', { layers: [{ track_id: tB, t_start_us: 0, t_end_us: 2 * S, content: { kind: 'text', content: 'Title' } }] }))
  const tV = id(await must(w, 'add_track', {}), 'track_id')
  const vl = added(await must(w, 'add_layers', { layers: [{ track_id: tV, t_start_us: 0, t_end_us: 4 * S, content: { kind: 'video', media_id: VIDEO, src_in_us: 0 } }] }))
  const tAu = id(await must(w, 'add_track', {}), 'track_id')
  const al = added(await must(w, 'add_layers', { layers: [{ track_id: tAu, t_start_us: 0, t_end_us: 4 * S, content: { kind: 'audio', media_id: AUDIO, src_in_us: 0, role: 'dialogue' } }] }))
  const link = id(await must(w, 'create_link', { layer_ids: [vl, al] }), 'link_id')
  const link2 = id(await must(w, 'create_link', { layer_ids: [c2, x] }), 'link_id')
  const tT = id(await must(w, 'add_track', {}), 'track_id')
  const t1 = added(await must(w, 'add_layers', { layers: [{ track_id: tT, t_start_us: 0, t_end_us: 2 * S, content: { kind: 'color', color: red } }] }))
  const t2 = added(await must(w, 'add_layers', { layers: [{ track_id: tT, t_start_us: 2 * S, t_end_us: 4 * S, content: { kind: 'color', color: red } }] }))
  const transition = id(await must(w, 'add_transition', { from_layer_id: t1, to_layer_id: t2, duration_us: 500_000 }), 'transition_id')
  const tail = added(await must(w, 'add_layers', { layers: [{ track_id: tT, t_start_us: 6 * S, t_end_us: 7 * S, content: { kind: 'color', color: red } }] }))
  await must(w, 'add_layers', { layers: [{ track_id: tT, t_start_us: 8 * S, t_end_us: 9 * S, content: { kind: 'color', color: red } }] })
  const tG = id(await must(w, 'add_track', {}), 'track_id')
  const inner = added(await must(w, 'add_layers', { layers: [{ track_id: tG, t_start_us: 0, t_end_us: 2 * S, content: { kind: 'color', color: red } }] }))
  const grouped = await must(w, 'create_group', { layer_ids: [inner], label: 'Grp' })
  const group = id(grouped, 'layer_id'), groupComp = id(grouped, 'composition_id')
  const groupTrack = actor.snapshot().compositions[groupComp]!.tracks[0]!.id
  const groupTrack2 = id(await must(w, 'add_track', { composition_id: groupComp }), 'track_id')
  const cap = added(await must(w, 'add_layers', { layers: [{ track_id: tB, t_start_us: 2 * S, t_end_us: 3 * S, content: { kind: 'text', content: 'a caption', graphic_role: 'caption' } }] }))
  const marker = id(await must(w, 'add_marker', { t_us: S, label: 'm', color: red, anchor_layer_id: al }), 'marker_id')
  const region = id(await must(w, 'add_marker', { t_us: S, t_end_us: 2 * S, label: 'r', color: red }), 'marker_id')
  const k0 = id(await must(w, 'set_keyframe', { layer_id: x, param_key: 'opacity', t_us: 0, value: 1 }), 'keyframe_id')
  const k1 = id(await must(w, 'set_keyframe', { layer_id: x, param_key: 'opacity', t_us: S, value: 0.5 }), 'keyframe_id')
  const effect = id(await must(w, 'add_effect', { layer_id: vl, kind: 'blur' }), 'effect_id')
  await must(w, 'update_composition', { patch: { duration_us: 30 * S } })
  const tack = id({ tack: ((await must(w, 'create_tacks', { tacks: [{ label: 'look', t_us: 0 }] })).tacks as Array<{ tack_id: string }>)[0]!.tack_id }, 'tack')
  return { actor, agent, host, ids: { tA, tB, tV, tT, c, c2, x, cap, tail, vl, al, t1, t2, link, link2, group, groupComp, groupTrack, groupTrack2, groupInner: inner, marker, region, k0, k1, effect, transition, tack } }
}

/** Everything a write can change, without what every call changes (the
 *  activity log) or what no two worlds share (generated tack and session ids,
 *  wall-clock times). */
function fingerprint(w: World): string {
  const a = w.agent.snapshot()
  return canonicalString({
    project: serializeProject(w.actor.snapshot()),
    history: w.actor.historyView(1000), status: w.actor.historyStatus(),
    checkpoints: w.actor.listCheckpoints().map(({ label }) => label),
    session: a.session && { reason: a.session.reason, client: a.session.client },
    lock: w.agent.lockHolder()?.reason ?? null,
    tacks: a.tacks.map(({ label, body, kind, status, t_us, end_t_us }) => ({ label, body, kind, status, t_us, end_t_us })),
  })
}

// ── The cases ────────────────────────────────────────────────────────────────

/** A field's probe value. `with` joins the base call for this probe only (and
 *  the base it is compared with), for a field that acts only beside another;
 *  `refuses` declares that the probe must refuse (a cross-check that does not
 *  match, a flag that is meaningless alone). */
type Value = { v: (i: Ids) => unknown; with?: (i: Ids) => Record<string, unknown>; refuses?: true }
const val = (v: (i: Ids) => unknown, extra: Omit<Value, 'v'> = {}): Value => ({ v, ...extra })
const lit = (v: unknown, extra: Omit<Value, 'v'> = {}): Value => ({ v: () => v, ...extra })
interface Case {
  base: (i: Ids) => Record<string, unknown>
  /** One entry per value probe; a null probe needs none unless it refuses. */
  values: Record<string, Value>
  /** Null probes that must refuse rather than change the fixture. */
  nullRefuses?: readonly string[]
}
const RGBA = { r: 1, g: 2, b: 3, a: 255 }

const CASES: Record<string, Case> = {
  add_track: { base: () => ({}), values: { label: lit('L'), composition_id: val((i) => i.groupComp) } },
  delete_track: { base: (i) => ({ track_id: i.tT }), values: { force: lit(true) } },
  rename_track: { base: (i) => ({ track_id: i.tA }), values: { label: lit('Renamed') } },
  set_track_flags: { base: (i) => ({ track_id: i.tB }), values: { enabled: lit(false), locked: lit(true) } },
  paste_layers: { base: (i) => ({ layer_ids: [i.c] }), values: {
    t_start_us: lit(10 * S), delta_us: lit(10 * S),
    track_id: val((i) => i.tB, { with: () => ({ delta_us: 10 * S }) }),
    // On a colour layer the copy has no composition to make its own: refused.
    unique: lit(true, { with: () => ({ delta_us: 10 * S }), refuses: true }),
  } },
  rename_layer: { base: (i) => ({ layer_id: i.c, label: 'C' }), values: { label: lit('New') } },
  set_layer_flags: { base: (i) => ({ layer_ids: [i.c] }), values: { enabled: lit(false), locked: lit(true) } },
  shift_layers: { base: () => ({ t_from_us: 0, delta_us: S }), values: {
    track_ids: val((i) => [i.tT]),
    composition_id: val((i) => i.groupComp),
  } },
  restack_layer: { base: (i) => ({ layer_id: i.c, position: 'above' }), values: {
    anchor_layer_id: val((i) => i.vl), anchor_track_id: val((i) => i.tV),
  } },
  move_layers: { base: (i) => ({ layer_ids: [i.vl] }), values: {
    t_start_us: lit(6 * S), delta_us: lit(6 * S),
    track_id: val((i) => i.tA, { with: () => ({ delta_us: 6 * S }) }),
    // `tail` by 2 s lands on the layer after it; the insert closes and opens room.
    insert: lit(true, { with: (i) => ({ layer_ids: [i.tail], delta_us: 2 * S }) }),
    escape_link: lit(true, { with: () => ({ delta_us: 6 * S }) }),
  } },
  retime_layers: { base: (i) => ({ layer_ids: [i.al] }), values: {
    target: lit({ kind: 'Rate', value: { num: 2, den: 1 } }), preserve_pitch: lit(false),
  } },
  trim_layer: { base: (i) => ({ layer_id: i.vl, edge: 'out', t_edge_us: 3 * S }), values: { escape_link: lit(true) } },
  delete_layers: { base: (i) => ({ layer_ids: [i.tail] }), values: { ripple: lit(true) } },
  create_link: { base: (i) => ({ layer_ids: [i.vl, i.c] }), values: { reassign: lit(true) } },
  update_link: { base: (i) => ({ link_id: i.link }), values: {
    add_layer_ids: val((i) => [i.c]), remove_layer_ids: val((i) => [i.al]),
    reassign: lit(true, { with: (i) => ({ add_layer_ids: [i.c2] }) }),
  } },
  create_group: { base: (i) => ({ layer_ids: [i.c] }), values: { label: lit('G2') } },
  move_layers_to_composition: { base: (i) => ({ layer_ids: [i.c], anchor_layer_id: i.c, t_start_us: 3 * S, to_composition_id: i.groupComp }), values: {
    // The second lane of the Group: the call alone lands on the first.
    to_track_id: val((i) => i.groupTrack2),
  } },
  rename_composition: { base: (i) => ({ composition_id: i.groupComp }), values: { label: lit('Renamed') } },
  add_effect: { base: (i) => ({ layer_id: i.vl, kind: 'blur' }), values: { params: lit({ strength: 20 }) } },
  update_effect: { base: (i) => ({ layer_id: i.vl, effect_id: i.effect, patch: {} }), values: {
    'patch.enabled': lit(false), 'patch.params': lit({ strength: 7 }),
  } },
  add_transition: { base: (i) => ({ from_layer_id: i.c, to_layer_id: i.c2, duration_us: 500_000 }), values: {
    kind: lit('Wipe', { with: () => ({ direction: 'left', placement: 'extend' }) }),
    // Crossfade (the default kind) has no direction: refused, not dropped.
    direction: lit('left', { refuses: true }),
    placement: lit('extend'),
  } },
  update_transition: { base: (i) => ({ transition_id: i.transition }), values: {
    duration_us: lit(800_000), extended_us: lit(250_000), kind: lit('Wipe', { with: () => ({ direction: 'up' }) }),
    direction: lit('up', { refuses: true }),
  } },
  update_composition: { base: () => ({ patch: {} }), values: {
    'patch.width': lit(1280), 'patch.height': lit(720), 'patch.sample_rate': lit(44_100), 'patch.channels': lit(1),
    'patch.color_space': lit('Bt601'), 'patch.background': lit(RGBA), 'patch.duration_us': lit(40 * S),
    // Content exists: the frame rate is locked (FpsLockedByContent).
    'patch.fps': lit({ num: 25, den: 1 }, { refuses: true }),
    composition_id: val((i) => i.groupComp, { with: () => ({ patch: { width: 1280 } }) }),
  } },
  set_project_settings: { base: () => ({ patch: {} }), values: {
    'patch.auto_pair_audio_on_import': lit(true), 'patch.prefer_proxies': lit(true),
    'patch.proxy_override': lit({ media_id: VIDEO, value: true }),
    'patch.shot_review': lit({ sensitivity: 0.25, min_shot_us: 2 * S }),
    'patch.pause_review': lit({ threshold_db: -20, min_pause_us: 2 * S, pad_us: 50_000 }),
  } },
  update_marker: { base: (i) => ({ marker_id: i.region, patch: {} }), values: {
    'patch.t_us': lit(1_500_000), 'patch.t_end_us': lit(3 * S), 'patch.label': lit('x'), 'patch.note': lit('y'), 'patch.color': lit(RGBA),
  } },
  set_marker_anchor: { base: (i) => ({ marker_id: i.marker, layer_id: i.vl }), values: {} },
  delete_media: { base: () => ({ media_id: VIDEO }), values: { force: lit(true) } },
  set_role_flags: { base: () => ({ role: 'music' }), values: { muted: lit(true), solo: lit(true) } },
  add_layers: { base: () => ({ layers: [{ t_start_us: 10 * S, t_end_us: 11 * S, content: { kind: 'color', color: RGBA } }] }), values: {
    // The spawn target: the layer's fresh track opens inside the Group, not the root.
    composition_id: val((i) => i.groupComp),
  } },
  split_layer: { base: (i) => ({ layer_id: i.vl, t_cut_us: [2 * S] }), values: { escape_link: lit(true) } },
  add_marker: { base: () => ({ t_us: 5 * S, label: 'n' }), values: {
    color: lit(RGBA), note: lit('why'), t_end_us: lit(6 * S), anchor_layer_id: val((i) => i.vl, { with: () => ({ t_us: 3 * S }) }),
    composition_id: val((i) => i.groupComp, { with: () => ({ t_us: S }) }),
  } },
  begin_agent_session: { base: () => ({ reason: 'cutting' }), values: { lock: lit(false) } },
  set_keyframe: { base: (i) => ({ layer_id: i.x, param_key: 'opacity', t_us: 500_000, value: 0.25 }), values: { easing: lit({ preset: 'ease_in' }) } },
  update_keyframe: { base: (i) => ({ layer_id: i.x, param_key: 'opacity', keyframe_id: i.k0 }), values: {
    t_us: lit(500_000), easing: lit({ kind: 'Hold' }), out: lit({ x: 0.3, y: 0.1 }), continuity: lit('Smooth'),
    in: val(() => ({ x: 0.6, y: 0.9 }), { with: (i) => ({ keyframe_id: i.k1 }) }),
    smooth: lit(true),
  } },
  update_tack: { base: (i) => ({ tack_id: i.tack, patch: {} }), values: {
    'patch.label': lit('other'), 'patch.body': lit('why'), 'patch.kind': lit('issue'), 'patch.status': lit('resolved'),
  } },
  delete_tacks: { base: () => ({}), values: { tack_ids: val((i) => [i.tack]), session_id: lit('not-a-session', { refuses: true }) } },
}

/** Tools, or `tool.field` probes, that cannot be probed on this fixture, with
 *  the reason. Keep each one honest: where the behaviour is pinned instead. */
const EXCEPTIONS: Record<string, string> = {
  restyle_to_taste: 'needs the app host\'s project style (project://taste); mcp.taste-defaults.test.ts covers its scopes',
  synthesize_speech: 'needs a TTS engine; every field is checked by the Rust parser and covered in native tts tests',
  apply_subtitles: 'parses a subtitle document through native compute (hybrids.test.ts)',
  auto_split_by_shot: 'reads a native shot scan (hybrids.test.ts covers min_shot_us / drop_short)',
  remove_pauses: 'reads native waveform peaks (hybrids.test.ts covers the pause parameters)',
  apply_transcripts: 'needs a transcript payload per source layer; mcp.captions-tools.test.ts covers source / composition_id',
  correct_caption_text: 'needs captions to correct; mcp.captions-tools.test.ts covers script and the scope arguments',
  install_motif: 'proposes from a draft in the user Motif store on disk (workspace.publication.test.ts covers target_id / expected_version)',
  export_motif: 'reads the user Motif store on disk; the path refusals are pinned in mcp.error-vocabulary and motifTools tests',
  create_export_preset: 'writes the app preference store (exportPresetTools.test.ts)',
  update_export_preset: 'writes the app preference store; exportPresetTools.test.ts covers name / settings / default alone and together',
  start_export: 'its fields shape an asynchronous job that needs the renderer (exportJobs.test.ts; the pre-reservation refusals in this file)',
  retry_export: 'needs a job awaiting finalization retry (exportJobs.test.ts)',
  create_project: 'replaces the open workspace (projectTools / workspace-orchestrator tests)',
  'begin_agent_session.force': 'force only acts on a session another connection holds (server.session.test.ts)',
  'set_marker_anchor.layer_id': 'the null arm is probed (it detaches); a value re-ties, which the base call already does',
}

// ── The gate ─────────────────────────────────────────────────────────────────

const probed = WRITES.map((t) => ({ tool: t.name, probes: probesOf(t.inputSchema as Schema) })).filter((t) => t.probes.length > 0)

describe('mcp.no-silent-outcomes: coverage', () => {
  it('the sweep reads the merged catalog: TS, Motif, export and Rust write tools', () => {
    const names = new Set(WRITES.map((t) => t.name))
    for (const n of ['rename_layer', 'export_motif', 'start_export', 'synthesize_speech', 'import_media']) expect(names.has(n), n).toBe(true)
  })

  it('every write tool with an optional or nullable field has a case or an exception', () => {
    const missing = probed.filter((t) => !CASES[t.tool] && !EXCEPTIONS[t.tool]).map((t) => t.tool)
    expect(missing, 'add a CASES entry (or an EXCEPTIONS entry with its reason)').toEqual([])
  })

  it('every value probe of a cased tool has a value or an exception', () => {
    const missing: string[] = []
    for (const t of probed) {
      const c = CASES[t.tool]
      if (!c) continue
      for (const p of t.probes) if (!(p.field in c.values) && !EXCEPTIONS[`${t.tool}.${p.field}`]) missing.push(`${t.tool}.${p.field}`)
    }
    expect(missing).toEqual([])
  })

  it('no case, value or exception names a tool or field the catalog does not advertise', () => {
    const fields = new Map(probed.map((t) => [t.tool, new Set(t.probes.map((p) => p.field))]))
    const stale: string[] = []
    for (const [tool, c] of Object.entries(CASES)) {
      if (!fields.has(tool)) stale.push(tool)
      for (const f of [...Object.keys(c.values), ...(c.nullRefuses ?? [])]) if (!fields.get(tool)?.has(f)) stale.push(`${tool}.${f}`)
    }
    for (const key of Object.keys(EXCEPTIONS)) {
      const [tool, field] = key.split(/\.(.+)/)
      if (!CATALOG.some((t) => t.name === tool) || (field !== undefined && !fields.get(tool!)?.has(field))) stale.push(key)
    }
    expect(stale).toEqual([])
  })
})

/** Run `args` on a fresh world; the fingerprint after, and the answer. */
async function run(tool: string, args: (i: Ids) => Record<string, unknown>): Promise<{ before: string; after: string; r: Answer }> {
  const w = await world()
  const before = fingerprint(w)
  const r = await call(w, tool, args(w.ids))
  return { before, after: fingerprint(w), r }
}
const text = (r: Answer) => r.content?.map((b) => b.text ?? '').join('\n') ?? ''
function setPath(args: Record<string, unknown>, field: string, v: unknown): Record<string, unknown> {
  if (!field.startsWith('patch.')) return { ...args, [field]: v }
  return { ...args, patch: { ...(args.patch as Record<string, unknown> | undefined), [field.slice(6)]: v } }
}

describe('mcp.no-silent-outcomes: every optional and nullable field, alone', () => {
  for (const t of probed) {
    const c = CASES[t.tool]
    if (!c) continue
    for (const p of t.probes) {
      const value = c.values[p.field]
      if (value && !EXCEPTIONS[`${t.tool}.${p.field}`]) {
        it(`${t.tool} { ${p.field} }`, async () => {
          const base = (i: Ids) => ({ ...c.base(i), ...value.with?.(i) })
          const alone = await run(t.tool, base)
          const probe = await run(t.tool, (i) => setPath(base(i), p.field, value.v(i)))
          if (value.refuses) { expect(probe.r.isError, `expected a refusal, got: ${text(probe.r)}`).toBe(true); expect(probe.after).toBe(probe.before); return }
          expect(probe.r.isError, `refused: ${text(probe.r)}`).toBeFalsy()
          expect(probe.after, `${p.field} changed nothing beyond the call without it: ${text(probe.r)}`).not.toBe(alone.after)
        })
      }
      if (p.nullArm) {
        it(`${t.tool} { ${p.field}: null }`, async () => {
          const probe = await run(t.tool, (i) => setPath(c.base(i), p.field, null))
          if (c.nullRefuses?.includes(p.field)) { expect(probe.r.isError, text(probe.r)).toBe(true); expect(probe.after).toBe(probe.before); return }
          expect(probe.r.isError, `refused: ${text(probe.r)}`).toBeFalsy()
          expect(probe.after, `null changed nothing: ${text(probe.r)}`).not.toBe(probe.before)
        })
      }
    }
  }
})

// ── The audit's live probes (probes.md), re-run on the fixture ──────────────

describe('the audit probes refuse or change state', () => {
  const keysOf = (w: World) => (w.actor.snapshot().compositions[w.actor.snapshot().root_id]!.tracks.flatMap((t) => t.layers).find((l) => l.id === w.ids.x)!.params as unknown as { opacity: { mode: string; value: Array<{ id: string; t_us: number; value: number }> } }).opacity.value

  it('H5: set_role_flags naming no flag, or a flag that is not a boolean, refuses and changes nothing', async () => {
    const w = await world()
    const before = fingerprint(w)
    for (const args of [{ role: 'music' }, { role: 'music', muted: 'true' }]) {
      const r = await call(w, 'set_role_flags', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.structuredContent?.code).toBe('invalid_params')
    }
    expect(fingerprint(w)).toBe(before)
  })

  it('T15: update_marker takes no null on label, note, colour or time; t_end_us: null makes a point', async () => {
    const w = await world()
    const before = fingerprint(w)
    for (const k of ['label', 'note', 'color', 't_us']) expect((await call(w, 'update_marker', { marker_id: w.ids.region, patch: { [k]: null } })).isError, k).toBe(true)
    expect(fingerprint(w)).toBe(before)
    expect((await must(w, 'update_marker', { marker_id: w.ids.region, patch: { t_end_us: null } })).t_end_us).toBeNull()
  })

  it('T1: rename_layer and set_layer_flags refuse the times, naming move_layers and trim_layer', async () => {
    const w = await world()
    const before = fingerprint(w)
    const start = await call(w, 'rename_layer', { layer_id: w.ids.c, label: 'x', t_start_us: 3 * S })
    expect(start.isError).toBe(true)
    expect(text(start)).toMatch(/move_layers/)
    const end = await call(w, 'set_layer_flags', { layer_ids: [w.ids.c], locked: true, t_end_us: 3 * S })
    expect(end.isError).toBe(true)
    expect(text(end)).toMatch(/trim_layer/)
    expect(fingerprint(w)).toBe(before)
  })

  it('L1: set_keyframe a few µs off a key updates that key and keeps its id', async () => {
    const w = await world()
    for (const t_us of [S - 10, S + 10]) {
      const r = await must(w, 'set_keyframe', { layer_id: w.ids.x, param_key: 'opacity', t_us, value: 0.25 })
      expect(r.keyframe_id, String(t_us)).toBe(w.ids.k1)
      expect(keysOf(w)).toHaveLength(2)
      expect(keysOf(w).find((k) => k.id === w.ids.k1)!.value).toBe(0.25)
    }
  })

  it('H2: update_keyframe onto a frame another key holds refuses with KeyframeOccupied, naming it', async () => {
    const w = await world()
    const k2 = id(await must(w, 'set_keyframe', { layer_id: w.ids.x, param_key: 'opacity', t_us: 1_500_000, value: 0 }), 'keyframe_id')
    const before = fingerprint(w)
    const r = await call(w, 'update_keyframe', { layer_id: w.ids.x, param_key: 'opacity', keyframe_id: w.ids.k1, t_us: 1_500_010 })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_params', error: 'KeyframeOccupied', keyframe_id: k2 })
    expect(text(r)).toContain(k2)
    expect(fingerprint(w)).toBe(before)
  })

  it('set_param_track with two keys that snap onto one frame refuses, naming both; nothing is written', async () => {
    const w = await world()
    const before = fingerprint(w)
    const r = await call(w, 'set_param_track', { layer_id: w.ids.x, param_key: 'opacity', track: { mode: 'Keyframed', value: [{ t_us: 0, value: 1 }, { t_us: S, value: 0.5 }, { t_us: S + 10, value: 0 }] } })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ code: 'invalid_params', error: 'KeyframesShareFrame', keys: [1, 2], t_us: S })
    expect(text(r)).toMatch(/track\.value\[1\].*track\.value\[2\]/)
    expect(fingerprint(w)).toBe(before)
  })

  it('update_effect refuses a null `enabled` or `params` and an empty patch, which the schema does not advertise', async () => {
    const w = await world()
    const before = fingerprint(w)
    for (const patch of [{ enabled: null }, { params: null }, {}]) {
      const r = await call(w, 'update_effect', { layer_id: w.ids.vl, effect_id: w.ids.effect, patch })
      expect(r.isError, JSON.stringify(patch)).toBe(true)
    }
    expect(fingerprint(w)).toBe(before)
  })

  it('ME10 / ME11: start_export refuses what cannot run before a job exists; get_export_status always answers { job }', async () => {
    const w = await world()
    const dir = (w.host.openedProject as () => { dir: string })().dir
    expect((await call(w, 'get_export_status', {})).structuredContent).toEqual({ job: null })
    // A wait with no job to watch answers at once; a wait past the cap refuses.
    expect((await call(w, 'get_export_status', { wait_s: 60 })).structuredContent).toEqual({ job: null })
    expect((await call(w, 'get_export_status', { wait_s: 61 })).structuredContent).toMatchObject({ code: 'invalid_params', error: 'InvalidArgument' })
    const wrongExt = await call(w, 'start_export', { output_path: join(dir, 'cut.mov') })
    expect(wrongExt.structuredContent).toMatchObject({ code: 'invalid_params', error: 'InvalidArgument' })
    expect(text(wrongExt)).toContain('get_export_options')
    expect((await call(w, 'start_export', { output_path: join(dir, 'missing', 'cut.mp4') })).structuredContent).toMatchObject({ code: 'invalid_params', error: 'PathNotFound' })
    writeFileSync(join(dir, 'taken.mp4'), 'mine')
    expect((await call(w, 'start_export', { output_path: join(dir, 'taken.mp4'), on_conflict: 'fail' })).structuredContent).toMatchObject({ code: 'invalid_params', error: 'PathExists' })
    expect(readFileSync(join(dir, 'taken.mp4'), 'utf8')).toBe('mine')
    // Nothing refused left a job behind.
    expect((await call(w, 'get_export_status', {})).structuredContent).toEqual({ job: null })
    const started = id(await must(w, 'start_export', {}), 'job_id')
    expect((await call(w, 'get_export_status', {})).structuredContent).toMatchObject({ job: { job_id: started } })
    expect((await call(w, 'get_export_status', { job_id: started })).structuredContent).toMatchObject({ job: { job_id: started } })
    await must(w, 'cancel_export', { job_id: started })
    // Once it ended, the same call still reads it.
    expect((await call(w, 'get_export_status', {})).structuredContent).toMatchObject({ job: { job_id: started } })
  })

  it('ME16 / ME10: get_export_options answers the extension, not the settings schema; output_path names the rule', async () => {
    const w = await world()
    const options = await must(w, 'get_export_options', {})
    expect(options).not.toHaveProperty('settings_schema')
    expect(options).toMatchObject({ extension: 'mp4' })
    const outputPath = (EXPORT_TOOL_DEFS.find((d) => d.name === 'start_export')!.inputSchema.properties as Record<string, { description: string }>).output_path!.description
    expect(outputPath).toMatch(/extension must match the container/)
    expect(outputPath).toContain('get_export_options')
  })

  it('ME17/ME20: preview_motif takes motif_id, no alias, and is schema-checked', async () => {
    const w = await world()
    const alias = await call(w, 'preview_motif', { id: 'lower-third', local_t_s: [0] })
    expect(alias.isError).toBe(true)
    expect(text(alias)).toContain('does not take id')
    const untyped = await call(w, 'preview_motif', { motif_id: 'lower-third', local_t_s: 1 })
    expect(untyped.isError).toBe(true)
    expect(text(untyped)).toContain('local_t_s')
    const tooMany = await call(w, 'preview_motif', { motif_id: 'lower-third', local_t_s: Array.from({ length: 25 }, (_, i) => i / 10) })
    expect(tooMany.isError).toBe(true)
    expect(text(tooMany)).toContain('1–24')
  })
})
