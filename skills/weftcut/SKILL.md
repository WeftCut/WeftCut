---
name: weftcut
description: Drive the WeftCut video editor over its MCP tools. Use BEFORE calling any weftcut MCP tool — when the user wants to edit video in WeftCut (cut, trim, arrange a timeline, add captions or voiceover) or author/update a Motif (animated overlay).
---

# Driving WeftCut

WeftCut is a desktop video editor; you operate it over MCP while the user
watches the same project live in the app. Every mutation you commit lands in
their undo history and on their screen. Each tool's own description carries its
full contract — this skill covers only what no single tool can: how a session
should go.

## Session etiquette

1. Read `project://current` before your first mutation — never write against a
   guessed state.
2. Call `checkpoint` before your first edit, so the user has a one-step
   restore point.
3. A small change (a handful of tool calls) needs no more ceremony than that:
   edit, verify, report.
4. A batch job (rough-cutting a video, a pause pass, building a caption
   track) uses a work session: ASK whether to begin the batch and enter the
   lightweight agent view unless already authorized, then call
   `begin_agent_session`. It creates a checkpoint once per session. Wrap the
   batch in `lock_history` … `unlock_history`, rehearse with `dry_run` where
   supported, and call `end_agent_session` when finished (also on failure).
   Use a finally-style cleanup so a failed tool does not leave undo locked.
   Manual view switching neither starts nor ends work. The user can end work
   or unlock locally; explicit transport close also ends its owned session.
   None of these cancels running calls or prohibits later tools. Do not infer
   that a session ended because the user returned to the editor.
5. Errors are instructions: WeftCut errors name the cause and list concrete
   options. Pick one; never retry a rejected call verbatim.
6. A commit can also fail because the user (or another agent) edited
   concurrently — re-read the resource and reapply.
7. Export is deliberately not a tool. When the user wants a rendered file,
   point them to the app's Export UI.

## Working rhythm

Read → analyze → mutate → **verify**: after mutating, re-read what you changed
(`project://tracks`, `project://current`) and confirm the edit landed as
intended before reporting it done.

Common flows, one line each — parameters and caveats live in the tool
descriptions:

- Cut pauses: `remove_pauses` cuts every pause out of a clip and closes the
  gaps, as one undoable edit — `pad_us` of each pause stays at both ends, so
  the speech either side keeps its breath (or mark them to review first:
  `detect_pauses` → an anchored region `add_marker` per pause; both packaged
  as the `/cut-pauses` prompt).
- Captions: `transcribe_clip` → inspect the returned SRT → `apply_transcripts`,
  passing the envelope's `segments` and `word_timing` through (also
  `/auto-caption`). `apply_subtitles` is for a subtitle FILE the user already
  has — routing a transcript through one discards the word timing that
  `correct_caption_text` needs. Correcting names and jargon: put the script or
  notes in `set_project_settings { correction_script }`, then
  `correct_caption_text`. Restyle every caption at once with `restyle_captions`.
- Captions with your own speech model: `extract_clip_audio` returns a 16 kHz
  mono WAV block plus the window it covers (60 s per call — walk a long clip in
  consecutive windows). Transcribe it yourself, add the reported `t_start_us` to
  every offset you get back, then `apply_subtitles`.
- Voiceover: `synthesize_speech` appends a spoken script to the timeline
  (also `/voiceover`).
- Rough cut: `analyze_clip` or `auto_split_by_shot`, then trim and delete
  segments — `ripple_delete_layers` instead of `delete_layer` when the gap a
  cut leaves should close behind it.
- Music, sound effects, a separate voice track: `add_audio_layer`. It is the
  only tool that places audio-only media — `add_video_layer` builds a visual
  layer and refuses an audio file.
- A title, a lower third, a credit: `add_text_layer`, then style it with
  `update_layer_params`. Subtitles from a document stay `apply_subtitles`.
- A track that refuses every edit is locked: `set_track_flags` clears the lock
  (and hides or shows a track's output). A layer carries its own lock, which
  `update_layer` clears.
- Going back further than one undo: read `project://history` and `jump_to` a row
  by its absolute index — the way back to a state that is neither one undo away
  nor a checkpoint.

## Motifs (animated overlays)

To author or update a Motif, first read `motif-authoring.md` next to this file
— the document contract, whose one law is that visible state is a function of
`t`, never an accumulation. Then:

1. `list_motifs`, and read the closest existing Motif with `get_motif_source`
   — base your draft on what already renders correctly.
2. `write_motif_draft` (pass `from` when your draft updates an existing Motif).
3. **The user approves, not you.** Place the draft with `add_motif`, ask the
   user to play it in the app, and call `install_motif` only after they
   confirm. If you can read images, pre-check with `preview_motif_draft` at
   three timestamps (start, middle, near the end) and once with non-default
   props before involving the user — their confirmation is still the gate.
4. After installing, remove the trial layer unless the user wants it kept.
