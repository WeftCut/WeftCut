import { describe, it, expect } from 'vitest'
import { MCP_TOOL_DEFS, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, MCP_TOOLS } from '../mcp-commands'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

const ALL_67_NAMES = new Set<string>([
  // table-exec tools (44)
  'add_track', 'remove_track', 'rename_track', 'duplicate_layer', 'paste_layers', 'move_track',
  'update_layer', 'set_layers_enabled', 'update_layer_params', 'set_scale_linked',
  'move_layer', 'restack_layer', 'trim_layer', 'delete_layer',
  'links_create', 'links_dissolve', 'links_add_members', 'links_remove_members', 'links_rename',
  'groups_create', 'groups_add_members', 'move_layers_to_composition', 'add_group_layer', 'groups_ungroup', 'groups_rename', 'compositions_delete',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'add_transition', 'update_transition', 'remove_transition',
  'set_composition', 'fit_composition_to_layers',
  'update_marker', 'remove_marker', 'attach_marker', 'detach_marker',
  'remove_media', 'undo', 'redo',
  'set_role_gain', 'set_role_flags',
  // dedicated-exec tools (23) — auto_split_by_shot is a TS-owned HYBRID def
  // (routes 'hybrid', not an actor arm) that carries a parseDedicated for the
  // bijection required-scalar gate.
  'add_color_layer', 'add_video_layer', 'split_layer', 'add_marker',
  'add_motif',
  'lock_history', 'unlock_history',
  'set_keyframe', 'get_param_track', 'remove_keyframe', 'retime_keyframe',
  'set_keyframe_easing', 'smooth_keyframes', 'clear_keyframes', 'set_param_track',
  'set_keyframe_tangents', 'set_extrapolation',
  'dry_run', 'checkpoint', 'list_checkpoints', 'restore_checkpoint', 'begin_agent_session',
  'auto_split_by_shot',
])

describe('MCP tool table projections', () => {
  it('MCP_TOOLS contains exactly the 67 tool names', () => {
    expect(MCP_TOOLS).toEqual(ALL_67_NAMES)
  })

  it('MCP_TOOLS equals the set of def names', () => {
    expect(MCP_TOOLS).toEqual(new Set(MCP_TOOL_DEFS.map((d) => d.name)))
  })

  it('MCP_ARG_PARSERS keys match the table-exec defs', () => {
    const tableExecNames = new Set(MCP_TOOL_DEFS.filter((d) => d.parseArgs).map((d) => d.name))
    expect(new Set(Object.keys(MCP_ARG_PARSERS))).toEqual(tableExecNames)
  })

  it('MCP_RESULT_SHAPERS keys match the shapeResult defs', () => {
    const shaperNames = new Set(MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => d.name))
    expect(new Set(Object.keys(MCP_RESULT_SHAPERS))).toEqual(shaperNames)
  })

  it('every table-exec def round-trips a representative valid arg set identically to its prior parser', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(MCP_ARG_PARSERS['remove_track']({ track_id: u })).toEqual({ op: 'delete_track', args: { track: u, force: false } })
    expect(MCP_ARG_PARSERS['set_role_gain']({ role: 'music', gain_db: -3 })).toEqual({ op: 'set_role_gain', args: { role: 'music', gain_db: -3 } })
  })

  it('hardened parseArgs rejects malformed input (was a silent as-cast)', () => {
    // force must be a boolean
    expect(() => MCP_ARG_PARSERS['remove_track']({ track_id: '00000000-0000-7000-8000-000000000001', force: 'yes' })).toThrow()
    // gain_db must be a finite number
    expect(() => MCP_ARG_PARSERS['set_role_gain']({ role: 'music', gain_db: 'loud' })).toThrow()
  })

  it('dedicated-exec defs have no parseArgs', () => {
    const dedicated = MCP_TOOL_DEFS.filter((d) => d.exec === 'dedicated')
    expect(dedicated.length).toBe(23)
    for (const d of dedicated) {
      expect(d.parseArgs, `${d.name} should not have parseArgs`).toBeUndefined()
    }
  })

  it('table-exec defs all have parseArgs', () => {
    const table = MCP_TOOL_DEFS.filter((d) => d.exec === 'table')
    expect(table.length).toBe(44)
    for (const d of table) {
      expect(d.parseArgs, `${d.name} should have parseArgs`).toBeDefined()
    }
  })

  // The tool description is the string the AGENT actually reads — the prose docs
  // are for humans. When `jump_to` joined the revert paths both docs were
  // updated and this drifted, leaving the agent told it could still be reverted
  // by the one path the panel makes easiest.
  const REVERT_PATHS = 'undo / redo / jump_to / restore_checkpoint'
  it('lock_history ENUMERATES every revert path the lock actually rejects', () => {
    const def = MCP_TOOL_DEFS.find((d) => d.name === 'lock_history')!
    // The enumeration itself, not just a mention somewhere in the prose: an
    // agent reads the list in the parentheses to decide what is still available.
    expect(def.description).toContain(REVERT_PATHS)
    // …and it must not re-tell the myth docs/mcp.md used to: the lock rejects
    // reverts, it never changes what RECORDS (docs/features.md#undo-stack-scope).
    expect(def.description).toMatch(/never affects what records|does not fold/i)
  })

  it('unlock_history enumerates the same paths it re-enables', () => {
    const def = MCP_TOOL_DEFS.find((d) => d.name === 'unlock_history')!
    expect(def.description).toContain(REVERT_PATHS)
  })

  it('shapeResult tools are the expected 8', () => {
    const shapers = MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => d.name).sort()
    expect(shapers).toEqual(['add_effect', 'add_group_layer', 'add_track', 'add_transition', 'duplicate_layer', 'groups_create', 'links_create', 'paste_layers'])
  })

  it('paste_layers / set_layers_enabled round-trip valid args and reject malformed ones', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    const t = '00000000-0000-7000-8000-0000000000aa'
    expect(MCP_ARG_PARSERS['paste_layers']({ layer_ids: [u1, u2], t_start_us: 1_000_000 }))
      .toEqual({ op: 'paste_layers', args: { layers: [u1, u2], t_start_us: 1_000_000, target_track_id: null } })
    expect(MCP_ARG_PARSERS['paste_layers']({ layer_ids: [u1], t_start_us: 0, target_track_id: t }).args.target_track_id).toBe(t)
    expect(() => MCP_ARG_PARSERS['paste_layers']({ layer_ids: u1, t_start_us: 0 })).toThrow()               // not an array
    expect(() => MCP_ARG_PARSERS['paste_layers']({ layer_ids: [u1], t_start_us: 'later' })).toThrow()      // non-number start
    expect(() => MCP_ARG_PARSERS['paste_layers']({ layer_ids: [u1], t_start_us: 0, target_track_id: 'A roll' })).toThrow() // non-uuid track
    expect(MCP_ARG_PARSERS['set_layers_enabled']({ layer_ids: [u1, u2], enabled: false }))
      .toEqual({ op: 'set_layers_enabled', args: { layers: [u1, u2], enabled: false } })
    expect(() => MCP_ARG_PARSERS['set_layers_enabled']({ layer_ids: [u1], enabled: 'no' })).toThrow()      // non-boolean
  })

  it('parseBoolOpt hardening: escape_link rejects non-boolean', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    expect(() => MCP_ARG_PARSERS['move_layer']({ layer_id: u, new_track_id: u2, new_t_start_us: 0, escape_link: 'true' })).toThrow()
  })

  it('asArray hardening: layer_ids rejects non-array', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(() => MCP_ARG_PARSERS['links_create']({ layer_ids: u, label: null })).toThrow()
  })

  it('transition tools round-trip valid args to dispatch vocabulary', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    expect(MCP_ARG_PARSERS['add_transition']({ from_layer_id: u1, to_layer_id: u2, duration_us: 1_000_000, kind: 'Wipe', direction: 'left' }))
      .toEqual({ op: 'add_transition', args: { from: u1, to: u2, duration_us: 1_000_000, kind: 'Wipe', direction: 'left' } })
    // kind omitted = Crossfade default; the raw (absent) fields pass through
    expect(MCP_ARG_PARSERS['add_transition']({ from_layer_id: u1, to_layer_id: u2, duration_us: 500_000 }))
      .toEqual({ op: 'add_transition', args: { from: u1, to: u2, duration_us: 500_000, kind: undefined, direction: undefined } })
    expect(MCP_ARG_PARSERS['update_transition']({ transition_id: u1, duration_us: 250_000, kind: 'Slide', direction: 'down' }))
      .toEqual({ op: 'update_transition', args: { transition: u1, duration_us: 250_000, kind: 'Slide', direction: 'down' } })
    expect(MCP_ARG_PARSERS['remove_transition']({ transition_id: u1 }))
      .toEqual({ op: 'remove_transition', args: { transition: u1 } })
  })

  it('placement and extended_us round-trip through the def parsers (toEqual ignores undefined keys, so pin them present)', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    const add = MCP_ARG_PARSERS['add_transition']({ from_layer_id: u1, to_layer_id: u2, duration_us: 1_000_000, placement: 'extend' })
    expect(add.args.placement).toBe('extend')
    const upd = MCP_ARG_PARSERS['update_transition']({ transition_id: u1, duration_us: 500_000, extended_us: 250_000 })
    expect(upd.args.extended_us).toBe(250_000)
  })

  it('placement / extended_us reject bad values at the MCP boundary', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    expect(() => MCP_ARG_PARSERS['add_transition']({ from_layer_id: u1, to_layer_id: u2, duration_us: 1_000_000, placement: 'both' })).toThrow()   // unknown placement
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, extended_us: 'all of it' })).toThrow()                                    // non-number extended_us
  })

  it('transition parsers reject bad kind/direction combos at the MCP boundary', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    const base = { from_layer_id: u1, to_layer_id: u2, duration_us: 1_000_000 }
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Dissolve' })).toThrow()                       // unknown kind
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Wipe' })).toThrow()                           // missing direction
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Slide' })).toThrow()                          // missing direction
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Wipe', direction: 'diagonal' })).toThrow()    // bad direction
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Crossfade', direction: 'left' })).toThrow()   // direction on Crossfade
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, direction: 'left' })).toThrow()                      // absent kind = Crossfade → direction rejected
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, kind: 'Wipe' })).toThrow()              // missing direction
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, direction: 'left' })).toThrow()         // direction without kind
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, duration_us: 'long' })).toThrow()       // non-number duration
  })

  it('parseStrOpt hardening: label rejects non-string non-null', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(() => MCP_ARG_PARSERS['links_create']({ layer_ids: [u], label: 42 })).toThrow()
  })
})

describe('transition tools through mcpCall (table-exec, end to end)', () => {
  /** Actor with A1=[0,2M] → A2=[2M,4M] color layers on the A roll (adjacent cut). */
  function withCut() {
    const idGen = uuidV7Gen()
    const initial = blankProject(idGen, 't')
    const actor = createActor({ initial, idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const track = root(initial).tracks[0].id
    const a1 = (actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const a2 = (actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }) as { ok: true; value: string }).value
    return { actor, track, a1, a2 }
  }

  it('add → update → remove round-trips through the MCP surface', () => {
    const { actor, a1, a2 } = withCut()
    const add = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000, kind: 'Wipe', direction: 'left' }))
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const tid = add.result.content[0].text
    expect(root(actor.snapshot()).transitions[0]).toMatchObject({ id: tid, kind: { kind: 'Wipe', direction: 'left' } })
    const upd = actor.mcpCall('update_transition', JSON.stringify({ transition_id: tid, duration_us: 500_000, kind: 'Crossfade' }))
    expect(upd.ok).toBe(true)
    expect(root(actor.snapshot()).transitions[0]).toMatchObject({ duration_us: 500_000, kind: { kind: 'Crossfade' } })
    const rem = actor.mcpCall('remove_transition', JSON.stringify({ transition_id: tid }))
    expect(rem.ok).toBe(true)
    expect(root(actor.snapshot()).transitions).toEqual([])
  })

  it('bad kind / missing direction / direction on Crossfade → clean invalid_params, no commit', () => {
    const { actor, a1, a2 } = withCut()
    const base = { from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 }
    for (const args of [
      { ...base, kind: 'Dissolve' },
      { ...base, kind: 'Wipe' },
      { ...base, kind: 'Slide', direction: 'diagonal' },
      { ...base, kind: 'Crossfade', direction: 'left' },
    ]) {
      const r = actor.mcpCall('add_transition', JSON.stringify(args))
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_params')
    }
    expect(root(actor.snapshot()).transitions).toEqual([])
  })

  it('the default (no placement arg) add is overlap: MCP moves the incoming layer instead of extending', () => {
    const { actor, track, a1, a2 } = withCut()
    // A video layer with ZERO tail media (src_out == media duration) as the
    // outgoing participant: extending is impossible, but overlap needs no tail.
    const MID = '00000000-0000-7000-8000-0000000000aa'
    actor.dispatch('add_media', { id: MID, kind: 'Video', duration_us: 2_000_000 })
    actor.dispatch('delete_layer', { layer: a1 }) // free [0,2M)
    const v1 = (actor.dispatch('add_layer', { track, kind: 'video', media: MID, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const r = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: v1, to_layer_id: a2, duration_us: 1_000_000 }))
    expect(r.ok).toBe(true)
    const layers = root(actor.snapshot()).tracks[0].layers
    expect(layers.find((l) => l.id === v1)!.t_end_us).toBe(2_000_000) // A untouched
    expect(layers.find((l) => l.id === a2)!.t_start_us).toBe(1_000_000) // B moved left
    expect(root(actor.snapshot()).transitions[0].extended_us).toBe(0)
  })

  it("placement 'extend' rides the MCP surface: TransitionInsufficientHandle surfaces friendly prose + structured data (available_us)", () => {
    // The def advertises placement, so the whole trip runs through mcpCall —
    // the exact JSON an MCP client would receive.
    const { actor, track, a1, a2 } = withCut()
    const MID = '00000000-0000-7000-8000-0000000000aa'
    actor.dispatch('add_media', { id: MID, kind: 'Video', duration_us: 2_000_000 })
    actor.dispatch('delete_layer', { layer: a1 }) // free [0,2M)
    const v1 = (actor.dispatch('add_layer', { track, kind: 'video', media: MID, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const r = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: v1, to_layer_id: a2, duration_us: 1_000_000, placement: 'extend' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('µs remaining')
    expect(r.error.data).toEqual({ error: 'TransitionInsufficientHandle', layer: v1, available_us: 0 })
    expect(root(actor.snapshot()).transitions).toEqual([])
  })

  it('update_transition threads an explicit extended_us: the window slides onto borrowed tail through the MCP surface', () => {
    const { actor, a1, a2 } = withCut()
    const add = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 }))
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const tid = add.result.content[0].text
    // Overlap add: A untouched at [0,2M], B moved to [1M,3M], e = 0.
    const upd = actor.mcpCall('update_transition', JSON.stringify({ transition_id: tid, extended_us: 500_000 }))
    expect(upd.ok).toBe(true)
    // Duration unchanged; the whole window slid right by the borrow: A.end =
    // S + e′ = 2.5M (Color layers have unlimited handle), B.start = 1.5M.
    expect(root(actor.snapshot()).transitions[0]).toMatchObject({ duration_us: 1_000_000, extended_us: 500_000 })
    const layers = root(actor.snapshot()).tracks[0].layers
    expect(layers.find((l) => l.id === a1)!.t_end_us).toBe(2_500_000)
    expect(layers.find((l) => l.id === a2)!.t_start_us).toBe(1_500_000)
  })

  it('TransitionParticipantsShareLink surfaces prose + structured data with the two ways out', () => {
    const { actor, a1, a2 } = withCut()
    expect(actor.dispatch('links_create', { layers: [a1, a2], label: null, reassign: false }).ok).toBe(true)
    const r = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('share a link')
    expect(r.error.data).toMatchObject({ error: 'TransitionParticipantsShareLink', from: a1, to: a2 })
    expect(root(actor.snapshot()).transitions).toEqual([])
  })

  it('audio participant → TransitionUnsupportedLayerKind prose + data', () => {
    const { actor, track, a1, a2 } = withCut()
    const MID = '00000000-0000-7000-8000-0000000000ab'
    actor.dispatch('add_media', { id: MID, kind: 'Audio', duration_us: 10_000_000 })
    actor.dispatch('delete_layer', { layer: a1 })
    const au = (actor.dispatch('add_layer', { track, kind: 'audio', media: MID, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const r = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: au, to_layer_id: a2, duration_us: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('visual layers only')
    expect(r.error.data).toEqual({ error: 'TransitionUnsupportedLayerKind', layer: au, kind: 'Audio' })
  })
})

describe('marker anchoring through mcpCall (the agent surface, end to end)', () => {
  const MID = '00000000-0000-7000-8000-0000000000ac'
  /** One video clip at [1M,3M) windowed on [2M,4M) of its media, plus a Color
   *  layer — the two kinds an anchor is accepted and refused on.
   *
   *  The Color layer takes a lane of its OWN and sits clear of [4M,6M): these
   *  tests move the clip there to watch a mark follow it, and a blocking layer
   *  would fail that move as a LayerOverlap, reading as "the anchor did not
   *  follow" when nothing about anchoring was exercised at all. */
  function withClip() {
    const idGen = uuidV7Gen()
    const initial = blankProject(idGen, 't')
    const actor = createActor({ initial, idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const track = root(initial).tracks[0].id
    const spare = (actor.dispatch('add_track', { label: 'spare' }) as { ok: true; value: string }).value
    actor.dispatch('add_media', { id: MID, kind: 'Video', duration_us: 10_000_000 })
    const clip = (actor.dispatch('add_layer', { track, kind: 'video', media: MID, src_in_us: 2_000_000, src_out_us: 4_000_000, t_start_us: 1_000_000, t_end_us: 3_000_000 }) as { ok: true; value: string }).value
    const color = (actor.dispatch('add_layer', { track: spare, kind: 'color', t_start_us: 7_000_000, t_end_us: 9_000_000 }) as { ok: true; value: string }).value
    return { actor, track, spare, clip, color }
  }
  const RED = { r: 255, g: 0, b: 0, a: 255 }
  const addMarker = (actor: ReturnType<typeof withClip>['actor'], args: Record<string, unknown>) =>
    actor.mcpCall('add_marker', JSON.stringify({ t_us: 2_000_000, label: 'cut', color: RED, ...args }))

  it('an anchored add derives src_us from the clip, follows it, and spends ONE undo on both', () => {
    const { actor, track, clip } = withClip()
    const before = actor.historyStatus().len
    const r = addMarker(actor, { anchor_layer_id: clip })
    expect(r.ok).toBe(true)
    // 2M is 1M into the clip, which is windowed from 2M of the source.
    expect(root(actor.snapshot()).markers[0]).toMatchObject({ t_us: 2_000_000, anchor: { layer: clip, src_us: 3_000_000 } })
    expect(actor.historyStatus().len).toBe(before + 1)

    expect(actor.dispatch('move_layer', { layer: clip, to_track: track, t_start_us: 4_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0].t_us).toBe(5_000_000)

    // One commit created the mark AND its tie, so one undo takes both — the
    // caller is never left holding a marker it did not ask for on its own.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(root(actor.snapshot()).markers).toEqual([])
  })

  it('a refused anchor creates NO marker, rather than a free one to clean up', () => {
    const { actor, color } = withClip()
    const before = actor.historyStatus().len
    const r = addMarker(actor, { anchor_layer_id: color })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    // The MESSAGE, because MCP clients drop `data` — an agent told only
    // "WrongLayerKind" cannot see which layer it named or what would work.
    expect(r.error.message).toContain(color)
    expect(r.error.message).toContain('VideoClip | Audio | CompositionRef')
    expect(root(actor.snapshot()).markers).toEqual([])
    expect(actor.historyStatus().len).toBe(before)
  })

  it('a time the clip does not cover is refused on t_us, not silently teleported onto it', () => {
    const { actor, clip } = withClip()
    const r = addMarker(actor, { t_us: 8_000_000, anchor_layer_id: clip })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
    expect(root(actor.snapshot()).markers).toEqual([])
  })

  it('omitting anchor_layer_id is the ordinary marker: fixed to the timeline, untouched by the clip', () => {
    const { actor, track, clip } = withClip()
    expect(addMarker(actor, {}).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0].anchor).toBeNull()
    expect(actor.dispatch('move_layer', { layer: clip, to_track: track, t_start_us: 4_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0].t_us).toBe(2_000_000)
  })

  it('attach_marker then detach_marker route through the table: the mark starts following, then stops on the frame it reads', () => {
    const { actor, track, clip } = withClip()
    const add = addMarker(actor, {})
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const markerId = add.result.content[0].text

    expect(actor.mcpCall('attach_marker', JSON.stringify({ marker_id: markerId, layer_id: clip })).ok).toBe(true)
    // The tie names where the mark already sat, so attaching by itself moves nothing.
    expect(root(actor.snapshot()).markers[0]).toMatchObject({ t_us: 2_000_000, anchor: { layer: clip, src_us: 3_000_000 } })
    expect(actor.dispatch('move_layer', { layer: clip, to_track: track, t_start_us: 4_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0].t_us).toBe(5_000_000)

    expect(actor.mcpCall('detach_marker', JSON.stringify({ marker_id: markerId })).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0]).toMatchObject({ t_us: 5_000_000, anchor: null })
    expect(actor.dispatch('move_layer', { layer: clip, to_track: track, t_start_us: 1_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0].t_us).toBe(5_000_000)
  })

  // Both are claims the tool descriptions make to the agent in so many words.
  it('attaching an already-anchored marker replaces the tie, and detaching one that follows nothing is accepted', () => {
    const { actor, spare, clip } = withClip()
    const add = addMarker(actor, { anchor_layer_id: clip })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const markerId = add.result.content[0].text

    // A second clip covering the same instant, on its own lane: the marker
    // moves its tie there rather than being refused for already having one.
    const other = (actor.dispatch('add_layer', { track: spare, kind: 'video', media: MID, src_in_us: 6_000_000, src_out_us: 8_000_000, t_start_us: 1_000_000, t_end_us: 3_000_000 }) as { ok: true; value: string }).value
    expect(actor.mcpCall('attach_marker', JSON.stringify({ marker_id: markerId, layer_id: other })).ok).toBe(true)
    expect(root(actor.snapshot()).markers[0].anchor).toEqual({ layer: other, src_us: 7_000_000 })

    expect(actor.mcpCall('detach_marker', JSON.stringify({ marker_id: markerId })).ok).toBe(true)
    // Detaching what already follows nothing is accepted rather than refused,
    // and costs no history entry: the recipe leaves the draft untouched, so the
    // commit records nothing. An agent can therefore detach defensively without
    // first reading the marker to find out whether it needed to.
    const spent = actor.historyStatus().len
    expect(actor.mcpCall('detach_marker', JSON.stringify({ marker_id: markerId })).ok).toBe(true)
    expect(actor.historyStatus().len).toBe(spent)
    expect(root(actor.snapshot()).markers[0].anchor).toBeNull()
  })

  it('a non-uuid layer id is refused at the parser, before anything is dispatched', () => {
    const { actor } = withClip()
    expect(() => MCP_ARG_PARSERS['attach_marker']({ marker_id: '00000000-0000-7000-8000-000000000001', layer_id: 'the beach shot' })).toThrow()
    const r = addMarker(actor, { anchor_layer_id: 'the beach shot' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
    expect(root(actor.snapshot()).markers).toEqual([])
  })
})

describe('dedicated arms reject malformed scalars before commit', () => {
  const mk = () => createActor({ initial: blankProject(uuidV7Gen(), 't'), idGen: uuidV7Gen(), clock: () => '2026-01-01T00:00:00.000Z' })
  it('set_keyframe rejects non-number t_us', () => {
    const r = mk().mcpCall('set_keyframe', JSON.stringify({ layer_id: '00000000-0000-7000-8000-000000000001', param_key: 'opacity', t_us: 'soon', value: 1 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
  })
  it('set_keyframe rejects non-string param_key', () => {
    const r = mk().mcpCall('set_keyframe', JSON.stringify({ layer_id: '00000000-0000-7000-8000-000000000001', param_key: 42, t_us: 0, value: 1 }))
    expect(r.ok).toBe(false)
  })
  it('dry_run rejects non-array operations', () => {
    const r = mk().mcpCall('dry_run', JSON.stringify({ operations: 'nope' }))
    expect(r.ok).toBe(false)
  })
})
