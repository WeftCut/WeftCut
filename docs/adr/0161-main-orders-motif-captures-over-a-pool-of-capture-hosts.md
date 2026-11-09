---
status: accepted
---

# Main orders Motif captures over a pool of capture hosts

Date: 2026-11-09

## Context

Every Motif capture (preview, lookahead, preparation, export, covers, MCP) ran
on one offscreen capture host behind one queue. A bitmap host keeps alpha only
for a window's first document, so each switch to another Motif or content
version builds a new window (ADR 0159), and one host is one renderer process:
two Motifs never rendered at once. Two different Motifs stacked rebuilt the
host on almost every capture (94–97 builds per 10 s, ~63 ms each; 1.3–4.8 fps
per lane where each alone plays at 30).

Each renderer document sent one capture at a time, so main never knew the near
future. Measured on the Windows bench and an M1 8 GB: keeping 2 lookahead
captures outstanding doubled uncached heavy DECO Motifs (M1 12→30 fps, a
mid-weight one on the bench 17→30); 3, or 5 frames in flight, added nothing but
queueing in main (bench 19→60 ms, M1 13→43 ms). But that one renderer slot
was also taken by running lookahead, so a `current` frame waited behind it,
and in main a capture left the queue when it leased its host and then waited
inside for room among frames in flight, where nothing could overtake it:
per-capture latency of `current` rose 101→181 ms on a bench stack and
231→478/678 ms on a DECO stack.

Main cannot simply hold every request: each capture has a 60 s transport
deadline in the renderer, and a prewarm window is up to 256 requests. A
request queued in main is stale after a seek, and only the renderer knows the
plan's order; first-in-first-out sends old-window frames before nearer new ones
after a seek back.

## Decision

- A **capture host** is one offscreen window showing one Motif content version
  (Motif id, content hash, shared texture or bitmap). It owns its frames in
  flight, drains them before a resize, and retires itself on a transport
  failure or a hung setup or render, failing only its own frames.
- Main keeps a **pool**: at most one host per key and `captureHosts` in all
  (default 1, range 1–4). A capture whose key has no host takes a free slot,
  else replaces the least recently used host that is not rendering, after it
  drains. Each host renders one frame at a time; hosts render concurrently.
- One queue orders captures by class (`current`, `ahead`, `background`, with
  background aging) and **dispatches at a free slot**: a capture leaves it only
  when a host can take its frame, so `current` waits at most one render step
  and one paint on its host. A running frame is never preempted.
- **Host affinity** within a class: a capture whose Motif has a host goes
  before an older one without until that one has waited `hostAffinityMs`
  (default 250, not measured). It never crosses a class.
- A capture's frame memory is reserved when it reaches its host, once per job
  (ADR 0160), so a queued capture holds nothing.
- **Renderer send window.** A document sends `current` captures at once and at
  most `captureRequests` (default 2, range 1–32) `ahead` and `background` ones;
  a promoted one keeps its place until it settles. Waiting ones go lowest
  order first; the prewarmer ranks requests by their place in its plan and
  re-classes and re-ranks kept ones on every replan, and main moves a queued
  capture whose class changed.

## Consequences

- `current` is never held behind lookahead in the renderer and waits at most
  one paint in main. Heavy uncached Motifs that one slot capped play about
  twice as fast where the host keeps up.
- Where the host does not keep up (a heavy DECO Motif on the bench, ~40 ms per
  serial render, 7.8→12.3 fps), half of the lookahead lands behind the
  playhead: lookahead does not yet know which frames the playhead will pass
  before they are captured.
- At most two lookahead captures per document are thrown away on a seek; a
  bigger window queues more in main and more is lost.
- With `captureHosts=1`, alternating Motifs drain and replace the host;
  affinity turns per-frame switches into runs only while the queue holds work
  for the warm host. More hosts keep their windows and render in parallel, at
  a renderer process and a capture surface each; `captureHosts` above 1 is not
  measured yet.
- Diagnostics report `rendering` (render steps in progress), `hostEvictions`,
  `affinityPicks` and one row per host.
