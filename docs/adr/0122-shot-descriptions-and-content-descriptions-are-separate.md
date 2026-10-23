# ADR 0122: Shot descriptions and content descriptions are separate

Status: Proposed

Narrows the *Description* of CONTEXT.md and the description column of the
Shots Panel. Mirrors the span addressing of *Span measurement*. Spec:
`.scratch/shot-and-content-descriptions/spec.md`.

## Context

One `describe_clip` cache per source and view served two surfaces at two
granularities. A whole-clip run's segments straddle detected boundaries, and
the Shots Panel joined them onto rows by time intersection, so one sentence sat
on two cards and every card read as described. The cache's range-lazy hit made
a per-shot press after a whole-clip run return the straddlers without running
the model, and its merge dropped whole straddlers while still claiming their
outer parts as covered. A whole-clip result also had no surface of its own: on
a source never scanned for shots it was visible only through search.

## Decision

- **Two products.** A *shot description* is about one shot span; a *content
  description* is about a stretch of source. They have separate caches,
  separate prompts and separate surfaces, and neither surface shows the other.
- **A shot description is addressed by exact span**, as a span measurement is:
  a boundary that survives a threshold move keeps its prose, a reshaped span has
  none until asked for. It is one sentence and tags for the whole span.
- **A content description is a cache of runs.** An equal window replaces a run,
  different windows coexist, coverage is derived from the runs, and a refresh
  forces a new one.
- **Surfaces.** Shot descriptions live on the Shots Panel's cards. Content
  descriptions live in a Content Panel that follows the selected clip;
  *Describe clip content* reveals it.
- **Search carries both**, each entry labelled with its kind.

## Consequences

- The Shots Panel stays a review surface; describing a shot is the one
  read-only addition it keeps, and it no longer depends on content prose.
- A clip split off at a shot does not inherit the shot's description as
  content prose; the two stay independent by choice.
- Search can return two rows for the same stretch of picture.
- The MCP surface changes (`describe_clip` options, a shot-description read);
  the exact shape is settled with this ADR's acceptance.
