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
  flight, drains them before a resize or a version switch, and retires itself
  on a transport failure or a hung setup or render, failing only its own
  frames. Another Motif gets another window: one renderer process per Motif.
- Main keeps a **pool**: at most one host per key and `captureHosts` in all
  (default 8, range 1–8), and a second or later host only while memory is
  not under pressure, the hosts together stay within `hostMemoryPercent` of
  the memory target, and the app's process tree without its hosts, plus
  every host at full size, fits under the target; the first can always
  open. A host is resident process
  memory the target already measures, so it is charged there, at its measured
  working set, and not to the admission ledger, which an export alone can
  fill. Under pressure the idle hosts retire down to one, on every memory
  sample while it lasts. A preview's `current` frame takes the governor's
  floor (ADR 0101): it is never refused for budget or pressure, only when the
  machine itself is critical, under 256 MiB available
  (docs/notes/motif-host-memory-2026-11-10.md). A capture whose key has no host first takes an idle
  host of another content version of its Motif on its lane: once that host
  drains, its shell's frame loads the new version's page, and a page that
  does not load retires the host and the slot opens a new one. Else it takes
  a free slot, else replaces a host that is not rendering and that its class
  may take, after it drains. Each host renders one frame at a time; hosts
  render concurrently.
- **Presence and roles.** Each preview document tells main, when it or the
  play state changes, which Motif content versions are visible at its
  playhead, which enters next within the lookahead, and whether it plays
  (`motif:presence`); a document that goes takes its presence with it. A host
  is *held* while its content is visible in a playing preview or a `current`
  capture (an export's included) used it within `hostResidencyMs`, *warm*
  while its content is next in a playing preview, else *spare*. A paused
  preview protects nothing beyond its `current` captures' residency: its
  frame is on screen, and an agent's MCP preview or a bake must not wait on
  an idle editor. An `ahead` or `background` capture takes only a spare host
  until it has waited `hostAgingMs`, so side traffic (preparation, panel
  previews, covers, MCP) does not evict what playback or an export needs, and
  never waits for ever. A `current` capture, or aged side traffic, takes a
  spare, then a warm, then a held host that has shown its content for
  `hostResidencyMs`, the longest-shown first: with more visible Motifs than
  hosts they rotate at that pace, not per frame. The queue is woken when a
  protection ends. Under memory pressure spare hosts retire before warm ones;
  held ones stay.
- **Warming.** While a preview plays, main builds the host of the next Motif
  to enter (named `presenceLookaheadMs` ahead, with its capture size) a lead
  before it enters: the median of the latest host builds plus first steps
  (readiness, setup and render of a host's first frame), else
  `hostWarmLeadMs`. It builds the window and its page, not a frame, and as
  side traffic: in a free slot or in place of a spare host, never a held or
  warm one. Diagnostics count `hostWarms` and `warmHits` (a `current` capture
  that found the host warming built).
- One queue orders captures by class (`current`, `ahead`, `background`, with
  background aging) and **dispatches at a free slot**: a capture leaves it only
  when a host can take its frame, so nothing in the queue holds a `current`
  capture's place. A running frame is never preempted.
- **Host affinity** within a class: a capture whose Motif has a host goes
  before one without until that Motif has waited `hostAffinityMs` (default
  250, not measured) without a host; then it ranks from when its Motif began
  waiting. The wait is the Motif's, not the capture's, so a scrub that
  re-sends `current` every tick cannot starve it. Affinity never crosses a
  class.
- A capture's frame memory is reserved when it reaches its host, once per job
  (ADR 0160), so a queued capture holds nothing.
- **Renderer send window.** A document sends `current` captures at once and at
  most `captureRequests` (default 2, range 1–32) `ahead` and `background` ones;
  a promoted one keeps its place until it settles. Waiting ones go lowest
  order first; the prewarmer ranks requests by their place in its plan and
  re-classes and re-ranks kept ones on every replan. The rank stays in the
  renderer: main moves a queued capture whose class changed to the back of
  its new class.

## Consequences

- `current` is never held behind lookahead in the renderer. In main, one whose
  Motif has a host waits for the `current` captures ahead of it (export frames
  are `current` too), at most one aged `background` frame, then the render
  step in progress and one paint on its host; a resize first drains that
  host's frames in flight. One whose Motif has no host can wait
  `hostAffinityMs`, then for the replaced host to drain and a window build.
  Heavy uncached Motifs that one slot capped play about twice as fast where
  the host keeps up.
- Where the host does not keep up (a heavy DECO Motif on the bench, ~40 ms per
  serial render, 7.8→12.3 fps), half of the lookahead lands behind the
  playhead: lookahead does not yet know which frames the playhead will pass
  before they are captured.
- At most two lookahead captures per document are thrown away on a seek; a
  bigger window queues more in main and more is lost.
- With `captureHosts=1`, alternating Motifs drain and replace the host;
  affinity turns per-frame switches into runs only while the queue holds work
  for the warm host. More hosts keep their windows and render in parallel, at
  a renderer process and a capture surface each. A single Motif never opens a
  second host.
- A content version switch (a draft edit) keeps the window: in a 2026-11-09
  probe a new colour reached the screen in a median ~56 ms on the M1 and
  ~74 ms on the Windows bench, against ~174 / ~205 ms with a new window, with
  alpha correct on 32 of 32 checks on both lanes and no growth in host memory
  over 22 switches.
- Measured with 1 and 2 hosts (fps per lane, two stacked Motifs uncached):

  | Machine | Light pair | Heavy DECO pair | `current` latency, DECO pair |
  |---|---|---|---|
  | M1 8 GB | 3.7 → 30 | 2.5 → 26.6 / 18.9 | 399 → 49 ms |
  | Bench (i5-13400, RTX 3050) | 3.4 → 29.9 | 1.6 → 20 / 10 | 552 → 103 ms |

  With 1 host the M1 rebuilt it 71 times per 10 s and stalled over 500 ms
  4 times. With 2, its memory pressure stayed normal and swap did not grow;
  the app's peak footprint rose 1.7 → 2.1 GB, mostly the editor renderer and
  GPU process handling more frames (the second host is ~60–120 MB). The
  bench's GPU memory rose ~1.5 GB, following the frame rate. Hence the
  default 2; above 2 is not measured. `captureRequests=1` lowered throughput
  on both machines (M1 DECO pair 30 → 22 fps), so it stays 2.
- Diagnostics report `rendering` (render steps in progress), `hostEvictions`,
  `hostSwaps` (version switches in a window), `hostSheds` (hosts retired for
  memory pressure), `affinityPicks` and one row per host with its role and
  its renderer's working set (`memoryMib`).
- Measured in the scenario suite (docs/notes/motif-elastic-pool-2026-11-10.md):
  stacked Motifs went from 400–640 window builds a minute to 20–36 and from
  2–4 to 12–27 fps; 7 visible Motifs on the bench need the cap of 8; the M1
  stays near 4 hosts by the share, since the rest of the app grows after
  the hosts open.
