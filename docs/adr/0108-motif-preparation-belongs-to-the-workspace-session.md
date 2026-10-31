---
status: accepted
---

# Motif preparation belongs to the Workspace session

Date: 2026-10-09

## Context

The renderer's baker rotated contents after every frame while main's single
capture host keeps one loaded page, so large sets of independent Motifs paid
navigation, setup and the first-surface fence again and again; a 250 ms
per-content budget still re-paid page startup for expensive content. Its work
was tied to the preview lifecycle, its success set could outlive files the
native disk quota had evicted, and partial progress spread over many clips left
no section playable. Reference project (Windows, 2026-10-09): 61 content
identities at 1920×1080/60, 10,337 demanded frames, a 4.26 GiB raster cache
against a 2 GiB default quota; an interrupted run resumed in a new process with
zero capture failures, and a reopen restored every content to ready in 5.8 s
with zero captures.

## Decision

- **Main owns preparation** for one Workspace session: demand, inventory,
  scheduling, retry state, persistence and coverage. The renderer declares
  committed demand and observes results; unmounting or reloading the preview
  does not cancel work. A new session (reopen, Save As) retires old work;
  admission stays closed through actor replacement and relinking, and clients
  redeclare their latest demand when main reopens it.
- **Demand:** automatic preparation covers used content intervals (through
  composition clocks, trims, retiming); explicit **Pre-bake now** covers full
  content and may retry a failure. Ranges never enter the cache key.
- **Order:** finish clips in timeline start order (ties by track/layer), root
  timeline first. Repeated instances keep their own positions; disk coverage
  stays content-addressed and shared. The playhead does not reorder durable
  work. Pre-bake now moves content (a Group's Motifs together) to the front
  after the current frame; that priority is session-local. A failed or blocked
  task yields to the next eligible one.
- **One capture host, no pool.** Every frame returns to the capture queue so
  foreground demand interleaves; background tickets age into one frame after
  2 s of foreground traffic. A pool would add resident page/GPU memory without
  throughput evidence.
- **Persistence-only captures** encode and write in main/native without
  importing a texture into the editor. With main demand present, renderer
  prewarming reads saved frames and waits instead of starting a second
  background producer on the same host.
- **Status:** queued, baking (a frame in flight), paused (with reason),
  retrying, error, ready (demanded range persisted). RAM warming is shown
  separately and never claims durable completion. A rejected declaration is a
  visible failure, not a fallback to RAM-only captures.
- **Disk:** the native sweeper retains raster directories the workspace uses
  (whole root until discovery narrows it). A quota shortfall pauses that
  content instead of evicting useful frames and rebuilding them.

## Consequences

- A long early clip delays later ones by design; Pre-bake now is the escape.
- Retention is cooperative, not a hard quota: retained artifacts can exceed a
  reduced target, and completion is not guaranteed without space.
- A protocol change between renderer and main needs a full app restart to
  validate; dev hot reload can pair an old main validator with a new renderer.
- Supersedes a renderer-owned baker.
