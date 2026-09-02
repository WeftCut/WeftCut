import { describe, it, expect } from 'vitest'
import {
  routeChannel,
  HYBRID_CHANNELS, SLICE_INJECTED_READS, PURE_NATIVE, PERSISTENCE, MOTIF_CHANNELS,
  CLIP_COMPUTE_CHANNELS, DIRECT_NAPI_READS,
} from './router'
import { PRODUCTION_OPS } from './commands'

// ── Partition gate manifest ──────────────────────────────────────────────────
// Every renderer `cmd` string the router classifies. KEEP IN SYNC: adding a
// channel requires adding it here AND classifying it into exactly one router
// bucket, or the gate below fails (an unclassified channel routes to
// {kind:'reject'}). This is the single-writer safety backstop: no
// project-touching channel may reach Rust.
const ALL_CHANNELS: readonly string[] = [
  // category-A mutations → PRODUCTION_OPS (command)
  'add_track', 'separate_audio_to_new_track', 'add_demo_color_layer', 'add_color_layer',
  'add_media_layer', 'add_text_layer', 'add_demo_text_layer', 'update_layer', 'update_layer_params',
  'update_layer_param_track', 'update_layer_param_tracks', 'update_param_tracks_multi', 'add_effect', 'update_effect',
  'move_effect', 'remove_effect', 'move_layer', 'move_layers_to_new_track', 'restack_layer', 'trim_layer', 'split_layer_linked',
  'links_create', 'links_dissolve', 'links_rename', 'duplicate_layer', 'paste_layer', 'paste_layers', 'set_layers_enabled', 'delete_layer', 'delete_layers', 'remove_media', 'set_composition',
  'groups_create', 'groups_add_members', 'move_layers_to_composition', 'groups_ungroup', 'groups_rename', 'compositions_delete',
  'fit_composition_to_layers', 'update_track_flags', 'rename_track', 'set_role_gain', 'update_role_flags',
  'add_transition', 'update_transition', 'remove_transition',
  'add_marker', 'update_marker', 'remove_marker', 'attach_marker', 'detach_marker',
  'project_undo', 'project_redo', 'project_restore_checkpoint', 'update_project_settings',
  'project_jump_to', 'project_create_checkpoint', 'project_delete_checkpoint',
  'restyle_captions', 'add_motif',
  // router special-cases (summary / history read / settings / persistence seam / agent-session)
  'project_summary', 'project_history_view', 'get_project_settings', 'project_open', 'project_save_as',
  'project_new_workspace', 'project_save', 'agent_session_end', 'agent_session_begin',
  // motif route (TS authoring + read + install + staleness)
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft',
  'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif',
  'motif_staleness_report', 'acknowledge_motif_staleness',
  // pure native (no project actor)
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish',
  'export_video_sink_cancel', 'import_cancel', 'import_queue_list', 'report_audio_meter',
  'settings_get_api_key_status', 'settings_test_provider',
  // hybrids (native-compute → TS-write)
  'import_media', 'drop_shot_markers', 'apply_shot_cuts', 'mark_silences',
  'apply_subtitles', 'synthesize_speech',
  // clip compute (actor-resolved { layer, media } slice, no actor write)
  'detect_silences', 'transcribe_clip', 'describe_clip',
  // direct-napi reads (served by an index.ts intercept, never by the router)
  'analyze_shots', 'analyze_shots_floor', 'shot_floor_report_cached',
  'shot_floor_sensitivity', 'shot_default_opts', 'reduce_shot_report', 'get_media_frame',
  'get_media_description',
  // slice-injected native reads (receive their state slice as a call argument)
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy',
  'generate_quick_proxy',
  'get_media_thumbnail', 'get_waveform_peaks',
  // backend stores (config-dir, not the project actor)
  'app_settings_get', 'app_settings_set', 'workspace_get', 'workspace_set_current',
  'workspace_set_active', 'workspace_save_baseline', 'workspace_create_profile',
  'workspace_rename_profile', 'workspace_delete_profile',
  'view_state_get', 'view_state_set', 'export_settings_get',
  'export_settings_set', 'workspace_dir', 'recents_list', 'recents_remove',
  'recents_get_reopen_on_launch', 'recents_set_reopen_on_launch', 'recents_most_recent',
  'recents_last_new_project_parent', 'keybindings_get', 'keybindings_set', 'keybindings_reset_all',
  'keybindings_export', 'keybindings_import', 'agent_session_get', 'log_list', 'log_clear',
  'log_emit', 'log_dir_path',
]

/** Curated set of channels allowed to route to {kind:'rust'}: read-only +
 *  config-store + pure-native — NONE touch the project actor for writes. The
 *  gate asserts no channel routes to rust outside this set. */
const RUST_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...PURE_NATIVE, ...PERSISTENCE, ...SLICE_INJECTED_READS, ...DIRECT_NAPI_READS,
])

describe('router partition gate', () => {
  it('every renderer channel is classified; no project-touching channel routes to rust', () => {
    for (const ch of ALL_CHANNELS) {
      const r = routeChannel(ch)
      // Every known channel must be classified — a 'reject' here means an
      // unclassified channel hit the default → out-of-sync manifest.
      expect(r.kind, `${ch} unclassified (reject default)`).not.toBe('reject')
      if (r.kind === 'rust') expect(RUST_ALLOWLIST.has(ch), `${ch} routes to rust`).toBe(true)
    }
    for (const ch of HYBRID_CHANNELS)
      expect(routeChannel(ch).kind, ch).toBe('hybrid')
    for (const ch of CLIP_COMPUTE_CHANNELS)
      expect(routeChannel(ch).kind, ch).toBe('clipCompute')
    for (const ch of MOTIF_CHANNELS)
      expect(routeChannel(ch).kind, ch).toBe('motif')
  })

  it('an unclassified channel routes to reject (single-writer backstop)', () => {
    expect(routeChannel('totally_unknown_channel').kind).toBe('reject')
  })

  it('the allowlist sets are disjoint from each other and from hybrids/blocked/production/special', () => {
    // SPECIAL: the switch-case channels (project_open, project_save, etc.) handled
    // by dedicated Route kinds. They must never appear in any named allowlist bucket —
    // if a future refactor accidentally adds one to e.g. PURE_NATIVE the disjointness
    // check here will catch it before the partition gate silently hides the duplicate.
    const SPECIAL: ReadonlySet<string> = new Set([
      'project_open', 'project_save', 'project_save_as', 'project_new_workspace',
      'project_summary', 'project_history_view', 'get_project_settings',
      'agent_session_end', 'agent_session_begin',
    ])
    const buckets: Array<[string, ReadonlySet<string>]> = [
      ['PURE_NATIVE', PURE_NATIVE], ['PERSISTENCE', PERSISTENCE],
      ['SLICE_INJECTED_READS', SLICE_INJECTED_READS],
      ['DIRECT_NAPI_READS', DIRECT_NAPI_READS],
      ['HYBRID_CHANNELS', HYBRID_CHANNELS],
      ['CLIP_COMPUTE_CHANNELS', CLIP_COMPUTE_CHANNELS],
      ['MOTIF_CHANNELS', MOTIF_CHANNELS],
      ['PRODUCTION_OPS', PRODUCTION_OPS as ReadonlySet<string>],
      ['SPECIAL', SPECIAL],
    ]
    for (let i = 0; i < buckets.length; i++)
      for (let j = i + 1; j < buckets.length; j++)
        for (const ch of buckets[i][1])
          expect(buckets[j][1].has(ch), `${ch} in both ${buckets[i][0]} and ${buckets[j][0]}`).toBe(false)
  })
})

describe('routeChannel', () => {
  it('routes every PRODUCTION_OPS channel to command', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).toBe('command')
  })
  it('routes reads + persistence + save to dedicated TS handlers', () => {
    expect(routeChannel('project_summary').kind).toBe('summary')
    expect(routeChannel('get_project_settings').kind).toBe('projectSettings')
    expect(routeChannel('project_open').kind).toBe('open')
    expect(routeChannel('project_save_as').kind).toBe('saveAs')
    expect(routeChannel('project_new_workspace').kind).toBe('newWorkspace')
    expect(routeChannel('project_save').kind).toBe('save')
    expect(routeChannel('agent_session_end').kind).toBe('agentSessionEnd')
    expect(routeChannel('agent_session_begin').kind).toBe('agentSessionBegin')
  })
  it('routes add_motif to command (pure TS mutation, blocked sets ∅)', () => {
    expect(routeChannel('add_motif').kind).toBe('command')
  })
  it('routes project_restore_checkpoint to command', () => {
    expect(routeChannel('project_restore_checkpoint').kind).toBe('command')
  })
  // The history panel's four channels: three actions ride the command route, but
  // the view is a READ and must never reach the command route — that is what
  // keeps it out of the undo stack and off the dirty flag.
  it('routes the three history-panel actions to command', () => {
    for (const ch of ['project_jump_to', 'project_create_checkpoint', 'project_delete_checkpoint'])
      expect(routeChannel(ch), ch).toEqual({ kind: 'command' })
  })
  it('routes project_history_view to its own read kind, not command', () => {
    expect(routeChannel('project_history_view')).toEqual({ kind: 'historyView' })
    expect(PRODUCTION_OPS.has('project_history_view')).toBe(false)
  })
  it('forwards independent stores + media/jobs/export to rust', () => {
    for (const ch of ['agent_session_get','log_list','ensure_full_proxy','generate_quick_proxy','export_video_sink_start','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
  })
  it('routes export_settings_get/set to the exportSettings TS handler (migrated off rust)', () => {
    expect(routeChannel('export_settings_get').kind).toBe('exportSettings')
    expect(routeChannel('export_settings_set').kind).toBe('exportSettings')
  })
  it('routes all 5 keybindings channels to the keybindings TS handler (migrated off rust)', () => {
    for (const ch of ['keybindings_get', 'keybindings_set', 'keybindings_reset_all', 'keybindings_export', 'keybindings_import'])
      expect(routeChannel(ch).kind, ch).toBe('keybindings')
  })
  it('routes app_settings_get/set to the appSettings TS handler (migrated off rust)', () => {
    expect(routeChannel('app_settings_get').kind).toBe('appSettings')
    expect(routeChannel('app_settings_set').kind).toBe('appSettings')
  })
  it('routes view_state_get/set to the viewState TS handler (migrated off rust)', () => {
    expect(routeChannel('view_state_get').kind).toBe('viewState')
    expect(routeChannel('view_state_set').kind).toBe('viewState')
  })
  it('routes every workspace channel to the workspace TS handler (app-level Dock arrangement + named profiles)', () => {
    for (const ch of [
      'workspace_get', 'workspace_set_current', 'workspace_set_active',
      'workspace_save_baseline', 'workspace_create_profile',
      'workspace_rename_profile', 'workspace_delete_profile',
    ])
      expect(routeChannel(ch).kind, ch).toBe('workspace')
  })
  it('routes all 6 recents channels to the recents TS handler (migrated off rust)', () => {
    for (const ch of ['recents_list', 'recents_remove', 'recents_get_reopen_on_launch', 'recents_set_reopen_on_launch', 'recents_most_recent', 'recents_last_new_project_parent'])
      expect(routeChannel(ch).kind, ch).toBe('recents')
  })
  it('routes import_media to hybrid', () => {
    expect(routeChannel('import_media').kind).toBe('hybrid')
  })
  // One canonical cut list, two verbs over it: both marker channels are hybrids
  // for the same reason — Rust scans and reduces, the actor commits — and
  // `drop_shot_markers` is `apply_shot_cuts` in 'mark' mode at the defaults.
  it('routes both shot-apply channels to hybrid', () => {
    expect(routeChannel('apply_shot_cuts').kind).toBe('hybrid')
    expect(routeChannel('drop_shot_markers').kind).toBe('hybrid')
  })
  // The shot-review reads reach a direct napi method rather than an `invoke`
  // arm, so index.ts intercepts them before the router is consulted. They are
  // classified anyway: the gate's value is a complete manifest, and a channel
  // nobody listed is a channel nobody checked.
  it('classifies every direct-napi read as read-only, never a mutation', () => {
    for (const ch of DIRECT_NAPI_READS) {
      expect(routeChannel(ch).kind, ch).toBe('rust')
      expect(PRODUCTION_OPS.has(ch), ch).toBe(false)
    }
  })
  // The write halves of the two speech recipes, reached by the renderer's
  // auto-caption and voiceover dialogs under the same names the agent uses —
  // one arm and one commit shape, whoever asks.
  it('routes the two speech write channels to hybrid', () => {
    expect(routeChannel('apply_subtitles').kind).toBe('hybrid')
    expect(routeChannel('synthesize_speech').kind).toBe('hybrid')
  })
  // Read/compute, never a write: these must not reach the command route (no
  // undo entry, no dirty flag) and must not reach bare rust either — the
  // stateless handler needs the actor-resolved slice index.ts injects.
  it('routes the three clip-compute channels to their own read kind', () => {
    for (const ch of ['detect_silences', 'transcribe_clip', 'describe_clip'])
      expect(routeChannel(ch), ch).toEqual({ kind: 'clipCompute' })
    for (const ch of ['detect_silences', 'transcribe_clip', 'describe_clip'])
      expect(PRODUCTION_OPS.has(ch), ch).toBe(false)
  })
  // `analyze_clip` shares the MCP slice-injection path but has no renderer
  // channel: the pool's shot surfaces read the whole-source report through
  // `analyze_shots` instead.
  it('leaves analyze_clip unclassified as a renderer channel', () => {
    expect(routeChannel('analyze_clip').kind).toBe('reject')
  })
  it('routes motif authoring/read/install/staleness channels to the motif route', () => {
    for (const ch of ['list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif', 'motif_staleness_report', 'acknowledge_motif_staleness'])
      expect(routeChannel(ch).kind, ch).toBe('motif')
  })
  it('never routes a category-A state mutation to rust', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).not.toBe('rust')
  })
})
