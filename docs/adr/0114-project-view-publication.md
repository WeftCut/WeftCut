---
status: accepted
---

# One versioned project view publication protocol

Date: 2026-10-13

## Context

The actor is the one write authority, but the renderer had no matching
publication authority: change events, mutation callbacks and crop commands
each fetched and applied independent full summaries. An ordering guard stopped
stale publication but not redundant reads, and a command's success did not
mean selection or the next UI action could read the edited state.

## Decision

- The main-process actor host owns a monotonic `{ session, revision }`.
  `session` changes when a workspace is replaced, reopened, saved elsewhere or
  closed (project UUID and history cursor cannot serve). Every actor broadcast
  advances `revision` — undo, unrecorded preferences, MCP edits, native job
  writebacks.
- `project_publication` returns an atomic `{ version, summary }`; change
  events carry the same version. Preload `invokePublished` returns the command
  value plus a publication receipt; raw IPC and MCP contracts are unchanged. A
  receipt names a sufficient view, not exclusive ownership of a commit.
- `ProjectPublicationClient` (renderer) is the only code that applies backend
  projections to the project store: version comparison, one in-flight read,
  newest desired version, stale-reply suppression, waiters. A replaced or
  stopped owner never publishes its outstanding reads.
- Panels never call `apply(await projectSummary())`. Legacy `onMutated`
  callbacks call `settleProjectStore()` (no read when caught up);
  `refreshProjectStore()` rechecks file availability, which can change at the
  same revision. Projection reads bypass command barriers so a read never
  waits on itself.
- Failure keeps the last good view. `CommandPublicationError.accepted === true`
  marks an accepted mutation whose view sync failed: recovery retries the read,
  never the mutation. Waiters for a replaced session reject.

## Consequences

- Command completion means accepted and applied to the mounted renderer store
  — not painted, saved or flushed.
- Still a full-snapshot protocol: cost is proportional to project size. The
  version is the seam for future deltas. Memoizing snapshots must account for
  filesystem-derived availability; revision alone is not a cache key.
