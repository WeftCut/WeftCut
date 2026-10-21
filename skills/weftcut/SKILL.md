---
name: weftcut
description: Drive the WeftCut video editor over its MCP tools. Use BEFORE calling any weftcut MCP tool, and whenever the weftcut MCP server is connected and the user wants a video or clip edited — cut, trim, tighten, remove pauses, add captions, titles, lower thirds or callouts, cut a social version — even if they do not name WeftCut; also to author or update a Motif (animated overlay).
---

# Driving WeftCut

WeftCut is a desktop video editor; you operate it over MCP while the user
watches the same project live in the app. Every mutation you commit lands in
their undo history and on their screen. Each tool's own description carries its
contract, and each refusal names its cause and options — this skill covers only
what no single tool can: how a session should go.

## In ten lines

The server sends these as its `initialize` instructions, so a client without
this skill reads the same etiquette; the long form follows.

WeftCut is a desktop video editor; the user watches the same project live, and every edit you commit lands in their undo history. A video the user asks you to edit is the project open in WeftCut, named or not.
1. Read `project://tracks` (or `read_project` with view "tracks") before your first edit. Ids come from reads, never from memory.
2. Every mutator answers with the committed record (minted ids, the span as it landed, `adjusted` for a grid snap); verify from it before reporting.
3. A refusal (isError) names the cause and the fix: act on it, never retry the call verbatim.
4. Times are microseconds on the frame grid: off-grid times are snapped and echoed, times outside their layer refused.
5. Call `create_checkpoint` before your first edit. For a batch (rough cut, pause pass, captions): ask the user, then `begin_agent_session`, `set_history_lock` around the batch, `dry_run` where supported, and `end_agent_session` when done, on failure too.
6. Others may edit concurrently; when a commit fails for that, re-read and reapply.
7. Export: `start_export`; poll `get_export_status` for the completed output_path.
8. Edit the project open in the app; never create one unless asked. With none open, project tools refuse: `open_project` or `create_project` the one the user named, else ask.
The weftcut skill (Settings > Agent) carries the long form, common flows and the Motif contract.

## Session etiquette

1. Read `project://tracks` before your first mutation — never write against a
   guessed state; `project://current` is the whole project when you need it.
   The project open in the app is the one the user means: edit it in place.
   Creating a new project and re-importing their media leaves them with a
   copy they did not ask for.
   If your client cannot read MCP resources, `read_project` returns the same
   views as a tool result.
2. Call `create_checkpoint` before your first edit, so the user has a one-step
   restore point.
3. A small change (a handful of tool calls) needs no more ceremony than that:
   edit, verify, report.
4. A batch job (rough-cutting a video, a pause pass, building a caption
   track) uses a work session: ASK whether to begin the batch and enter the
   lightweight agent view unless already authorized, then call
   `begin_agent_session`. It creates a checkpoint once per session. Wrap the
   batch in `set_history_lock`, both ways, rehearse with `dry_run` where
   supported, and call `end_agent_session` when finished (also on failure).
   Use a finally-style cleanup so a failed tool does not leave undo locked.
   Manual view switching neither starts nor ends work. The user can end work
   or unlock locally; closing your connection ends its owned session, and the
   app closes a session whose connection has gone quiet. If `begin_agent_session`
   answers `AgentSessionBusy`, the message names the holder — wait, or take over
   with `end_agent_session { force: true }` when that holder is gone.
   None of these cancels running calls or prohibits later tools. Do not infer
   that a session ended because the user returned to the editor.
5. Errors are instructions: WeftCut errors name the cause and list concrete
   options. Pick one; never retry a rejected call verbatim.
6. A commit can also fail because the user (or another agent) edited
   concurrently — re-read the resource and reapply.
7. Export with `get_export_options`, then `start_export`. Generate one unique
   `request_id` per export intent and reuse it after a reconnect. Poll
   `get_export_status` until completion, failure or `awaiting_retry`; a transport
   disconnect does not cancel the job. Report the completed `output_path` and
   `filename`. An omitted path uses the project's output folder; conflicts
   add a number by default. Use `on_conflict: "fail"` for a strict name.
   Settings use snake_case and override only this job. Editing stays locked
   while exporting or awaiting retry. Use `retry_export` to retry finalization,
   optionally with a new same-directory filename, or `cancel_export` to
   discard. UI and MCP can control each other's jobs. Native encoder failure
   returns an error; choose changed settings for a new request rather than
   waiting for an interactive fallback prompt.

Export presets are shared with the export dialog. Use `list_export_presets`
for IDs and portable settings; `create_export_preset`, `update_export_preset`,
`rename_export_preset`, `delete_export_preset` and `set_default_export_preset`
manage the application library even without a project. Built-ins are read-only,
personal names have a 40-character limit. Pass `preset_id` to `get_export_options`
to preview or `start_export` to use one; per-job settings override it. Omitting
the ID keeps saved project settings, falling back to the global default.
Library edits do not rewrite project settings or jobs already admitted.

## Batch jobs

Before a batch job, look in `recipes/` beside this file for a recipe whose
description matches the job, and follow it. Read the files in `craft/` that
touch the job: production rules as numbers, and anti-patterns, that hold under
every style. Depart from one only when the user explicitly asks, and say so in
your report.

Without a recipe, a batch job runs the same loop: read the state (tracks, open
tacks, `project://taste`) → plan in plain words and get the user's go-ahead →
build inside the work session → check the result against the plan and with
`check_composition` → hand off. Build and check repeat at most three rounds.
Whatever is still wrong after the third becomes tacks on the ranges it
concerns and is named in your report — never retried silently.

**Style.** The project's style is `project://taste`: its tokens are already
the defaults new text and transcript captions take. Tag what you create with a
`graphic_role` — title, lower_third, callout, credit, logo, plate — rather than
styling it by hand; the role is what gives it the style's look and its
entrance. A role outside those must be declared in the project's TASTE.md.
After hand edits, `restyle_to_taste` puts layers back to the style.

**Checks.** `check_composition` reports what breaks the craft rules
(`craft/rules.md`) or departs from the style. Fix every `hard` finding. Fix a
`warning`, or leave a tack on it that says why it stays. A `review` finding is
a departure from the style: keep it only if it was meant, and say so.
`end_agent_session` tells you whether your last check still matches the
timeline.

## Working rhythm

Read → analyze → mutate → **verify**: every mutator answers with the committed
record — the ids it minted, the span as it landed, `adjusted` for any grid snap,
the link `siblings` it carried along — so check that answer first, and re-read
`project://tracks` or `project://current` only for what the record does not
carry, before reporting the edit done.

Common flows, one line each — parameters and caveats live in the tool
descriptions:

- Animation: `set_keyframe` creates or updates one key by time; `set_param_track`
  replaces a whole track with keys needing only time and value. Key and path-node
  IDs are generated by WeftCut — never invent them or send them in bulk authoring
  inputs. To edit/delete one existing key, read its ID with `get_param_track`.
  When copying read records into a bulk replacement, omit IDs and read-only
  `t_local_us` and `preset_id`; preserve `time_fraction` when present, along with
  the desired values and curves. `set_position`
  also generates IDs and returns the committed position. Its key times are
  layer-local; other keyframe tools use timeline time.
- Cut pauses: `remove_pauses` cuts every pause out of a clip and closes the
  gaps, as one undoable edit — `pad_us` of each pause stays at both ends, so
  the speech either side keeps its breath (or let the user review them first:
  `detect_pauses` → one `create_tacks` batch, a region tack per pause; both
  packaged as the `/cut-pauses` prompt).
- Make room, or move the tail: `shift_layers` shifts every layer from a time
  (or a named set, link partners included) by one delta as one undoable edit —
  a positive delta from a time is the ripple insert; then place into the gap.
- Captions: `transcribe_clip` → inspect the returned `segments` → `apply_transcripts`,
  passing the envelope's `segments` and `word_timing` through (also
  `/auto-caption`). A subtitle FILE the user already has: `import_media` it,
  then `apply_subtitles { media_id, t_start_us? }` — the whole document, its
  time 0 at `t_start_us`. Correcting names and jargon: put the script or
  notes in `set_project_settings { correction_script }`, then
  `correct_caption_text`. Restyle every caption at once with `restyle_captions`.
- Retime: `retime_layers` sets an absolute rational rate or target duration,
  preserving the selected source window. Pass every intended clip explicitly:
  links do not expand the selection. `set_preserve_pitch` sets the Audio/Group
  pitch policy. The ordinary duration/trim tools trim instead of changing rate.
- Captions with your own speech model: `extract_clip_audio` returns a 16 kHz
  mono source WAV block plus the window and `playback_rate` (at most 60 s of
  source audio per call; use timeline windows no longer than
  `60000000 / playback_rate` microseconds). Map each WAV offset with
  `t_start_us + offset / playback_rate`, then `apply_transcripts` with `word_timing:
  "exact"` (or `"none"` and empty `words` if your model gives cue times only).
- Voiceover: `synthesize_speech` appends a spoken script to the timeline
  (also `/voiceover`).
- Rough cut: `analyze_clip` or `auto_split_by_shot`, then trim and delete
  segments — `delete_layers` with `ripple: true` when the gap a cut leaves
  should close behind it.
- Music, sound effects, a separate voice track: `add_audio_layer`. It is the
  only tool that places audio-only media — `add_video_layer` builds a visual
  layer and refuses an audio file.
- Music alignment: `analyze_audio { media_id, start_us?, end_us? }` reads source
  waveform energy, onset candidates and energy changes, at most 60 s per call.
  Times are source-absolute, including outside existing trims. To align a
  `source_us` candidate to timeline T on a rate-1 clip without fractional source
  endpoints, set `src_in_us = source_us - (T - layer.t_start_us)` and keep the
  clip duration when setting `src_out_us` via `update_layer_params`. For retimed
  clips, use the returned rational time_map and source_phase for the mapping;
  do not apply that rate-1 formula. Check source bounds and audition: amplitude onsets do
  not identify beats or main melodies. Missing waveform: wait for generation.
- A title, a lower third, a credit: `add_text_layer` with its `graphic_role`;
  it is born in the project's style, entrance and exit included. Adjust it
  with `update_layer_params` (`intro`/`outro` set the motion). Subtitles from
  a document are `apply_subtitles`.
- A track that refuses every edit is locked: `set_track_flags` clears the lock
  (and hides or shows a track's output). A layer carries its own lock, which
  `update_layer` clears.
- Going back further than one undo: read `project://history` and `jump_to` a row
  by its absolute index — the way back to a state that is neither one undo away
  nor a checkpoint.

## Pointing the user at something

Tacks are how you point the user at something to review — a pause to check, a
shot to judge, a cut to decide. Create them once the session's edits are done:
`create_tacks` places a whole batch in one call. A tack comments on what
plays in its range, on every track: it moves with that content when it moves
together, and turns outdated as soon as anything in the range plays
differently — a clip trimmed, deleted, added or changed there, by you or the
user. Describe the content in label and body,
never a timecode — the panel shows each tack's live place. One place, one tack: several things to say
about the same shot go in one tack's body, not one tack each. Tacks live in the agent panel for this project
opening only — never in the project, its history or an export — so leaving
them costs the user nothing.

Markers are the user's content: saved, undoable, exported. Create one with
`add_marker` only when the user asks for markers — never as a review mark.

A tack's status tells you what the user decided: resolved (they acted on it) or
dismissed (it does not matter), while open is still waiting. Read
`project://tacks` before acting on your earlier tacks, and use `update_tack` to
resolve one you fixed yourself. When an edit's result lists one of yours in
`affected_tacks` as outdated, or `end_agent_session` returns it in
`tacks_to_review`, it no longer describes what plays there: resolve it if your
edit settled it, otherwise delete it and tack the new content again.

## Motifs (animated overlays)

Read `motif-authoring.md` and `motif-workspaces.md` next to this file before
creating or changing a Motif. Visible state must be a function of absolute time.
One Motif draws one element: for overlay work with more than one element, plan
the layers before writing code (*Scope: one element* in `motif-authoring.md`).

1. Prefer a self-contained folder inside your working directory (for example
   motifs/<name>/) with index.html, manifest.json and companion code/assets,
   never beside it. Call `open_motif_draft` with a directory source once;
   keep editing the folder with your normal file tools. The app watches changes.
   Opening the same directory reuses its draft. Use an existing Motif or ZIP
   source to copy a package; copying does not select an update target. Unsure
   whether the app can read your folder? Try it: one `open_motif_draft` with the
   folder's absolute path answers the question. Fall back to step 2 only when the
   app refuses the path.
2. When the app cannot read your folder, start an empty draft or import an
   uploaded ZIP. Use `read_motif` for inventory or file content, then
   `update_motif_files` for a batch of file writes, uploaded file references
   or deletions. To change part of a file, send `edits` (exact `old` → `new`
   pairs) instead of the whole file. Always pass the revision you read. Upload binary bytes with
   `begin_file_upload` and `write_file_chunk`; `read_file_transfer` downloads
   content or reports upload progress. `delete_file_transfer` releases temporary
   files after use. Uploads are not model-specific.
3. Use `preview_motif` at start, middle and near the end, plus non-default props.
   Check its returned revision and any diagnostics. Fix invalid sources before
   publishing; do not treat the last valid frame as the current source.
4. **The user approves publication.** Place the draft with `add_motif_layer`
   when useful and ask the user to review it. After confirmation, call
   `install_motif` with the reviewed revision. To overwrite another publication,
   explicitly supply its target id and current version. The draft remains
   editable; publishing the same revision again does not increment the version.
   Remove trial layers afterwards unless the user wants them kept.
5. `export_motif` produces a complete ZIP (downloadable or saved to a local
   path). `delete_motif` removes a draft/publication; unlinking a directory
   never deletes the author's source folder.

**Three.js Motifs** use local dependencies and relative URLs; no CDN access.
Read `motif-three-model.md` and start from `templates/three-model.zip` beside
this file for Draco/KTX2. Await decoding in setup; local/Blob Workers and WASM
are available there, ordinary JS eval is not. Create fresh decoder loaders per
setup, derive animation from absolute time and keep `settle_rafs: 2`.
