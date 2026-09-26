---
status: accepted
---

# A subtitle document is pool media, and applying it copies its cues

A `.srt` / `.vtt` / `.ass` file enters the media pool like any other file, as a
`Subtitle` item. Putting it on the timeline is a separate act —
`apply_subtitles { media_id, t_start_us? }`, or dragging the item from the pool
onto a timeline — which lays the **whole** document as independent `Text`
layers on the caption tracks, its time 0 at `t_start_us`.

## Context

ADR 0026 made every cue a `Text` layer and had subtitle files **consumed at
import**: `import_media` branched on the extension, parsed the file straight
into a caption track and never pooled it. Beside it, the `apply_subtitles` tool
took the document as an inline `body` string plus a `format` tag. That left two
entry points doing one job, and each carried a cost:

- `import_media` answered two shapes from one argument — a media record for
  most paths, `{ caption_track_id, cues }` for a subtitle path — so an agent had
  to read the description to learn that importing an `.srt` does not import it.
- `apply_subtitles`' `body` was shaped for a producer that no longer used it:
  it existed so `transcribe_clip`'s rendered `srt` could be piped straight in,
  and transcription moved to `apply_transcripts` (which keeps word timing). What
  the string still invited was an agent hand-rendering SRT timestamps from data
  it already held in structure.
- A subtitle could not be placed at a time. Cue timings were the body's, so a
  document written for 0:00 could only land at 0:00.

`MediaItem.kind` already carried `Subtitle`, the probe already classified the
three extensions as one, and the derivative pipeline already did nothing for
the kind — the pool side had been left in place when import started bypassing
it.

## Decision

- **`import_media` pools every file.** No extension branch: a subtitle document
  becomes a `Subtitle` pool item, hashed and workspace-copied like any source,
  with no derivative jobs. The tool always answers a media record.
- **`apply_subtitles { media_id, t_start_us?, composition_id? }`** reads the
  item's file, parses it (format sniffed from the body), shifts every cue by
  `t_start_us` (default 0, never negative) and packs the cues onto the target
  composition's caption tracks by ADR 0070's rule, as one recorded edit. It
  answers `{ caption_track_id, cues, simplified }`. `body` and `format` are
  gone, with no compatibility path.
- **The whole document, nothing else.** No `src_in_us`, no `track_id`, no
  styling arguments: applying a subtitle behaves like dropping any media — all
  of it lands. The lane is the packing's to choose, which is also why the
  offset has to be given at apply time: packing depends on where each cue
  falls, so a place-at-0-then-`shift_layers` sequence would pack against the
  wrong neighbours and could be refused at either step.
- **The cues are copies.** No field ties a cue back to its pool item. Removing
  the item leaves the cues; applying it twice lays the document twice. Nothing
  reads such a tie today — `correct_caption_text` groups by
  `apply_transcripts`' source layers, `restyle_captions` works on every
  caption — and one can be added later as an additive field.
- **A drop takes only the time.** Dragging a `Subtitle` item onto the timeline
  calls `apply_subtitles` with the drop time. Whichever lane, or the new-track
  strip, it is released over accepts it and is not where it lands; the drag
  ghost shrinks to a marker at that time.
- **The tool keeps its name.** `apply_*` is the pair that expands a source into
  many layers placed by packing, with no `track_id`; `add_*_layer` makes one
  layer on the track the caller names. A rename to `add_subtitle_layer` would
  promise the second contract.
- **The def is TS-owned.** The tool now reads project state (the pool), so its
  schema lives with the other hybrids that compute in Rust and write through
  the TS actor (`auto_split_by_shot`, `remove_pauses`), and the Rust catalog
  entry and stub are removed.

## Consequences

- **+** Every media kind takes the same path: into the pool, then onto the
  timeline. `import_media` has one answer shape.
- **+** A subtitle can be placed: drop it where the scene starts, or pass
  `t_start_us`.
- **+** The document stays in the project and its workspace, so it can be
  applied again after the cues were edited away.
- **−** An agent holding subtitle text rather than a file writes it to a file
  first; one holding cue data calls `apply_transcripts` (with
  `word_timing: "none"` when it has no word offsets).
- **−** No partial apply. A full-length SRT for a clip trimmed to start at
  10:00 cannot be applied from 10:00 — the document's early cues would land
  before 0. Edit the file, or apply it at 0 against an untrimmed timeline and
  delete what is not wanted.
- **−** An agent now makes two calls (`import_media`, `apply_subtitles`) where
  it made one.
