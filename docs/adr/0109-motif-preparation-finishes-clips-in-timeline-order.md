---
status: accepted
---

# Motif preparation finishes clips in timeline order

Content time slicing spreads partial progress over many clips. Users instead
need complete sections to become playable in a predictable order. Preparation
now follows timeline start time, with stable track/layer order for ties. The
root timeline precedes additional open or explicitly requested compositions.
The playhead does not reorder durable preparation.

The renderer declares an ordered sequence of clip ranges alongside deduplicated
content demand. Main finishes the first eligible range before moving on. Repeated
instances of the same content retain their individual positions: completing an
early clip does not also require a later instance's frames. Disk coverage remains
content-addressed and shared; each clip displays completion for its own range.

The existing **Pre-bake now** action also moves the requested content to the front.
For a Group it promotes its enabled Motifs together, in timeline order. This
explicit action retains full-content preparation and deliberate retry semantics.
The most recent action comes first; ordinary plan updates and renderer remounts
do not undo pending priority. Promotion takes effect after the current frame,
preserving completed work. When the promoted work finishes, the normal sequence
continues. No additional queue panel or menu action is introduced.

Foreground captures can still interleave between frames. A failed or temporarily
blocked task yields to eligible work instead of blocking the entire queue; global
playback/memory policy still pauses background work. A long early clip can delay
later clips by design, and manual promotion supplies the escape hatch.

This replaces ADR 0108's bounded background content rotation. Workspace ownership,
retention, cache format, shared production, cancellation and resource admission
remain as specified there. User priority is session-local; reopening a project
restores persisted frames and uses timeline order again.
