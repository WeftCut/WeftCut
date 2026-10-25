---
name: teaching-explainer
description: Cut a lecture or talking-head explainer into a tight, captioned piece in the project's style, with overlays and scenes for what the talk explains.
stages: [intake, plan, build, audit, look, handoff]
until: "audit.clean || rounds >= 3"
---

## intake

- Read `project://taste`.
  - Its style is the look the project is in, and its tokens fill colours and
    fonts.
  - Its motifs are examples for each role. Use one as it is, fork it, or
    write a new Motif in the style's vocabulary.
  - `fonts` lists faces the style wants that this machine lacks. Tell the
    user; the edit works without them.
- Read the tracks: the A-roll clip, what is already on the timeline, and
  open tacks.
- Transcribe the A-roll (`transcribe_clip`).
- Look at each image and video in the pool
  (`read_project { view: "media_thumbnail" }`), and note what it shows.

## plan

Write the plan into `plan.md` in your working directory, and show it to the
user:

1. **The brief.** Who the video is for, its one message, and what is left
   out.
2. **The timetable.** One row per stretch of the cut, from the first second
   to the last:

   | Time | She says | The viewer sees | Source |
   |---|---|---|---|

   - **She says:** her words, with their times from `transcribe_clip`.
   - **The viewer sees:** the speaker alone, or what is placed over her or
     instead of her, with where it sits and when it enters and leaves.
   - **Source:** for each picture, where it comes from (see *Pictures*), and
     for each animation, the Motif that draws it.

Wait for the go-ahead before building. The user's review of the plan is
what holds it; change what they ask for and show it again.

## build

Inside a work session, with the history lock held. Build as the approved
timetable says.

1. **Tighten.** Remove pauses (`detect_pauses`, `remove_pauses`), and leave
   no A-roll clip shorter than 1 s.
   - **Check the pauses against her words first.** A pause that holds a
     whole word from `transcribe_clip` cuts what she says. Lower
     `threshold_amp` (try 0.006) and detect again until none does. A cut
     that removes more than a fifth of the talk is a sign of it.
2. **Caption.** Transcribe after tightening, and pass the envelope to
   `apply_transcripts` as it comes. The cues are built to the style's
   limits.
3. **Place overlays** with `add_motif_layer`.
   - Leave colour and font props unset: the style's tokens fill them.
   - Set `duration_s` to the layer's length.
   - Move and size the layer with `update_layer_params`. Its x and y are
     where its anchor lands.
   - To change an example, fork it into a draft, edit it, and place the
     draft.
4. **Build an animation** as one frame-sized Motif (*A process is an
   animation* in `motif-authoring.md`).
   - Set its `cue_<step>_s` props from the word times.
   - Check it with `preview_motif` at each cue.
   - Place it above the A-roll and below the captions.
5. **Build a scene of pictures** as a plate and its elements on tracks
   above the A-roll and below the captions. Group them with `create_group`
   (*Scope* in `motif-authoring.md`).

**Pictures.** Take each picture from, in order:
1. the user's media in the pool;
2. a still from the footage (`read_project { view: "media_frame" }`);
3. an image you generate, saved to a file and passed to `import_media`;
4. an SVG you draw in the style's look, passed to `import_media`.

When none of these shows it, say so in the report: the user can add a
picture for the next round.

A picture goes into a sticker through its `media` prop: `"<media_id>"`, or
`"<media_id>@<t_us>"` for a frame of a video.

Check each committed record: the span as it landed, and the props.

## audit

Run `check_composition`.
- Fix every `hard` finding.
- Fix each `warning`, or leave a tack saying why it stays.
- For `token-drift`, use `restyle_to_taste` unless the departure is meant.
- For `captions-covered`, move the scene's track below the captions.

## look

The audit reads project data. It cannot see a face, a busy background or
the colour under a caption, so look at what export will render.

- Call `render_frames` on the layers you placed, a few at a time. Sample
  each one settled, in its exit, and just after any cut under it.
- **In each sample, check:**
  - nothing is cropped;
  - the speaker's face is clear;
  - every text is legible against what is under it, the captions included;
  - each exit reads.
- For an animation, sample each cue, and check that what moves matches
  what she says.
- Fix in build, then look again at what changed.

## handoff

The deliverable is the edited project in WeftCut.
- Leave tacks on what is unresolved.
- End the work session. If the app audits and holds it, settle what it
  shows, then end it again.
- **Report:**
  - the cut length;
  - each element placed, with its time;
  - every fact an overlay adds from outside the talk, with its source;
  - every picture you generated or drew, and every point no picture covers;
  - what became a tack.

The user reviews the cut next. Their notes are the next round.
