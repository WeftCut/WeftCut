# Editing an explainer

Anti-patterns in cutting a talking-head explainer, whatever the style. Each
was seen in agent edits on the bench. Each names the default to avoid and what
to do instead. How dense, picture-led or animated the cut is, is the user's
call: ask, or follow their notes.

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
