---
name: teaching-explainer
description: Cut a lecture or talking-head explainer into a tight, captioned, picture-led piece that switches between the speaker with the style's overlays and full-frame animated scenes for its concepts.
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
- **Take stock of the pictures.** Look at each image and video in the pool
  (`read_project { view: "media_thumbnail" }`) and note what it shows. List
  the people, objects, places and documents the talk names, and which of
  them nothing in the pool shows.

## plan

Read `craft/editing.md` first. Plan the video as an editor does, in five
steps, from its message down to its frames. Write each step into
`plan.md` in your working directory as you go, and show the user what
each gate asks them to approve.

### 1. Brief

In a few lines:
- **Who it is for**, and what they already know.
- **The message:** the one thing a viewer should understand after it.
- **The argument:** the talk's 3–5 claims, in order.
- **What is left out:** a tangent, a repeat, a long aside.

### 2. Outline

Split the transcript into sections, as a paper edit does. Give each:
- its claim, in one line, and its time span;
- its job: the hook, an idea, an example, the payoff.

Then spend the **visual budget**:
- **Animations:** the two or three ideas that are processes the footage
  cannot show (something grows, links, flows, transforms or builds up).
  They are the video's hero moments.
- **Pictures:** each named person, thing, place or document.
- **The speaker alone:** where she is the right picture, such as a story
  told to camera or a joke.

**Gate 1.** Present the brief and the outline, and wait for the go-ahead.
This is cheap to change; the steps below are not. If the user has asked for
one approval only, go on and present everything at gate 2.

### 3. AV script

Write a table with a row for every stretch of the cut, from the first
second to the last, with no gaps:

| Time | She says | The viewer sees | It adds |
|---|---|---|---|

- **She says:** her words, verbatim, with their times from
  `transcribe_clip`. Mark the pauses that come out.
- **The viewer sees:** the speaker's framing (wide, close, a punch-in), the
  overlay or the scene.
- **It adds:** what the picture shows that the words do not. A row where
  the picture only shares a topic with the words gets a better picture, or
  the speaker alone.

Rules:
- **No see-say.** No overlay repeats the line being said; the captions
  already do.
- **On the word.** A picture arrives with the word it belongs to, and
  leaves when its point is made, or when the picture under it changes.
- **Coherence.** Nothing is there only to decorate.

### 4. Storyboards

Board every scene, every animation and every group of overlays as key
frames: one frame for each moment something new arrives (each step of an
animation, each piece of a scene). Write each frame in this form:

```
Frame 3.2 · "send" 14.1 s → "communicators" 18.4 s
Over: full frame, her voice runs on
- neuron A · middle-left · 30 % of the frame's height · from step 1
- neuron B · middle-right · 25 % · enters on "send"
- signal · runs A → B · red · enters on "send"
Eye: the signal crossing from A to B
Leaves: nothing; the frame builds into 3.3
Shows: one cell passing a signal to another, which her words name but
cannot show
```

- **Place** each element in a cell of the frame's 3×3 grid (top-left …
  bottom-right), or as spanning cells. Give its size as a share of the
  frame's height. Over the speaker, say where she is and keep her face's
  cell clear.
- **Eye:** the one place to look in this frame.
- **Enters and leaves:** each on a word, or on the change in the picture
  under it (a cut, a slide change, the sticker it marks leaving).
- **Shows:** what the frame shows that the words do not.
- **Source** of each picture (see *Lead with pictures*), and which Motif
  draws an animation: an example, a fork, or a new one.

**The video's visual system.** Say how the boards relate:
- A different process gets a different picture: a walk becoming a map is
  not a network.
- An idea that comes back gets the picture it had before, as a callback.
- The animation draws the idea, so no label repeats what it draws, and no
  figure appears that the talk does not give.

### 5. Review, then gate 2

Check each frame in this order, and rewrite what fails:
1. **It shows the idea**, not just the topic.
2. **It is timed** to her words.
3. **One place to look**, clear of her face.
4. **The layout holds the frame.**
5. **It fits the visual system.**

Then count the plan against the pace (*Meet the pace*), and present the AV
script and the storyboards for the go-ahead.

### Reference for the plan

**Paper is the ground, not the content.** Stickers, strips and labels sit on
it without tape: the style's Motifs take `tape: none` by default. Use
`tape: strip` only where a pasted-on scrapbook look serves the point.

**Lead with pictures.** For each named thing, ask first what picture shows
it:
- the person she names (a portrait);
- the thing she talks about (an object);
- the place (a photo, a map);
- the proof (a document, a headline, a chart).

Words label a picture or carry what no picture can, such as a name, a
number, a date or a term. A headline card on its own is the last resort.
At least a third of the graphic elements are pictures (`word-heavy`), and a
taste's `pictures_min_share` may ask for more.

- **Over the speaker:** a picture sticker beside her when she names a person
  or a thing, with a short label on it.
- **In a scene:** a collage, not a slide.
  - Give the hero picture about half the frame, with one or two smaller
    pictures beside it.
  - Put labels on the pictures, and pointers between them.
  - Fill the frame: no corner left as bare paper.
- **Avoid repeating a slide.** A still of the slide she stands beside
  repeats what the viewer has just seen. Use one to zoom in on a detail
  (crop it), not as the scene's only picture.

Take each picture from, in order:
1. the user's media in the pool;
2. a still from the footage, cropped to what matters: a slide or an object
   behind the speaker (`read_project { view: "media_frame" }` finds it);
3. an open-licence picture: `search_images` with the name or the thing in
   English, look at the thumbnails, and `import_image` the one that shows the
   point. Keep its credit for the report;
4. an image you generate, if your model can output images: save it to a
   file and `import_media` it;
5. otherwise a drawing: write an SVG in the style's look (its ink line and
   flat fills; a person as a silhouette or a simple figure, an object as a
   clear outline) and `import_media` it. It becomes a PNG with a transparent
   ground, ready for the sticker.

A person or an object with a transparent ground pastes on best as a
`frame: cutout` sticker. Pictures from mixed sources (an old photograph, a
slide, a drawing) hold together printed in one `treatment`, such as
`halftone`.

Say in the plan which pictures come from where, so the user can supply
their own instead. If image search is off or finds nothing, draw.

**Meet the pace.** `project://taste` → `tokens.pace` says how dense the
edit is:
- `beat_every_s`: something new arrives on screen at least this often;
- `bare_talk_max_s`: at most this long with only the speaker on screen;
- `scenes_per_min`: this many scenes per minute of cut.

Count your AV script against it before asking for the go-ahead; the audit
checks the same numbers. A pace the user asks for in words counts the same:
follow it, and suggest they write it into TASTE.md so it holds next time.
Without a pace, the counts below are the default.

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

  A label or pointer marks a spot in the picture under it, so it leaves
  when that picture changes (`callout-outlives-picture`). On the footage,
  keep it inside one clip: a jump cut moves the framing, and the mark then
  points at the wrong thing. On a sticker or in a scene, it leaves with
  what it marks. If the clip is too short to read the mark, mark that point
  another way, such as a sticker or a scene.
- **One or more animated scenes** where the talk explains a concept. A
  three-minute talk usually has two or three, from 6 s to 20 s each.
  - **Animations:** at least a third of the scenes are drawn animations of a
    process (`still-scenes`). The rest are collages of pictures.
  - **Share:** scenes and plates cover at most half the cut
    (`scene-share`). The speaker stays the spine of a talk.
- **Captions** on everything that is said.

Plan the exits as well as the entrances:
- **Stagger.** No two elements start within half a second of each other,
  unless they enter on the same word.
- **Scenes and cards.** They leave by taking their pieces off: end each
  piece's layer a beat (about 0.15 s) before the next, the last one with the
  page. No plate shows empty. They do not hard-cut.
- **Clear the face.** Overlays leave the speaker's face clear.

## build

Inside a work session, with the history lock held. Build from the
storyboards: each element where its frame puts it, at its size, entering
and leaving on its words.

1. **Tighten.** Remove pauses (`detect_pauses`, `remove_pauses`). Leave no
   A-roll clip shorter than 1 s.
   - **Check the pauses against her words first.** A pause should fall
     between words. If one holds a whole word from `transcribe_clip`, mid
     sentence, she speaks softer than the threshold there, and removing it
     cuts what she says. Lower `threshold_amp` (try 0.006) and detect again,
     until no pause holds a word. A cut that removes more than a fifth of
     the talk is a sign of it. Note where runs of jump cuts fall: a scene
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
4. **Build each animation** as one frame-sized Motif, as *A process is an
   animation* in `motif-authoring.md` describes:
   - fork the style's example (`clipping-network`) or write a new Motif;
   - set its `cue_<step>_s` props from the word times of its storyboard;
   - `preview_motif` it at each cue before placing it;
   - place it on a track above the A-roll and below the captions. It is a
     scene by itself: no plate, and no Group.
5. **Build each picture scene as a group,** in the order of *Scope* in
   `motif-authoring.md`:
   1. Look at a key still of each element with `preview_motif`, with its
      real text, before placing anything.
   2. Place the plate on a track above the A-roll and below the captions
      (`move_track`: a new track lands on top, over the captions); its enter
      and exit props slide it.
   3. Place one layer per element on the tracks above it: an example, a
      fork, or a Motif you write in the style's vocabulary. A picture goes in
      the style's sticker through its `media` prop: `"<media_id>"` for an
      image, `"<media_id>@<t_us>"` for a frame of a video. Only elements
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
- A `sparse-beats` or `scene-count` finding means the edit is thinner than
  its pace: add overlays where the talk makes a point, or turn a concept
  passage into a scene.
- A `word-heavy` finding means the cut reads as words. Turn headline cards
  into pictures with labels: a portrait for a name, an object for a thing.
- A `captions-covered` finding means a scene or plate hides the captions.
  Move its track below the caption track.
- A `still-scenes` finding means every scene arranges stills and words.
  Find the passage that explains a process, and animate it.
- A `scene-share` finding means the scenes hide the speaker for most of the
  cut. Keep scenes for the ideas that need them, and put the rest over the
  speaker.
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
- **Check each scene against its storyboard:** the frame matches its board
  (layout, the one place to look), its idea is clear, and its elements
  arrive and leave on their words. For an animation, sample each step of its
  storyboard (`render_frames { times_us }`). Check that what moves shows what
  she says while she says it.
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
  - every picture you generated or drew, so the user can check it;
  - the credit line of every picture `import_image` fetched
    (`read_project { view: "credits" }`), and that CC BY-SA ones ask for the
    video to carry the same licence if published;
  - what became a tack;
  - any style fonts the user may want to install.
