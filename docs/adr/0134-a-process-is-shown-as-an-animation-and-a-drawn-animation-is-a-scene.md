---
status: accepted
---

# A process is shown as an animation, and a drawn animation is a scene

Date: 2026-10-23

## Context

The user's verdict at the H4 checkpoint: the rhythm was right, but the cuts
were still not good videos.
- **Paper and words.** The visuals lean on paper cards, labels and tape.
- **Their example.** The passage at about 10 s explains how neurons form a
  network and signal to each other. It could be an animation: one dot
  spreading into a network, with signals passing between them.
- **What they want.** Visuals that fit what is said, rich and meaningful,
  without needless words.

In 18 runs over H3 and H4, no agent wrote or forked a Motif for a scene,
although Motif authoring was open to them all along.
- **The recipe** handed them paper examples.
- **ADR 0131** said a scene is a Group of a plate and its elements.
- **The checks** counted elements and pictures. None asked whether a visual
  shows what the speech explains.

A hand-written prototype (`clipping-network`) animated that passage on its
words in the clipping look. The user approved the direction, the look, the
pace and the amount of information in it.

## Decision

- **The visual follows the kind of idea.** At the plan stage each passage
  names what the viewer sees:
  - a process or mechanism is a drawn animation that does it;
  - a named person, thing, place or document is a picture of it;
  - a term, name, number or date is a few words.
- **Animations are storyboarded with the beat list,** for the user to
  approve. A storyboard is three to six steps, each with what moves and the
  word it starts on.
- **An animation of a process is one frame-sized Motif.** Every piece of it
  moves because of the others, so it is one interaction under ADR 0131.
  - Its steps are `cue_<step>_s` props set from the word times.
  - It draws on a canvas, closed in t, from a seeded structure.
  - It is a scene by itself, with no plate and no Group. This revises ADR
    0131's "a scene is a Group" for this case: a scene of pictures is still a
    Group.
- **A drawn scene counts as a scene** for the audit and the bench:
  - It is an illustration Motif with no picture prop, at the frame's size,
    and not on `ground: none`.
  - It covers jump cuts and counts toward `scene-count` and `scene-share`.
  - On a track above the captions it hides them.
  - On `ground: none` it is drawn over the footage: an overlay, not a scene.
- **A new warning, `still-scenes`.** It fires when a cut has two or more
  scenes and under a third of them animate. An animated scene is a drawn
  scene, or a Group holding a drawn illustration.
- **The clipping style gains `clipping-network`** as its example animation,
  for agents to fork. It draws a network that grows, signals, and lights one
  set as a memory. `kind: dot` draws plain nodes for a network of people,
  places or machines.
- **Tape is optional.** The clipping examples take `tape: none` by default.

## Consequences

- **Agents write code for scenes now.** That costs more turns and more
  tokens than placing stickers. The example and the authoring guide's
  *A process is an animation* are there to shorten it. Whether smaller models
  can do it is a bench question (H5).
- **The audit cannot tell what an animation shows.** `still-scenes` only
  knows that something animates. Whether it shows the process on the words
  is the look stage's and the user's to judge. The bench keeps a human item
  for it.
- **The audit reads a drawn scene from its manifest:** its size, its role,
  and its lack of a picture prop. The bench checklist has no manifests, so it
  takes a full-scale illustration without a picture on the root.
- **Existing cuts lose their tape.** A clipping layer placed before this
  decision has no `tape` prop. The renderer fills a missing prop from the
  manifest default, so the layer now draws none. Setting `tape: strip` on it
  brings the tape back. No migration is needed: the clipping style has not
  shipped, and only bench projects hold such layers.
