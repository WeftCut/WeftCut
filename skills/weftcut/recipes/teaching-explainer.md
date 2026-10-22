---
name: teaching-explainer
description: Cut a lecture or talking-head explainer into a tight, captioned piece that switches between the speaker with the style's overlays and full-frame animated scenes for its concepts.
stages: [intake, plan, build, audit, look, handoff]
until: "audit.clean || rounds >= 3"
---

## intake

- Read `project://taste`.
  - Its style is the look the project is in.
  - Its motifs are the style's example Motifs for each role (title,
    lower_third, callout, plate). They are a starting point, not a template.
    Use them as they are, fork one and change it, or write a new Motif in the
    style's vocabulary when the video needs something they do not show.
  - `fonts` lists faces the style wants that this machine lacks. Tell the user;
    the edit works without them.
- Read the tracks: the A-roll clip, what is already on the timeline, and open
  tacks.
- Transcribe the A-roll (`transcribe_clip`). The beats come from what is said.

## plan

Read `craft/editing.md` first. Then:

1. **Split the transcript into passages** and give each a mode:
   - **Footage and explanation** while the speaker carries the picture.
   - **Animated scene** for a concept the footage cannot show: an abstract
     idea, a process, a comparison. Also use it where a run of jump cuts
     needs covering, or to break a long talking stretch. Her voice runs on
     under the scene.
2. **Write a beat list and wait for the go-ahead.** For each beat give:
   - its mode, and what it adds that the speech does not;
   - the layer kind and the Motif (an example, a fork, or a new one);
   - the role and the props that carry its text;
   - in and out times, taken from the words it belongs to (the word
     timestamps from `transcribe_clip`);
   - where it sits.
3. **For each scene, also give its treatment:**
   - its one idea, and its hero moment;
   - the elements it shows, each with the word it enters on;
   - which elements interact and share a Motif, and why.

A plan usually has:
- **Title**: in the first seconds, over the speaker in the top third, or as
  a card. At least 3 s.
- **Name card** (lower third): when the speaker first talks, bottom-left, at
  least 4 s.
- **Overlays that add to what is said:**
  - a label on the slide or object she refers to;
  - a number, a name, a date;
  - a pointer at something on screen.

  Never the sentence she is saying: the captions already show it. Each is
  3–5 s.
- **One or more animated scenes** where the talk explains a concept. A
  three-minute talk usually has one or two, from 6 s to 20 s each.
- **Captions** on everything that is said.

Plan the exits as well as the entrances:
- **Stagger.** No two elements start within half a second of each other,
  unless they enter on the same word.
- **Scenes and cards.** They leave by taking their pieces off: end each
  piece's layer a beat (about 0.15 s) before the next, then slide the page
  out. They do not hard-cut.
- **Clear the face.** Overlays leave the speaker's face clear.

## build

Inside a work session, with the history lock held:

1. **Tighten.** Remove pauses (`detect_pauses`, `remove_pauses`). Leave no
   A-roll clip shorter than 1 s. Note where runs of jump cuts fall: a scene
   or a punch-in covers them (`craft/editing.md`).
2. **Caption.** Pass the `transcribe_clip` envelope to `apply_transcripts` as
   it comes. The cues are built to the style's limits, so do not break or
   split them yourself. Transcribe after tightening, or transcribe again, so
   the cues and the word times match the cut.
3. **Place each overlay beat.** For each one, call `add_motif_layer` with its
   Motif and the props that carry its text.
   - Leave the colour and font props unset: the style's tokens fill them.
   - Set the Motif's duration_s prop to the layer's length, and its exit
     prop.
   - Move and size the layer with `update_layer_params`. Its x and y are
     where its anchor lands, the centre unless the anchor is moved.
   - To change an example, fork it into a draft, edit, and place the draft.
     Keep the shared props so the style still reaches it.
4. **Build each scene as a group,** in the order of *Scope* in
   `motif-authoring.md`:
   1. Look at a key still of each element with `preview_motif`, with its
      real text, before placing anything.
   2. Place the plate on a track above the A-roll; its enter and exit props
      slide it.
   3. Place one layer per element on the tracks above it: an example, a
      fork, or a Motif you write in the style's vocabulary. Only elements
      that move because of each other share a Motif, an interaction such
      as a cover torn off a word. Set its `cue_<name>_s` props from the
      word times; say in your report why its pieces share it.
   4. Time each element from its word, and end the elements a beat apart
      before the plate leaves.
   5. Group the plate and its elements with `create_group`, so the scene
      moves and trims as one clip.

Check each committed record: the span as it landed, and the props.

## audit

Run `check_composition` and settle what it finds.
- Fix every `hard` finding.
- Fix each `warning`, or leave a tack saying why it stays.
- A `token-drift` finding means a style prop was set by hand. Use
  `restyle_to_taste` unless the departure is meant.
- An `overlay-echoes-speech` finding means an overlay repeats the line being
  said. Replace its text with what the speech leaves out, or drop it.
- A `bare-jump-cuts` or `bare-talk` finding means the passage plays as plain
  talking head with stutters. Cover it with a scene or an insert, punch in on
  alternate clips, or give its key point an overlay.

## look

The audit reads the project data; it cannot see a face, a slide or a busy
background. Look at the frames export will render.

- **Render each beat.** Call `render_frames` with the layer ids of the
  beats, a few at a time. Each beat is sampled settled, in the middle, in its
  exit, and just after every cut or shot change under it. A framing change
  under a title is where it lands on a face.
- **Check every sample:**
  - on frame, with nothing cropped;
  - clear of the speaker's face, and of what she points at on a slide;
  - legible against what is under it;
  - its exit reads.
- **Check each scene against its plan:** its one idea is clear, and its
  elements arrive on their words.
- **Fix in build, then look again** at what changed. Build, audit and look
  together are one round.

## handoff

The deliverable is the edited project in WeftCut.
- Leave tacks on what is unresolved.
- End the work session. If the app audits and holds it, settle what it shows,
  then end again.
- Report:
  - the cut length;
  - each beat placed, with its time and mode;
  - every fact an overlay adds from outside the talk, with its source;
  - what became a tack;
  - any style fonts the user may want to install.
