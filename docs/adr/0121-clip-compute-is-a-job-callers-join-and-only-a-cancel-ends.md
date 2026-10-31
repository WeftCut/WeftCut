---
status: accepted
---

# Clip compute is a job callers join, and only a cancel ends it

Date: 2026-10-19

## Context

`transcribe_clip` and `describe_clip` run for minutes on a long source.
Through the stdio shim they failed after 60 s with "WeftCut is not running"
while the app kept working (#67); the shim's idle window is re-armed by app
progress, and the app sent none. Retries after a timeout each started another
job (three retries, three jobs), a person's press on the same clip started one
more, nothing could be cancelled, and the Activity row of a call that never
resolved stayed running forever.

## Decision

A clip-compute call is a **job** in one main-process registry
(`main/compute/jobs.ts`), shared by MCP calls and renderer calls.

- **Synchronous calls with progress**, not MCP tasks or a start/poll pair:
  the call returns the tool's answer when the job ends. Callers with a
  `progressToken` get `notifications/progress` on attach, on every phase
  change and at least every 15 s (`HEARTBEAT_MS`), `message` = the phase in
  English.
- **Phases** come from native `compute:job_phase` for the injected job id:
  queued (with the user-compute lane's blocking reason `memory` /
  `finalization` / `budget`, see
  [performance-settings.md](../performance-settings.md#admission-lanes), or
  none yet), extracting, normalizing,
  loading model, inferring. No terminal event; the native call settling ends
  the job.
- **Singleflight.** A call joins the running job with the same key: tool,
  source content hash (media id until hashed), source span (window plus the
  layer's source mapping) and every answer-changing argument, including the
  injected engine and `refresh`.
- **Only an explicit cancel cancels.** A caller's MCP `notifications/cancelled`
  settles that caller at once; the job is cancelled when no caller is attached
  and at least one cancelled. The app's cancel cancels it for everyone.
- **A disconnect cancels nothing.** The SDK aborts a handler both on cancel
  and on transport close; the app counts the abort as a cancel only if the
  session's transport still exists one microtask later (the shim's rule). The
  Activity row is marked `caller_disconnected` and runs until the job ends; a
  retry joins.
- Every caller settles exactly once (answer, failure, or an `isError` result
  with code `cancelled`). The model-file lease is held once per job, for the
  native call's lifetime.
- The renderer mirrors the registry (`compute_jobs:changed` plus a snapshot).
  A human call tags itself with a `request_id`, stripped before the key, since
  it may join a job it did not start.

## Consequences

- A retry or a second press costs nothing; progress says what the job waits on.
- A job whose callers all left runs to the end unread; native caches keep the
  answer. That is the price of letting retries join.
- An addon without `cancelComputeJob` still answers callers but cannot stop
  native work.
- The renderer's own in-flight gates stay per surface: an agent's job on
  another clip must not grey out a person's press.

Rejected: MCP tasks / start-poll tools (uneven client support, a second calling
convention); cancel on disconnect (a dropped stream or shim timeout would throw
away minutes of work the retry would have joined); matching a human run to a
job by layer and window (two jobs on one layer can differ by an argument; a
press can join a job keyed from another layer over the same source).
