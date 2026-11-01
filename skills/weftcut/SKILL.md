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

The ten lines above are the etiquette; this is what they leave out.

- The project open in the app is the one the user means: edit it in place.
  A new project with their media re-imported is a copy they did not ask for.
  `project://tracks` says what each layer is (media, text, role, Motif,
  Group); without resource support, `read_project` serves the same views.
- A small change (a handful of calls) needs no ceremony: edit, verify, report.
- A batch job (a rough cut, a pause pass, a caption track) runs in a work
  session. Ask before you begin one unless the user already agreed; it moves
  them to the agent view and locks their undo until you end it, so end it on
  failure too. Switching views neither starts nor ends work, and a user back in
  the editor has not ended your session. If another agent holds the session,
  ask the user before taking it over.
- Export when the user asks for a file, and report the completed output's path.
  A dropped connection does not cancel an export; its status answers again.

## Working in the project folder

When your working directory is a project folder (it holds `project.json`),
it is the project the user means. Compare it with `project.dir` in
`project://session`; if the app has another project open, ask before
`open_project`.

- `project.json` is the app's to write; it autosaves over any edit of yours.
  Read the project through its resources or `read_project`.
- `Media/` holds the project's media. Never rename, move or overwrite a file
  there: the pool would lose it. New media goes in under a new name, through
  `import_media`. `Cache/` is derived data; leave it unread.
- `TASTE.md` is the one file you edit by hand (`project://taste` names where
  it goes). Its tokens reach new layers; `restyle_to_taste` brings placed ones
  back to it.
- A file the user mentions goes to `import_media` as it is. Importing a file
  the pool already holds answers its existing record, so it is also how a file
  is matched to its media id.

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

**Style.** The project's style is `project://taste`; its tokens are already
the defaults new text and captions take. Tag what you create with a
`graphic_role` rather than styling it by hand: the role gives it the style's
look and entrance. A role outside the built-ins must be declared in TASTE.md.

**Style Motifs.** A style that is mostly drawn lists example Motifs per role.
They are examples, not a template: place one, fork it, or write a new Motif
when the video needs something they do not show. Leave the style's shared
props unset when placing, and keep them in a fork. *Style Motifs* in
`motif-authoring.md` says how to write one.

**Checks.** Fix every `hard` finding of `check_composition`. Fix a `warning`,
or leave a tack on it that says why it stays. Keep a `review` finding only if
the departure was meant, and say so. When `end_agent_session` hands findings
back, settle them the same way and end again. The audit cannot see pixels:
after placing overlays, look at the layers you placed with `render_frames`.

## Working rhythm

Read → analyze → mutate → **verify** from the committed record each edit
answers; re-read only for what the record does not carry, before reporting the
edit done. A time's name says its clock: `t_*` timeline, `src_*` source,
`local_*` layer-local.

Which tool for a job — the descriptions carry the rest:

- Animation: `set_keyframe` for one key, `set_param_track` for a whole track,
  read back with `get_param_track`.
- Cut pauses: `remove_pauses`, or review first with `detect_pauses` and one
  `create_tacks` batch (the `/cut-pauses` prompt).
- Reorder: `move_layers`; make room or close a gap: `shift_layers`.
- Captions, after any pause cut: `transcribe_clip` → read the `segments` →
  `apply_transcripts` (the `/auto-caption` prompt). Leave line breaks and cue
  lengths to the style. A subtitle file: `import_media`, then
  `apply_subtitles`. Names and jargon: `correct_caption_text`. Caption look:
  the caption tokens, then `restyle_to_taste`.
- Your own speech model: `extract_clip_audio`, then `apply_transcripts`.
- Voiceover: `synthesize_speech` (the `/voiceover` prompt).
- Rough cut: `analyze_clip` or `auto_split_by_shot`, then trim and
  `delete_layers` with `ripple: true` where the gap should close.
- Placing clips, titles, music, stills: one `add_layers` call for the batch.
- Music alignment: `analyze_audio` onsets, then slip the clip. Onsets are not
  beats: audition.
- A title, a lower third, a credit: a text layer with its `graphic_role`.

## Pointing the user at something

Tacks point the user at something to review — a pause to check, a shot to
judge, a cut to decide. Create them once the session's edits are done, in one
`create_tacks` batch. Describe the content, never a timecode. One place, one
tack: several things to say about the same shot go in one body. Tacks live in
the agent panel for this opening only, so leaving them costs the user nothing.

Markers are the user's content: saved, undoable, exported. Use `add_marker`
only when the user asks for markers — never as a review mark.

A tack's status is the user's answer: resolved (they acted), dismissed (it
does not matter), open (still waiting). Read `project://tacks` before acting
on your earlier tacks; `update_tack` resolves one you fixed yourself. A tack of
yours that an edit's `affected_tacks` or `end_agent_session`'s
`tacks_to_review` reports outdated no longer describes what plays there:
resolve it if your edit settled it, else delete it and tack the new content.

## Motifs (animated overlays)

Read `motif-authoring.md` and `motif-workspaces.md` next to this file before
creating or changing a Motif. Visible state must be a function of absolute time.
One Motif draws one element, or one interaction of elements that move because
of each other. For overlay work with more than one element, plan the layers
before writing code. A concept scene is a Group of a plate, one layer per
independent element, and at most a few interaction Motifs (*Scope* in
`motif-authoring.md`). A still from the media pool goes in through a `media`
prop; moving footage stays a video layer.

1. Prefer a self-contained folder inside your working directory (for example
   motifs/<name>/) and one `open_motif_draft` with its absolute path; keep
   editing the folder with your normal file tools. Only when the app refuses
   it, work through `read_motif` and `update_motif_files`
   (`motif-workspaces.md`, *Without a shared folder*).
2. `preview_motif` the start, middle and near the end in one call, then once
   more with non-default props. Fix invalid sources before proposing.
3. **Motif publication waits for the user's approval in the app.** Place the
   draft with `add_layers` when useful, then `install_motif` the reviewed
   revision: it only proposes. Tell the user to approve it in WeftCut's Motifs
   panel and stop; do not poll and do not report it published. `list_motifs`
   shows the outcome and any note. Remove trial layers afterwards unless the
   user wants them kept.
4. `export_motif` and `delete_motif` only when the user asks.

**Three.js Motifs**: read `motif-three-model.md` and start from
`templates/three-model.zip` beside this file.
