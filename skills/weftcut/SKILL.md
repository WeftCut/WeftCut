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
this skill reads the same etiquette; the long form follows. Its last line names
the server's version: if it differs from this skill's `metadata.version`, this
copy is stale, so replace it with the app's (Settings > Agent).

WeftCut is a desktop video editor; the user watches the same project live, and every edit you commit lands in their undo history. A video the user asks you to edit is the project open in WeftCut, named or not.
1. Read `project://tracks` (or `read_project` view "tracks") before your first edit; ids come from reads, never memory.
2. Every mutator answers with the committed record (minted ids, the span as it landed, `adjusted` for a grid snap); verify from it before reporting.
3. A refusal (isError) names the cause and the fix: act on it, never retry the call verbatim.
4. Times are microseconds on the frame grid: off-grid times are snapped and echoed, times outside their layer refused.
5. For a batch (rough cut, pause pass, captions): ask the user, then `begin_agent_session` (it checkpoints and locks the user's undo; `lock: false` opts out) and `end_agent_session` when done, on failure too.
6. Others may edit concurrently; when a commit fails for that, re-read and reapply.
7. Export: `start_export`; `get_export_status { wait_s }` for the completed output_path.
8. Edit the project open in the app; never create one unless asked. With none open, `open_project` or `create_project` the one the user named, else ask. A folder with project.json is a project; if it is not the open one (`project.dir` in `project://session`), ask. Its files change only through tools, TASTE.md aside.

## Session etiquette

1. Read `project://tracks` before your first mutation — never write against a
   guessed state. Its envelopes say what each layer is (media, text, role,
   Motif, Group); `project://layers/{id}` has one layer in full.
   The project open in the app is the one the user means: edit it in place.
   Creating a new project and re-importing their media leaves them with a
   copy they did not ask for.
   If your client cannot read MCP resources, `read_project` returns the same
   views as a tool result.
2. A small change (a handful of tool calls) needs no ceremony: edit, verify,
   report.
3. A batch job (rough-cutting a video, a pause pass, building a caption
   track) uses a work session: ASK whether to begin the batch and enter the
   lightweight agent view unless already authorized, then call
   `begin_agent_session`. It creates a checkpoint once per session and locks
   the user's undo until `end_agent_session`, which you call when finished
   (also on failure); `lock: false` leaves undo free.
   Manual view switching neither starts nor ends work. The user can end work
   or unlock locally; closing your connection ends its owned session, and the
   app closes a session whose connection has gone quiet. If `begin_agent_session`
   answers `AgentSessionBusy`, the message names the holder — wait, or take over
   with `begin_agent_session { force: true }` when that holder is gone.
   None of these cancels running calls or prohibits later tools. Do not infer
   that a session ended because the user returned to the editor.
4. Errors are instructions: WeftCut errors name the cause and list concrete
   options. Pick one; never retry a rejected call verbatim.
5. A commit can also fail because the user (or another agent) edited
   concurrently — re-read the resource and reapply.
6. Export with `get_export_options`, then `start_export`. Generate one unique
   `request_id` per export intent and reuse it after a reconnect. Call
   `get_export_status { wait_s: 60 }` until completion, failure or `awaiting_retry`; a transport
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
for IDs and portable settings; `create_export_preset`, `update_export_preset`
and `delete_export_preset` manage the application library even without a
project. Pass `preset_id` to `get_export_options` to preview or `start_export`
to use one; per-job settings override it. Omitting the ID keeps saved project
settings, falling back to the global default. Library edits do not rewrite
project settings or jobs already admitted.

## Working in the project folder

When your working directory is a project folder (it holds `project.json`),
it is the project the user means. Compare it with `project.dir` in
`project://session`; if the app has another project open, ask before
`open_project`.

- `project.json` is the app's to write; it autosaves over any edit of yours.
  Read the project through its resources (`project://tracks`,
  `project://layers/{id}`, …) or `read_project`.
- `Media/` holds the project's media. Never rename, move or overwrite a file
  there: the pool records it by that path and by its bytes, and a file changed
  there goes unavailable. New media goes under a new name, through
  `import_media`. `Cache/` is derived data; leave it unread.
- `TASTE.md` is the one file you edit by hand. `project://taste` names where
  it goes even before it exists. Its tokens reach new layers; call
  `restyle_to_taste` for the layers already placed.
- A file the user mentions goes to `import_media` as it is: absolute, or
  relative to the project folder. A file the pool already holds answers its
  existing record (`existing: true`), so importing is also how a file is
  matched to its media id. A file from anywhere else is copied into `Media/`.
- Each pooled file is also a resource, `media://{id}`: a short card with its
  path, length and the layers using it (`read_project` view `media` with
  `id` reads the same).

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
`graphic_role` — title, lower_third, callout, credit, logo, plate, illustration — rather than
styling it by hand; the role is what gives it the style's look and its
entrance. A role outside those must be declared in the project's TASTE.md.
After hand edits, `restyle_to_taste` puts layers back to the style.

**Style Motifs.** A style that is mostly drawn (paper, stamps, highlighter)
lists example Motifs per role in the taste's motifs. They are examples, not a
template: place one, fork it, or write a new Motif when the video needs
something they do not show. The style reaches any Motif through its shared
props (colours such as ink and accent, and font_ props). Leave them unset
when placing, and keep them in a fork. A Motif that has a duration_s prop
plays its exit before its layer ends: set duration_s to the layer's length,
and its exit prop. A set of elements leaves by ending their layers one after
another. *Style Motifs* in `motif-authoring.md` says how to write one.

**Checks.** `check_composition` reports what breaks the craft rules
(`craft/rules.md`) or departs from the style. Fix every `hard` finding. Fix a
`warning`, or leave a tack on it that says why it stays. A `review` finding is
a departure from the style: keep it only if it was meant, and say so.
`end_agent_session` runs the check itself when your last one no longer
matches the timeline. If that finds `hard` or `warning` findings, it keeps
the session open and returns them: settle them as above, then call it again.
The audit cannot see pixels: after placing overlays, look at what export
will render with `render_frames`. Pass the layer ids, and each one is sampled
over its span, including just after cuts and shot changes under it.

## Working rhythm

Read → analyze → mutate → **verify**: every mutator answers with the committed
record — the ids it minted, the span as it landed, `adjusted` for any grid snap,
the link `siblings` it carried along — so check that answer first, and re-read
`project://tracks` or `project://layers/{id}` only for what the record does
not carry, before reporting the edit done.

Common flows, one line each — parameters and caveats live in the tool
descriptions. A time's name says its clock: `t_*` timeline, `src_*` source,
`local_*` layer-local; a source-time answer carries the `mapping` that places
it.

- Animation: `set_keyframe` one key by time, `set_param_track` a whole track;
  `get_param_track` reads the track in that write shape, so edit and send it back.
- Cut pauses: `remove_pauses` cuts the pauses out of a clip and closes the
  gaps, as one undoable edit, keeping `pad_us` at both ends (or review first:
  `detect_pauses` → one `create_tacks` batch, then `remove_pauses { pauses }`
  with the kept ones; both in the `/cut-pauses` prompt).
- Reorder: `move_layers`; `insert: true` moves a part and closes the gap
  behind it. Make room or close a gap: `shift_layers` from a time.
- Captions, after any pause cut: `transcribe_clip` → inspect the `segments` →
  `apply_transcripts` with its answer's transcripts as they came (also
  `/auto-caption`). Cues come out within the style's caption limits; do not
  break lines or split cues by hand. A subtitle FILE: `import_media` it, then
  `apply_subtitles`. Correcting names and jargon:
  `correct_caption_text { script }` with the full verbatim transcript.
  Caption look: edit the caption tokens, then `restyle_to_taste`.
- Retime: `retime_layers`, with the link partners too.
- Captions with your own speech model: `extract_clip_audio` returns a 16 kHz
  mono source WAV block (at most 60 s of source per call) and the window's
  mapping; place each WAV offset by it, then `apply_transcripts` with `word_timing:
  "exact"` (or `"none"` and empty `words` if your model gives cue times only).
- Voiceover: `synthesize_speech` appends a spoken script to the timeline
  (also `/voiceover`).
- Rough cut: `analyze_clip` or `auto_split_by_shot`, then trim and delete
  segments — `delete_layers` with `ripple: true` when the gap a cut leaves
  should close behind it.
- Placing clips, titles, music, stills: one `add_layers` call for the whole
  batch.
- Music alignment: `analyze_audio` onsets, then slip the clip with
  `update_layer_params { src_in_us }`. Onsets are not beats: audition.
- A title, a lower third, a credit: a text layer with its `graphic_role`.
  Adjust it with `update_layer_params`. Subtitles from a document are
  `apply_subtitles`.
- A track that refuses every edit is locked: `set_track_flags` clears the lock
  (and hides or shows a track's output). A layer carries its own lock, which
  `set_layer_flags` clears.
- Going back further than one undo: `jump_to { op_id }`, an op of `project://history`.

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
One Motif draws one element, or one interaction of elements that move because
of each other. For overlay work with more than one element, plan the layers
before writing code. A concept scene is a Group of a plate, one layer per
independent element, and at most a few interaction Motifs (*Scope* in
`motif-authoring.md`). A Motif shows a still from the media pool through a
`media` prop (`"<media_id>"`, or `"<media_id>@<t_us>"` for a video frame);
moving footage stays a video layer.

1. Prefer a self-contained folder inside your working directory (for example
   motifs/<name>/) with index.html, manifest.json and companion code/assets,
   never beside it. Call `open_motif_draft` with a directory source once;
   keep editing the folder with your normal file tools. The app watches changes.
   Unsure whether the app can read your folder? One `open_motif_draft` with its
   absolute path answers that. Fall back to step 2 only when the app refuses it.
2. When the app cannot read your folder, start an empty draft. Use `read_motif`
   for inventory or file text, then `update_motif_files` for a batch of file
   writes or deletions. To change part of a file, send `edits` (exact `old` →
   `new` pairs) instead of the whole file. Always pass the revision you read.
3. `preview_motif` the start, middle and near the end in one call, then once
   more with non-default props. Fix invalid sources before publishing.
4. **Publication waits for the user's approval in the app.** Place the draft
   with `add_layers` when useful, then `install_motif` the reviewed revision:
   it only proposes. Tell the user to approve it in WeftCut's Motifs panel and
   stop; do not poll and do not report it published. `list_motifs` shows the
   outcome and any note. Remove trial layers afterwards unless the user wants
   them kept.
5. `export_motif` saves a complete ZIP to a local path. `delete_motif` removes a
   draft/publication; it never deletes a linked source folder.

**Three.js Motifs** use local dependencies and relative URLs; no CDN access.
Read `motif-three-model.md` and start from `templates/three-model.zip` beside
this file for Draco/KTX2. Await decoding in setup; local/Blob Workers and WASM
are available there, ordinary JS eval is not. Create fresh decoder loaders per
setup, derive animation from absolute time and keep `settle_rafs: 2`.
