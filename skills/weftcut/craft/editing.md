# Editing an explainer

Anti-patterns in cutting a talking-head explainer, whatever the style. Each
was seen in agent edits on the bench. Each names the default to avoid and what
to do instead.

## Two modes

A talking-head explainer switches between two modes, by content:

- **Footage and explanation.** While the speaker carries the picture, overlays
  add what the speech does not: a label on the slide she points at, a number,
  a name, a date, context. Most of the edit is this mode.
- **Animated explanation.** A concept the footage cannot show is a
  full-frame animated scene, with the speaker's voice running on under it.
  Use it for an abstract idea, a process, a comparison or a map. It covers a
  run of jump cuts, and it breaks a long talking stretch.

Plan which passages are which before placing anything.

## Anti-patterns

**An overlay that repeats the words being said.**
- **Example:** a pull quote of the sentence she is saying, over a caption of
  the same sentence. The viewer reads the same words three times and learns
  nothing new. The audit reports it as `overlay-echoes-speech`.
- **Instead:**
  - show what the speech leaves out;
  - quote her only over a scene where she is not on screen, or quote someone
    else.

**Jump cuts left bare after removing pauses.**
- **Example:** cuts inside one continuous shot make the speaker jump. A few
  at sentence ends read as pace; a run of them in mid-thought reads as
  stutter.
- **Instead, cover them:**
  - with an animated scene over the passage;
  - with an insert or footage from elsewhere;
  - with a punch-in: scale the second clip to about 115 % and keep the face
    where it was.

  Leave a bare jump only at a sentence end.

**A long stretch where nothing changes but the speaker.**
- **Example:** minutes of talking head with a card every minute.
- **Instead:** give each key point something on screen, an overlay that adds
  to it or a scene. Vary the rhythm: short overlays, a longer scene, a
  stretch of plain footage.

**A fact from outside the talk, slipped in.**
- **Example:** an overlay that adds what the speech leaves out can add
  something the speaker never said: a date, a coined term, a study.
- **Instead:** add an outside fact only when you are sure of it, and list
  every one in your report with where it comes from, so the user can check
  it before it ships. When unsure, label what she says instead.

**Overlays timed to round numbers.**
- **Example:** an element that arrives a second before or after its word
  feels unrelated to what is said.
- **Instead:** take its time from the word timestamps in the transcript
  (`transcribe_clip` returns them). An element enters on its word. A list
  builds item by item as each is named.

**The same beat list for every video.**
- **Example:** title, name card, three quotes, one insert. That is a
  template, not an edit.
- **Instead:** plan from what this speaker says. Some talks need one big
  scene, others a dozen small labels.
