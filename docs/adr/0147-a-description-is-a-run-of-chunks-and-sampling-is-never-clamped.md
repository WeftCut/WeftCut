---
status: accepted
---

# A description is a run of chunks, and sampling is never clamped

Date: 2026-10-27

## Context

`describe_clip` described a window in ONE model request of at most 16 frames,
so a ten-minute window at 1 fps got one frame every 37 s and short events fell
between them (#69). The cache key recorded the requested fps, not the density,
so that sparse answer was handed back as the 1 fps description of any
sub-window. The cache merged every call into one `{ covered_ranges, segments }`
value: a new call dropped every intersecting segment, including its parts
outside the window, while coverage still claimed them (a permanent hole), and
a long call that failed late kept nothing.

## Decision

- **Chunks at the requested density.** A window is tiled from its start into
  chunks of `frames_per_request / fps` s; each chunk is one model request
  sampled at `fps`. Local engines take 16 frames (`MAX_FRAMES`, their context
  limit); an endpoint takes its model's `frames_per_request` (1–64, default 16)
  with up to `concurrency` (1–8, default 1) requests in flight. Both are run
  tuning, outside the cache key.
- **Ceiling per call.** More than 3600 frames (`MAX_FRAMES_PER_CALL`) is
  refused before sampling, naming the longest window that fits.
- **The cache stores runs**: `{ runs: [{ window, segments, done, summary? }] }`,
  oldest first; one run per call window. `done` lists finished chunks and the
  file is written after each chunk. The same window resumes its run;
  `refresh: true` discards that window's run first.
- **The newest run speaks.** The read view's `covered_ranges` is the union of
  finished chunks; at each instant the newest run that finished it supplies
  the segments, and older segments are clipped around it.
- **A hit is a covered window, not an exact one.** Any window inside finished
  coverage is answered with no engine run, sub-windows included: with chunking
  the density is the key's everywhere, so the answer is honest.
- **Upgrade, not reset.** A file in the old merged shape reads as one finished
  run per covered range.
- Calls over the same source and view share one file; each write re-reads it
  and applies only its own change under a process-wide per-file lock
  (`vlm::runner`), so concurrent calls over different windows keep each
  other's runs.

## Consequences

- Cost scales with window length: an hour at 1 fps is 225 local requests. The
  ceiling bounds the worst case; an interrupted call loses at most the chunk
  in flight.
- Prose does not carry context across chunk boundaries; a scene spanning two
  chunks is described twice.
- Readers joining by time intersection (Shots Panel rows) see only the newest
  run's segments over a span.
- Resuming needs the same window and chunk plan; a changed `frames_per_request`
  re-describes chunks whose spans no longer line up.
- `inferring` progress counts finished chunks out of the plan's.
