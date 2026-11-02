---
status: accepted
---

# Import work belongs to a workspace session

Date: 2026-10-07

## Context

Opening a project, reopening the same directory, saving elsewhere and closing
must end the previous opening's asynchronous work. Derivatives are keyed by
content hash, but a hash identifies bytes, not which opening should receive a
completion: the same file can be imported in two openings of one directory, and
a late completion from the old one would write into the new project.

## Decision

- **Each opening has a generation.** Main invalidates import continuations when
  a lifecycle transition begins, serializes transitions, and drops native events
  whose `workspace_generation` is not current before any actor write
  (`workspaceEvents.ts`). Calls during a transition are refused with a retry.
- **Native tasks capture an immutable cache root and cancellation scope before
  admission.** Cancellation releases resource leases only after child processes
  exit. Audio-effects preparation follows the same boundary for UI and MCP.
- **Artifacts outlive an opening; work does not.** Recipe versions and file
  validation decide reuse. Hydration of already-valid derivatives runs before
  resource admission, so pressure cannot hide them. Provisional import identities
  and interrupted workspace copies resume on reopen; a missing derivative is
  regenerated on demand.
- **One producer per (cache root, content hash, artifact kind, recipe version)**
  (`jobs/singleflight.rs`); every subscribed media item gets the completion. A
  new generation waits for a cancelled producer to release a shared output
  before taking over.
- Admission lanes for import preparation, workspace copies and the renderer's
  request lookahead are in [performance-settings.md](../performance-settings.md#admission-lanes).

## Consequences

- Every native import task carries a cache root and generation; a new async
  import path that skips them can write into the wrong project.
- Validated disk reuse is still subject to later eviction or external
  modification (ADR 0153 covers changed sources).
