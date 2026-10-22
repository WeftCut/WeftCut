---
status: accepted
---

# A Motif draws one element or one interaction, and a scene is a Group

Date: 2026-10-22

## Context

The authoring contract's scope rule said a Motif draws one element: if
describing it needs "and", it is several Motifs on several layers. The rule
keeps a frame editable in the NLE:
- each element can be retimed, moved and retexted on the timeline;
- the audit sees its role;
- a prop change recaptures only that element.

Explainers also need full-frame animated scenes for the concepts the footage
cannot show. In such a scene some elements move because of each other:
- a cover torn off to reveal a word;
- a lid that opens and what spills out of it;
- a leader line tied to a moving object.

Split into layers, their motion no longer lines up, since a Motif cannot see
another layer. Written as one page, a whole scene becomes HTML that only an
agent can change. The user asked that what does not interact still be split
out, so the NLE keeps its value, and that the rule be relaxed only where
elements interact.

## Decision

- **A Motif draws one element or one interaction.** Elements whose motion
  depends on each other may share a Motif. An element that enters, holds and
  leaves on its own is its own layer, even inside a scene. This covers a
  title, a label, a sticker, the paper ground and a number card. An
  interaction Motif states in a comment why its pieces share it.
- **An interaction Motif stays editable through props.** It exposes:
  - its text;
  - its key times, as number props named `cue_<name>_s`, in seconds of the
    Motif's own time (0 at the layer's start, untrimmed).

  The user retimes the interaction in the inspector, without an agent.
- **A concept scene is a Group** (`create_group`, a CompositionRef layer) of:
  - the plate;
  - one layer per independent element;
  - at most a few interaction Motifs.

  The editor moves and trims the scene as one clip and opens it to retime or
  retext an element. The speaker's audio runs on under it.
- **Scenes are authored in order:**
  1. the treatment: the scene's one idea, its hero moment, and its cues
     from word times;
  2. key stills of each element (`preview_motif`);
  3. the layers in the Group;
  4. the motion;
  5. a look at the rendered frames (`render_frames`).
- **A style shows a scene with its examples.** `clipping` gains
  `clipping-reveal`, an interaction Motif: a word under a paper cover, torn
  off at `cue_tear_s`. Its STYLE.md describes a scene of a plate, headlines,
  pointers and reveals as separate layers. That is an example, not a
  template.

## Consequences

- **No static check.** A Motif's drawing is opaque to the audit, so it
  cannot tell an independent element drawn inside a scene Motif. The bench
  checks that a scene is a Group of more than one layer. The comment
  required above is for a reviewer. Later review work may judge it from
  rendered frames.
- **Cues are in the Motif's own time,** like the rest of its animation.
  Moving the layer or the Group moves them with it. Trimming the layer's
  head advances its `src_in_us` and leaves them where they were. To retime
  an interaction, change its cue prop.
- **More layers per scene.** A scene of eight layers takes eight placements
  instead of one, which costs the agent tool calls and the user nothing.
- **The user's media still stays outside.** A scene that shows a photo puts
  it on an image layer in the Group, not inside a Motif.
