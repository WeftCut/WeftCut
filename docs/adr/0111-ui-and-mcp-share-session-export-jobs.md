---
status: accepted
---

# UI and MCP share application-session export jobs

Date: 2026-10-12

## Context

MCP needed asynchronous export (PR #50). A separate agent pipeline would have
lost resource admission, retryable finalization (ADR 0104) and time remapping,
which only the renderer export path has. The renderer reads the live project,
so a concurrent edit would change what a running or retried export renders.
Destinations include portable filesystems (exFAT) where overwrite-safe
publication is not guaranteed.

## Decision

- `ExportJobs` in main is the one authority for admission, request
  idempotency, session records and the project edit gate. UI and MCP submit to
  it and control the same job. One job runs at a time, including one awaiting
  finalization retry.
- **Editing is frozen** while a job is admitted or awaiting retry: actor
  writes, history changes, project replacement and Motif authoring reject.
  Derivative cache write-backs still apply.
- Native code probes the destination directory before rendering, writes one
  same-directory staging file, and publishes only a complete file:
  no-overwrite publication is a hard link, falling back to the platform's
  atomic no-replace rename. There is no copy fallback. Overwrite (UI only,
  explicit preference) replaces atomically after completion.
- Publication is the commit point: if it wins a race with cancellation, the
  job reports completion and the actual path. Cancellation drains native
  children, mixing and renderer work before admission is released, and does
  not cancel shared proxy/conform/bake work. Confirmed app exit cancels or
  discards and drains the job before closing the editor.
- MCP disconnect does not cancel. Records survive reconnects but not restart.

## Consequences

- One code path for both entry points; the ExportPanel shows either job's
  phase, progress and result.
- No snapshot exports, queue, restart recovery or parallel export workers.
  Allowing editing during export would need a project snapshot the renderer
  pipeline can render from.
- A destination that supports neither hard links nor atomic no-replace rename
  fails at preflight instead of risking an overwrite.
- Surface details (conflict policies, tools, idempotency) are in
  [`export.md`](../export.md#export-jobs-ui-and-mcp).
