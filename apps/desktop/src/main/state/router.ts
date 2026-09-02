// apps/desktop/src/main/state/router.ts
// Pure splitter: the TS actor is authoritative; this splits every renderer channel.
// SAFETY INVARIANT (router.test.ts partition gate): every renderer channel is
// classified into exactly one bucket, and no project-touching channel routes to
// 'rust' (the curated PURE_NATIVE ∪ PERSISTENCE ∪ SLICE_INJECTED_READS ∪
// DIRECT_NAPI_READS allowlist is read-only / config-store / pure-native). An
// unclassified channel routes to {kind:'reject'} so the gate fails loud.
import { PRODUCTION_OPS } from './commands'

export type Route =
  | { kind: 'command' }       // actor.command(channel, args)
  | { kind: 'summary' }       // buildProjectSummary
  | { kind: 'historyView' }   // actor.historyView(cap) — the whole edit stack, READ-only
  | { kind: 'projectSettings' } // actor.snapshot().settings
  | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' }
  | { kind: 'agentSessionEnd' } // agentSessionEnd seam: endSlot + unlockHistory
  | { kind: 'agentSessionBegin' } // UI-initiated session: checkpoint + beginSlot (mirrors the MCP tool path)
  | { kind: 'appSettings' }   // app-level prefs store, owned in TS main (config-dir)
  | { kind: 'workspace' }     // app-level Dock arrangement document, owned in TS main (config-dir)
  | { kind: 'viewState' }     // per-workspace view.json store, owned in TS main
  | { kind: 'exportSettings' } // per-workspace export.json store, owned in TS main
  | { kind: 'keybindings' }   // per-user keybinding overrides, owned in TS main (config-dir)
  | { kind: 'recents' }       // recent-projects list + prefs, owned in TS main (config-dir)
  | { kind: 'hybrid'; tool: string } // native-compute → TS-write
  | { kind: 'clipCompute' }   // native clip read/compute over an actor-resolved slice
  | { kind: 'motif'; tool: string }  // TS Motif authoring/read/install
  | { kind: 'reject'; reason: string }
  | { kind: 'rust' }

/** Hybrid Rust-compute → TS-write channels. install_motif and
 *  acknowledge_motif_staleness ride the motif route instead.
 *
 *  `drop_shot_markers` and `apply_shot_cuts` are hybrids by definition — Rust
 *  scans and reduces the shot report, the TS actor writes the splits or the
 *  markers — which is why they route here and not through an index.ts intercept
 *  like the read-only shot channels. The first is the second at the detection
 *  defaults in 'mark' mode; both are renderer-only, with no MCP tool.
 *
 *  `apply_subtitles` and `synthesize_speech` are the write halves of the two
 *  authored speech recipes, and the renderer's auto-caption and voiceover
 *  dialogs reach them by the same names. Classified here rather than as an
 *  index.ts intercept because they ARE hybrids — Rust renders or synthesizes,
 *  the actor commits — and an unclassified channel is rejected by design.
 *  Either caller lands the same single commit; the MCP path differs only in
 *  wrapping the string result as a `ToolResult` text block (server.ts). */
export const HYBRID_CHANNELS: ReadonlySet<string> = new Set([
  'import_media', 'drop_shot_markers', 'apply_shot_cuts', 'apply_subtitles', 'synthesize_speech',
])

/** Read-only channels whose Rust entry point is a direct napi method (or the
 *  MCP resource path), not an `invoke` arm — so `index.ts` serves each from its
 *  own intercept and the router is never consulted for them. They are
 *  classified anyway, because the partition gate's value is a COMPLETE manifest:
 *  a channel absent from it is a channel nobody checked. Routing to `rust`
 *  records the property that matters — no actor write — and the fallthrough
 *  refuses the channel by name rather than reaching project state.
 *
 *  `shot_floor_report_cached` is a disk probe that Rust guarantees never starts
 *  a scan, which is what lets the review surface ask it on every selection
 *  change. `shot_floor_sensitivity` and `shot_default_opts` are constant reads
 *  off the addon, exposed so the review surface's threshold comes from the scan
 *  that produced the candidates rather than from a renderer literal. */
export const DIRECT_NAPI_READS: ReadonlySet<string> = new Set([
  'analyze_shots', 'analyze_shots_floor', 'shot_floor_report_cached',
  'shot_floor_sensitivity', 'shot_default_opts', 'reduce_shot_report', 'get_media_frame',
])

/** Native clip read/compute channels: no actor write, but the stateless Rust
 *  handler needs the layer + its MediaItem injected, which only the actor can
 *  resolve. Served in index.ts by `callClipComputeTool` — the SAME function the
 *  MCP tool of the same name goes through, injection included, so the human and
 *  the agent path cannot pick different engines or different slices.
 *
 *  A strict subset of `clip-slice-forward.ts`'s `CLIP_SLICE_TOOLS`: `analyze_clip`
 *  stays agent-only, because the renderer's shot surfaces read the whole-source
 *  report through `analyze_shots` instead. */
export const CLIP_COMPUTE_CHANNELS: ReadonlySet<string> = new Set([
  'detect_silences', 'transcribe_clip', 'describe_clip',
])

/** Motif catalog-read + authoring + install + staleness channels, served in TS
 *  by runMotifTool. */
export const MOTIF_CHANNELS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft',
  'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif',
  'motif_staleness_report', 'acknowledge_motif_staleness',
])

/** Native read/compute handlers that receive their project state slice (a MediaItem
 *  or the full Project) as an injected call argument — the TS host forwards it
 *  before the rust dispatch. Safe on rust: they hold no resident state. */
export const SLICE_INJECTED_READS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy', 'generate_quick_proxy',
  'get_media_thumbnail', 'get_waveform_peaks',
])

/** Native compute with NO project actor access. */
export const PURE_NATIVE: ReadonlySet<string> = new Set([
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish', 'export_video_sink_cancel',
  'import_cancel', 'import_queue_list', 'report_audio_meter', 'settings_get_api_key_status', 'settings_test_provider',
])

/** Backend stores (config-dir), not the project actor. */
export const PERSISTENCE: ReadonlySet<string> = new Set([
  'workspace_dir', 'agent_session_get', 'log_list', 'log_clear', 'log_emit', 'log_dir_path',
])

export function routeChannel(channel: string): Route {
  if (PRODUCTION_OPS.has(channel)) return { kind: 'command' }
  if (HYBRID_CHANNELS.has(channel)) return { kind: 'hybrid', tool: channel }
  if (CLIP_COMPUTE_CHANNELS.has(channel)) return { kind: 'clipCompute' }
  if (MOTIF_CHANNELS.has(channel)) return { kind: 'motif', tool: channel }
  switch (channel) {
    case 'project_summary': return { kind: 'summary' }
    // A READ, not a command: it must never enter the undo stack or dirty the
    // project. Its own kind rather than a fold into `summary` because the panel
    // pulls the full stack on its own cadence, while the summary refetch runs on
    // every edit whether the panel is open or not (spec decision 5).
    case 'project_history_view': return { kind: 'historyView' }
    case 'get_project_settings': return { kind: 'projectSettings' }
    case 'project_open': return { kind: 'open' }
    case 'project_save_as': return { kind: 'saveAs' }
    case 'project_new_workspace': return { kind: 'newWorkspace' }
    case 'project_save': return { kind: 'save' }
    case 'agent_session_end': return { kind: 'agentSessionEnd' }
    case 'agent_session_begin': return { kind: 'agentSessionBegin' }
    case 'app_settings_get':
    case 'app_settings_set': return { kind: 'appSettings' }
    case 'workspace_get':
    case 'workspace_set_current':
    case 'workspace_set_active':
    case 'workspace_save_baseline':
    case 'workspace_create_profile':
    case 'workspace_rename_profile':
    case 'workspace_delete_profile': return { kind: 'workspace' }
    case 'view_state_get':
    case 'view_state_set': return { kind: 'viewState' }
    case 'export_settings_get':
    case 'export_settings_set': return { kind: 'exportSettings' }
    case 'keybindings_get':
    case 'keybindings_set':
    case 'keybindings_reset_all':
    case 'keybindings_export':
    case 'keybindings_import': return { kind: 'keybindings' }
    case 'recents_list':
    case 'recents_remove':
    case 'recents_get_reopen_on_launch':
    case 'recents_set_reopen_on_launch':
    case 'recents_most_recent':
    case 'recents_last_new_project_parent': return { kind: 'recents' }
  }
  if (PURE_NATIVE.has(channel) || PERSISTENCE.has(channel) || SLICE_INJECTED_READS.has(channel) || DIRECT_NAPI_READS.has(channel))
    return { kind: 'rust' }
  return { kind: 'reject', reason: 'unclassified channel — classify in router.ts' }
}
