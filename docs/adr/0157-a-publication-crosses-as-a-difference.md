---
status: accepted
---

# A publication crosses as a difference

Date: 2026-11-04

## Context

Every commit read a complete project summary over IPC (ADR 0114). Structured
clone drops object identity, so the renderer walked the whole tree again to
restore it (`shareSnapshot`). On a real project with about 4,600 keyframes per
axis, the summary is 5 MB and keyframes are 98% of its leaf bytes. There the read
took 44 ms and the walk about 19 ms, and each commit stalled the renderer about
90 ms. A 17 KB project stalled 20–30 ms. Main already holds immutable snapshots
with shared branches; the projection and the IPC boundary threw that away.

## Decision

- **`project_publication` answers with a difference when it can.** Every answer
  has an id, and a reader names the answer it holds as its base. Main answers
  `{ version, viewId, base, patches }` when it still remembers that answer, and the
  whole projection otherwise: no base, another session, a closed workspace, a base
  too old, more than 2,048 patches. The whole projection is always correct, so
  every doubt resolves to it. A base is an answer and not a version because a forced
  refresh answers one version twice, and the reader may have dropped either reply.
- **Identity is what makes it cheap.** The summary is rebuilt on every read, so
  no view can go stale and a forced refresh still sees filesystem-derived fields
  move at the same revision. Keyframe tracks reach it by reference from the immutable
  snapshot, so `diffSnapshot` stops at them without reading a keyframe. A commit
  compares the fields of every layer view, and its cost follows layers, not keyframes.
- **`ProjectPublicationClient` owns the held view,** so a read's base and the view
  a difference lands on cannot disagree. A patch copies only the path it walks.
  Whole projections pass through `shareSnapshot` once, on the way in. A difference
  that does not fit is not a failure: the client reads the whole projection and no
  waiter hears of it.
- **Consumers do not change.** The store, its selectors and every subscriber still
  see one complete summary whose unchanged branches keep their references.
  `project_summary`, raw IPC and MCP stay whole.
- **Patches preserve key order.** Consumers iterate records, and an undo returns a
  key to its old place where a patch would have appended it.

## Consequences

- Commit stall and input-to-picture stop growing with keyframes. On that project,
  stall p95 went from about 90 ms to 25–53 ms and input-to-picture p95 from 93–114
  to 25–52 ms, close to the 17 KB project, which did not regress (Windows bench,
  n=6 per gesture).
- `invariant-fuzz.test.ts` requires the rebuilt view to equal a full read, byte for
  byte, after every random op. `edit-latency.spec.ts` requires a marker drag on a
  dense timeline to cross as a handful of patches.
- Main holds the last eight answered views. They share their unchanged branches.
- A projection that copies a keyframe track loses this silently, so a test holds the
  track's identity through the view.

Rejected: remembering a view per `Layer` (it saves under 1 ms per commit at 60 layers
and about 37 ms at 5,000 in a synthetic project, but a new field that reads anything
else goes stale without an error, and a full read checked against the difference would
share the stale view); an entity-subscription or change-set layer for consumers (after this
change a store apply is 0.5 ms and no function exceeds 2.4 ms per commit, and
inputs such as `motifPlanningInputs` need domain knowledge a generic change set
does not have); Immer patches from the actor (they describe the project, not the
projection, and do not cover derived fields).
