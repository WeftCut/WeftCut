# ADR 0149: A run reads tidied, and a long clip leads with a summary

Status: Accepted

Builds on [ADR 0147](0147-a-description-is-a-run-of-chunks-and-sampling-is-never-clamped.md)
(a description is a run of chunks). The cache key and the stored segments are
unchanged; the view readers get and the `describe_clip` answer gain one thing
each.

## Context

Chunked description made long windows honest about density, and long. A
10-minute documentary at 1 fps through Qwen3-VL 4B came back as 194 segments:
76 of them one second or shorter, runs of identical lines (ten in a row of "a
pair of black shoes and a large suitcase", one per frame), and 70 one-second
gaps between segments, about 11% of the timeline, because a segment's times are
frame times and it "ends" a frame before the next one "starts". The Shots
Panel's clip-content section listed every segment above the rows, several
hundred lines for that clip, where the 16-frame single request it replaced had
given a handful.

## Decision

- **A run reads tidied.** `Run::tidied` is a pure function of one run, applied
  in the derived view before the newest-wins clipping, so files written before
  it read tidied too. Inside each finished range, never across its edge:
  gaps of at most 2 s close (the earlier segment runs on to the next start, and
  the first and last reach the range's edges), a zero-length segment stretches
  toward the next by at most as much, and consecutive segments that then touch
  and say the same thing merge — keeping the first text and the union of tags.
  "The same thing" is character-bigram Dice ≥ 0.8 over the text, or ≥ 0.55 with
  tag Jaccard ≥ 0.75; character bigrams so unsegmented Chinese compares as well
  as English. On the documentary run: 194 → 162 segments, 76 → 25 of a second
  or less, no gaps, no zero-length segments.
- **Per run, never across runs.** A shot's run is that shot's answer; two shots
  that read alike stay two rows. The stored segments stay as the model answered,
  so a later change to the rule needs no migration.
- **A long clip run ends in a summary.** When a `clip`-purpose window is longer
  than one request's frames, the run's last step is one more request: up to 8
  frames sampled evenly across the whole window, plus the run's own tidied
  timeline as an outline (capped at 3000 characters, thinned evenly rather than
  cut off), asking for two to four sentences as `{"summary": …}` in the call's
  language. It is stored on the run, cleared whenever a chunk is (re)described,
  returned as `summary` for that exact window, and listed in the description
  view as `summaries: [{ window, text }]`, newest first. A complete run without
  one (a failed attempt, an older file) asks for it alone on the next call over
  that window. Shots and short clips never ask: they are read in full, and one
  more engine run — a model load, locally — would only restate them.
- **The summary request carries frames.** The local `llama-mtmd-cli` has no
  one-shot text-only mode (without an image it opens an interactive chat), and
  frames let the model check the outline against the footage. So the summary
  is a second `Task` on the same describer seam both engines implement, not a
  separate text model.
- **A failed summary is not a failed call.** The segments stand on their own;
  the failure is logged and the answer goes without a summary.
- **The panel leads with it, in one pattern.** The clip-content section is a
  lead paragraph and one closed "Details (N segments)" disclosure, whatever the
  run holds: the lead is the summary for the clip's window (exact, else the
  newest covering one), or, for a run without one, its first three segments as
  prose. Two patterns (a disclosure under a summary, a "Show all" toggle without
  one) made the same section behave differently for a reason the reader cannot
  see. The open list scrolls inside a box of at most 40% of the viewport, so the
  score strip and the rows move down by no more than that; each line leads with
  its timecode, which seeks through the rows' own source→timeline projection,
  and its tags are a hover rather than chips the rows already show. The section
  is the panel's first child in both of its states, so opening the details
  before an analysis survives the rows landing.
- **On-screen text is quoted, not returned.** Shown a title card, the model
  answered with the card's words alone and in their language. The timeline
  prompt's language rule now says to quote on-screen text verbatim inside a
  description written in the asked-for language. A prompt rule, not a check:
  whether a line is "in" a language is not decidable from its characters (a
  quoted title, a brand, a number), so there is nothing to retry against.

## Consequences

- One more request per long clip description; its cost is one chunk's.
- The view no longer shows segments exactly as the model timed them: a
  one-frame silence is attributed to the segment before it, and a run of
  near-identical lines reads as one span. An agent that needs the raw answer
  has none to read; nothing has needed it.
- A summary that keeps failing is asked for again on each call over the window.
