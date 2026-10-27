# ADR 0147: A description is a run of chunks, and sampling is never clamped

Status: Accepted

Builds on [ADR 0055](0055-third-content-slice-is-windows-qwen3-vl-4b-on-llama-mtmd.md)
(the frame-sampling input contract), [ADR 0121](0121-clip-compute-is-a-job-callers-join-and-only-a-cancel-ends.md)
(clip compute is a job) and [ADR 0122](0122-description-caches-are-separated-by-purpose.md)
(one cache per purpose). The description view, the cache key and the
`{ covered_ranges, segments }` payload readers get are unchanged.

## Context

`describe_clip` sampled a window in ONE model request of at most 16 frames.
The fps setting only decided how many frames a short window got: a ten-minute
window at 1 fps was described from 16 frames, one every 37 seconds, and short
events fell between them (#69). The cache key recorded the requested fps, not
that density, so the sparse whole-clip answer was then handed back as the
1 fps description of any sub-window, with no engine run and no sign that it was
sparse.

The cache itself merged every call into one `{ covered_ranges, segments }`
value. A call over a window dropped every stored segment that intersected it,
including the part of a segment outside the window, while `covered_ranges`
still claimed that part: a hole no later call would ever fill
(`shot-and-content-descriptions` problem 4). And a long call that failed or was
cancelled late kept nothing.

## Decision

- **Chunks at the requested density.** A window is tiled from its start into
  chunks of `frames_per_request / fps` seconds (the last may be shorter); each
  chunk is one model request sampled at `fps`. A local engine takes 16 frames
  a request, its context's limit; an OpenAI-compatible endpoint takes its
  model's own `frames_per_request` (1–64, default 16) and may have up to its
  `concurrency` (1–8, default 1) requests in flight. Both are run tuning,
  outside the cache key: they batch frames, they do not choose them.
- **A ceiling per call, not per window.** A call needing more than 3600 frames
  (an hour at 1 fps) is refused before any frame is sampled, naming the longest
  window that fits. A mistyped fps over a long clip should cost a message, not
  hours of inference.
- **The cache stores runs.** `{ runs: [{ window, segments, done }] }`, oldest
  first. A run is one call over one window; `done` lists the chunks that
  finished, and the run is written to disk after every chunk. The same window
  asked again resumes the run, skipping its finished chunks; `refresh: true`
  discards that exact window's run first.
- **The newest run speaks.** Readers get a derived view: `covered_ranges` is
  the union of every run's finished chunks, and for each instant the newest run
  that finished it supplies the segments; older segments are clipped around
  newer runs (split in two, or dropped when nothing is left). Nothing a run
  answered for is deleted while coverage still claims it.
- **A hit is a covered window, not an exact one.** A call whose window lies
  inside the finished coverage is answered from the cache with no engine run,
  sub-windows included. This deliberately departs from ticket 01's "exact
  window only": that rule existed because a covered sub-window could be
  answered from a sparser sampling than its key claimed. With chunking the
  density is the key's everywhere, so the answer is honest, and an agent
  reading a minute of an already-described hour should not wait for the model
  again. `refresh` is the way to ask anyway.
- **Upgrade, not reset.** A file in the earlier merged shape reads as one
  finished run per covered range, each segment in the run holding its midpoint
  (else the nearest), so described prose survives the change.
- **Progress counts chunks.** `inferring` reports finished chunks out of the
  plan's, real counts in the ADR 0121 sense; a local engine still reports its
  frame sampling and model load between them.

## Consequences

- A long window costs proportionally more requests and time: describing an hour
  at 1 fps is 225 requests on a local engine. The per-call ceiling bounds the
  worst case; an interrupted call loses at most the chunk in flight.
- A model sees one chunk at a time, so prose does not carry context across chunk
  boundaries; a scene spanning two chunks is described twice, once in each.
- Readers that join by time intersection (the Shots Panel) see the newest run's
  segments over a span, never an older run's straddler beside them.
- Resuming needs the same window and the same chunk plan; a changed
  `frames_per_request` re-describes the chunks whose spans no longer line up
  with what finished.
