---
status: accepted
---

# A pause is a fact about the audio that plays

A pause is measured on the Audio layer that reaches the mixer, off the peaks of
what that layer actually plays, and reviewed in a section of the Attribute
panel with the timeline still visible under it. A `VideoClip` is never a
subject: it delegates to the Audio member of its link, or it has no pause
surface at all. The old *Detect silences…* dialog, its tools and its
vocabulary go with the change — the feature is **Pauses / 停顿** on every
surface a person or an agent reads.

## Context

Three things were wrong with the feature this replaces, and they share one
cause: it measured a file rather than the film.

**Only an `Audio` layer reaches a mixer.** Both audio paths — `for_each_audio_layer`
in the Rust export mix, and the renderer's audio walk over `CompositionNode` —
visit `LayerParams::Audio` and nothing else. A `VideoClip`'s embedded track is
not what plays; the Audio member of its link is, and that member carries its
own `src_in_us` and `t_start_us`. The detector nevertheless took a `VideoClip`
and read the peaks of its source file, so a partner that had been muted,
slipped, trimmed or replaced was invisible to it, and the cut it planned was
driven by sound nobody could hear.

**Which peaks was never asked.** A clip with an effect chain plays its baked
conform sibling ([ADR 0063](0063-audio-effects-are-baked-conform-siblings.md)),
and the timeline draws that sibling's waveform. The detector read the raw
media's peaks regardless — so on exactly the clips a person reaches for this
feature on, a denoised interview, the ranges it found would have contradicted
the waveform drawn under them.

**A modal dialog hid the thing being judged.** Choosing a threshold is a visual
act against a waveform, and deciding whether a cut is right is an act of
listening. A dialog that covers the timeline and offers a list of ranges can
answer *how many* and *at what wall-clock time*, and neither of those is the
question anyone has.

A fourth pressure is vocabulary. *Silence* already meant three things here — a
muted layer, a zero-filled buffer, and this feature — and the Chinese UI put
静默 one character from 静音, which is *mute*. A word that names the feature and
nothing else was worth the wire break.

## Decision

- **A pause belongs to the Audio layer that plays.** The subject of a
  detection is resolved, never assumed: an `Audio` layer is its own subject; a
  `VideoClip` delegates to the Audio member of its link that shares its media,
  else to the link's sole Audio member, else it has **no subject** and the
  feature is absent rather than approximate — no section on the clip, and the
  command disabled with its own reason, *This clip plays no sound*. One pure
  function states the rule for the main process (both hybrids and the MCP arg
  resolver) and one renderer twin states it over `LayerSummary` + `links` (the
  section and the command gate), so a refusal and a greyed row can never
  disagree. `detect_pauses` and `remove_pauses` accept either kind and resolve
  identically; a person and an agent get the same subject for the same clip.
  Because the resolved layer owns both the samples and the source window that
  maps them, A/V slip is correct with no arithmetic of its own.
- **The peaks a detection reads are the peaks of what plays.** When the
  subject's baked effect sibling is ready and its peaks file has landed, the
  detection reads that file; otherwise it reads the raw media's. Main injects
  the resolved path into the compute args the way it injects `layer` and
  `media`, so the tile producer and the detector make one choice in one place,
  and `peaks_source` reports which was used. This is the rule the timeline
  waveform already follows, so the bands and the waveform under them cannot
  disagree. A bake still running **falls back** rather than refusing — the
  tolerance the tile fetch already has; export keeps its own strict gate,
  because export is where being wrong is permanent.
- **Clip analysis that needs the timeline lives in the Attribute panel, as a
  collapsed section — not a dialog and not a Panel.** The Attribute panel is
  already "what to do with this clip", it sits beside a timeline that stays
  visible and playable, and a section costs no new layout mode. It is
  `defaultCollapsed`, and collapsing **unmounts the body**, so nothing
  detects, subscribes or draws for a clip whose section nobody opened —
  clicking clips is the highest-frequency gesture in the editor. Mount is
  therefore equivalent to expanded, which is what lets the section publish the
  candidate bands the timeline draws and retract them by unmounting. A new
  dock Panel was refused as too heavy for a task of seconds; a floating
  non-modal dialog as a second layout mode; the effect chain because nothing
  here bakes; the Role Mixer because it is per-role and this is per-clip.
- **The command opens the section; it does not do the work.** *Detect pauses
  in selected clip…* reveals the Attribute panel and expands the Pauses
  section, the same shape *Review shots…* has against the Shots Panel. A
  command that only revealed the panel would leave the user hunting for a
  collapsed header, and one that ran a detection somewhere invisible would put
  the answer where the parameters are not.
- **The result is auditioned offline, from conform PCM — never through the
  transport.** *Audition result* reads the same conform the mixer would use
  for the subject, stitches the surviving audio around the first few joins
  from the playhead with a fixed context window, a cap and a micro-fade at
  each join, and plays one buffer. The playhead is read and never moved. A
  seek-and-skip audition depends on preview decode keeping up, so the join it
  plays is not necessarily the join it would export; the stitched excerpt is
  the samples themselves, and it is exact by construction rather than when the
  machine is fast enough.

## Considered options

- **Keep the dialog and fix only the subject.** Rejected: the subject bug and
  the dialog are the same mistake at two scales — deciding without looking at
  what plays. Fixing the read while keeping a surface that covers the waveform
  buys a correct measurement nobody can check.
- **Give pauses their own dock Panel, like Shots.** Rejected: the Shots Panel
  earns its weight from a reviewed list of rows with cover frames, and the one
  thing this feature deliberately does not have is a list. Registering a Panel,
  a default layout slot and its focus region for three fields and two buttons
  is a Panel a user has to find and close.
- **Detect on the `VideoClip` and map the ranges onto the partner.** Rejected:
  it answers the wrong question and then translates the answer. The embedded
  track and the linked layer differ exactly when it matters — a slipped,
  muted or replaced partner — and the mapping would have to invent a rule for
  each case that resolution gets right by not asking.
- **Refuse a subject whose bake has not landed.** Rejected: a detection is a
  cheap cache walk a person re-runs by moving a slider, and a refusal that
  clears itself a few seconds later reads as a broken feature. The raw peaks
  are the honest second answer, and `peaks_source` says which one was given.
- **Audition by seeking the transport and skipping the pauses.** Rejected
  (and kept as a later option): what a person would be judging is the preview's
  ability to seek, not the edit. It also moves the playhead, which is the one
  piece of state a review surface must leave where it found it.

## Consequences

- **A bare `VideoClip` has no pause surface at all** — no section, and a
  disabled command whose reason names the rule. That is the visible cost of
  the subject rule, and it is preferred to a measurement of a track that
  reaches no mixer.
- **The rename is total and carries no aliases**: the tools, the prompt, the
  hybrid names, the argument names, the marker colour constant and its label,
  the action id, the i18n keys and the renderer directory all change in one
  step, and the old names appear nowhere. A leftover name whose meaning has
  moved is exactly the confusion the rename exists to remove, and at v0.1.x
  there is no compatibility debt worth an alias.
- **The wire shape of `detect_pauses` changed with it** — an object carrying
  the ranges, the measured noise floor and the peaks source, rather than a
  bare array. The rename broke the wire anyway, so the floor that lets a
  threshold be derived instead of guessed rode along free.
- **The same principle settled the detector's channel read**: the peaks fold
  across every channel rather than reporting channel 0, because a dual-mono
  take with the voice on the right channel is audio that plays, and the old
  read called it quiet end to end.
- **Multi-selection and whole-track batches are a later spec**, and it needs a
  subject model this one does not have: N summaries, ordered ripples, merged
  refusals. Nothing here forecloses it — the subject rule is per-layer and
  composes.
- **The next clip analysis that wants a surface should be argued against this
  record**: whether its subject is the layer that actually renders or plays,
  which cached artifact it reads, and whether reviewing it needs the timeline
  in view. A new dialog has to say why those three answers differ here.

## References

- [ADR 0063](0063-audio-effects-are-baked-conform-siblings.md) — audio effects
  are baked conform siblings (the sibling whose peaks a detection prefers).
- [ADR 0062](0062-ripple-is-an-explicit-command-over-placement.md) — ripple is
  an explicit command over placement (what *Remove pauses* stands on).
- [ADR 0056](0056-following-a-clip-is-a-marker-field.md) — following a clip is
  a marker field (what a pause mark is anchored by).
- [ADR 0019](0019-audio-mixes-in-rust-over-conform-pcm.md) — audio mixes in
  Rust over conform PCM (the conform the audition stitches).
- [`features.md`](../features.md) § Pauses — the section, its controls and its
  verbs; [`audio.md`](../audio.md) § Clip effects — which peaks;
  [`mcp.md`](../mcp.md) — the two tools and the `/cut-pauses` prompt.
