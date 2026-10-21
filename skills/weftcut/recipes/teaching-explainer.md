---
name: teaching-explainer
description: Cut a lecture or talking-head explainer into a tight, captioned piece with the project style's title, name card, callouts and paper inserts.
stages: [intake, plan, build, audit, handoff]
until: "audit.clean || rounds >= 3"
---

## intake

- Read `project://taste`.
  - Its style is the look the project is in.
  - Its motifs say which Motif draws each role (title, lower_third, callout,
    plate). Use those, not text you style by hand.
  - `fonts` lists faces the style wants that this machine lacks. Tell the user;
    the edit works without them.
- Read the tracks: the A-roll clip, what is already on the timeline, and open
  tacks.
- Transcribe the A-roll (`transcribe_clip`). The beats come from what is said.

## plan

Write a beat list and wait for the go-ahead. For each beat give:
- the layer kind and the Motif id the taste names;
- the role and the props that carry its text;
- in and out times;
- where it sits.

A plan usually has:
- **Title**: in the first seconds, over the speaker in the top third, or on a
  plate as a title card. At least 3 s.
- **Name card** (lower third): when the speaker first talks, bottom-left, at
  least 4 s.
- **Two or three callouts** on the claims worth remembering:
  - a quote Motif with the speaker's exact words from the transcript, the key
    phrase highlighted;
  - a pointer at something on screen.

  Each callout is 3–5 s.
- **At most one paper insert per minute**: a plate over the A-roll for a quote
  or a chapter card. The speaker's audio runs on under it.
- **Captions** on everything that is said.

Stagger entrances: no two elements start within half a second of each other.
Leave the speaker's face clear.

## build

Inside a work session, with the history lock held:

1. **Tighten.** Remove pauses (`detect_pauses`, `remove_pauses`). Leave no
   A-roll clip shorter than 1 s.
2. **Caption.** Pass the `transcribe_clip` envelope to `apply_transcripts` as
   it comes. The cues are built to the style's limits, so do not break or
   split them yourself. Transcribe after tightening, or transcribe again, so
   the cues match the cut.
3. **Place each beat.** For each one, call `add_motif_layer` with the role's
   Motif and the props that carry its text. Leave the colour, font and motion
   props unset: the style's tokens fill them. Move and size the layer with
   `update_layer_params` (its position and scale fields).
   - For an insert, put the plate on a track above the A-roll, and its quote
     or title on a track above the plate.
   - Elements leave with the cut. Fade the layer's opacity only when the user
     asks for a soft exit.

Check each committed record: the span as it landed, and the props.

## audit

Run `check_composition` and settle what it finds.
- Fix every `hard` finding.
- Fix each `warning`, or leave a tack saying why it stays.
- A `role-motif` finding means a role was drawn as plain text. Replace it with
  the style's Motif unless the user asked for text.
- A `token-drift` finding means a style prop was set by hand. Use
  `restyle_to_taste` unless the departure is meant.

## handoff

The deliverable is the edited project in WeftCut.
- Leave tacks on what is unresolved.
- End the work session. If the app audits and holds it, settle what it shows,
  then end again.
- Report:
  - the cut length;
  - each beat placed, with its time;
  - what became a tack;
  - any style fonts the user may want to install.
