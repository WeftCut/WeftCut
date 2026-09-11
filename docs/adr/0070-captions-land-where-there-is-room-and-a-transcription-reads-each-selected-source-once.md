---
status: accepted
---

# Captions land where there is room, and a transcription reads each selected source once

A caption import — a subtitle file, an agent's `apply_subtitles`, a
transcription — lands its cues on the caption tracks the composition **already
has** wherever they have room, and opens a new caption track only for a cue
that collides with every one of them. And **Transcribe selected clip** acts on
the whole selection: every selected clip with sound, in timeline order, reduced
to one subject per source, read one at a time and written once.

## Context

ADR 0026 made every cue a `Text` layer on a caption-role track and gave
`add_caption_track` a greedy lane packer so that overlapping cues fan onto
additional tracks. The packer's candidates, though, were only the lanes it had
opened itself in the same call: the composition's existing caption tracks were
never tried. Every import therefore appended a track of its own, and a
timeline of three clips transcribed one after another ended with three caption
tracks whose cues never overlapped and could have shared one. The user saw
"a new track every time, even though the caption track was empty there".

Transcription, meanwhile, read the **primary** selected layer only — the
justification being that `apply_subtitles` wrote one track per call, so N
clips would have meant N tracks and N undo steps. That justification depended
on the packing defect above. It also made the ordinary multi-selection a dead
end: select the interview clips, press Transcribe, and one of them is
transcribed.

Two facts shape what replaces this. A plain click on a linked clip selects its
picture **and** its sound, so the single-clip press is already a two-layer
selection, and any rule that reads "every selected clip" would caption the
same speech twice unless it knows about links. And the SRT parser reads cues
from their `-->` lines, never from the per-body numbering, so N rendered
transcripts concatenate into one body and one write.

## Decision

- **Packing tries the existing caption tracks first.** `add_caption_track`
  builds its candidate list from the target composition's unlocked
  caption-role tracks, in track order, and appends every lane it opens. Each
  cue goes to the first candidate whose layers leave the cue's snapped span
  free — the same overlap predicate `pickFreeOverlayTrack` applies to every
  other placement, on the bounds `applyAddLayer` will store — else a new
  caption track is appended and joins the list. Locked tracks are never
  candidates, for that helper's reason. Only the target composition's tracks
  are tried: a Group's captions never spill into the root's caption track.
  The mutation returns the track the **first** cue landed on, which may be a
  track it did not create, and its history row reads *Added captions*, not
  *Added caption track*, because a track is opened only sometimes.

- **The subject of a Transcribe press is the whole selection, one subject per
  source.** Every selected `VideoClip` or `Audio` layer, less two kinds of
  repeat that would caption the same speech twice: a `VideoClip` whose link
  holds a **selected** `Audio` member of the same media yields to that member
  — it is the layer that plays (ADR 0068), and its own in-point and start put
  the words where the sound is even after an A/V slip; and two layers of one
  media with the same in-point, start and speed are read once, the longer one
  kept. A picture clip whose sound is not selected (an `Alt`-click escaped the
  link; the link's audio is another media) stays its own subject and is read
  from its own file, as a single-clip transcription always was. Layers of
  other kinds in the selection are ignored, not refused: a marquee that also
  caught a title has not changed what the user meant. The gate refuses only
  when nothing selected can be transcribed, and refuses the **whole** press
  when any subject is re-timed — skipping that clip quietly would read as a
  transcription that missed some speech.

- **N reads, one write, stop at the first failure.** The subjects are read one
  at a time in timeline order (two engines on one machine would fight for the
  same cores; two cloud calls in flight would bill in an order nobody chose)
  and every transcript that came back is applied in **one** `apply_subtitles`
  call, so a six-clip transcription is one history row, one undo, and one
  packing pass that sees every cue. The run stops at the first clip that fails
  and still lands the transcripts before it: the engine-wide failures (no
  model, no key, no network) fail the first clip before anything is billed,
  and a per-clip one (a clip over the provider's payload cap) must not throw
  away transcripts already paid for. The status log says both things — the
  cues that landed, and the clip that failed **by name** with the tool's own
  sentence, as the row that closes the run.

- **The wire does not change.** `apply_subtitles` keeps its arguments;
  `track_id`, `t_start_us` and `t_end_us` stay accepted and ignored, because
  the lane is now the packing's to pick and the timings were always the
  body's. `transcribe_clip` is unchanged. The renderer concatenates the
  rendered `srt` bodies as they are.

## Consequences

- **+** Transcribing the clips of one timeline, together or one after another,
  yields one caption track; a second track appears only where two cues
  genuinely share a span. Subtitle files imported over an existing caption
  track fill its holes the same way.
- **+** A multi-selection transcribes in one press and undoes in one step. The
  linked-clip click keeps transcribing once.
- **+** Every human refusal is decided before any audio is extracted, over the
  whole selection.
- **−** An import can no longer be undone *by deleting the track it created*
  when the track was already there; undo is the way, and it was always the
  intended way (one history row per import).
- **−** A caption track that carries cues from several imports has no single
  provenance. The Caption panel already reads every caption track as one
  corpus, so nothing there changes, but a per-track "which file was this"
  reading is gone.
- **−** The read step's failure row is its own key rather than the generic
  `logMutationFailure` row, because it has to name the clip; the write step
  keeps the generic row.

## Not built, and why

- **Per-clip choice of destination track.** A picker in front of the press
  would reintroduce the dialog the feature deliberately has not got, for a
  choice the packing makes correctly whenever the caption track has room; a
  user who wants a second lane can move the cues after the fact.
- **Skipping re-timed clips or continuing past a failure.** Both trade one
  honest refusal for a result that looks complete and is not.
- **Multi-selection for the other clip analyses.** Pauses and Describe keep
  their per-clip subject; ADR 0068 still names the questions a batch surface
  for them would have to answer.
