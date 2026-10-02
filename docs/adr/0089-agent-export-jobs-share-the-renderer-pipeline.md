---
status: accepted
---

# Agent export jobs share the renderer pipeline

Agents previously had to ask the user to press Export. Running a second,
headless export implementation would diverge from the editor on media
readiness, Motifs, effects and encoding. Keeping an MCP request open until a
long render finishes would couple the render's lifetime to its client.

## Decision

The Electron main process owns one export job at a time and keeps job records
for its process session. Four TypeScript-hosted MCP tools inspect options,
start, inspect and cancel export: `get_export_options`, `start_export`,
`get_export_status`, `cancel_export`. Starting returns a job ID immediately;
MCP disconnect does not cancel it. Restart does not restore jobs.

The Export UI and agent entry point share the renderer's export flow. The
renderer still owns preparation and its compositor worker; native encoding,
audio and muxing remain backend responsibilities. Project mutations and
switching pause while a job is active, with reads, status and cancellation
available. All terminal outcomes release the gate. Shutdown cancels the job
before closing its project, and renderer failure terminates it.

Settings remain the existing persisted `ExportSettings` object. Its camelCase
fields, nested `audio` object and the timeline range's `startUs`/`endUs` are an
explicit exception to ADR 0074's all-snake_case MCP rule. Translating every
export control into a second wire model would create two schemas for the same
intent. New envelope fields (`output_path`, `job_id`,
`allow_experimental_10bit`) use snake_case. Omitted settings use saved values
with existing default backfills; explicit invalid settings fail. Options reads
can include `validation_issue` to expose incompatible saved settings without
blocking inspection, including inspection of an empty composition. The shared
entry point validates stream inclusion, codec/container restrictions and range.

Agent output requires an absolute path with a matching extension and a new
destination. It stages output beside the destination and publishes without
overwriting only when encoding and muxing succeed. Agent publication uses only
an atomic hard link: the existing destination directory must be on a filesystem
that supports hard links. Unsupported filesystems fail rather than copying into
a visible partial destination. Failure and cancellation
clean temporary files. A completed job is the only claim that the final file
is ready. Agents receive structured errors instead of save/fallback dialogs;
experimental 10-bit delivery requires an explicit opt-in.

## Consequences

- Agents can use every existing export setting, including video-only,
  audio-only and a half-open custom root-composition range.
- A job has preparing, rendering and finalizing phases and a completed, failed
  or cancelled terminal state. Progress describes its available phase, not a
  guarantee of successful file publication.
- Export does not create a timeline undo entry. Editing pauses so asynchronous
  preparation/render/mix all observe the same project intent.
- The stdio shim discovers the tools from the live catalog. Instructions,
  bundled skill and export documentation teach start/poll/cancel and session
  retention; no separate shim protocol is required.
- Tests cover schema/validation, shared job admission and status, cancellation,
  publication and packaged renderer exports. Passing tests must be recorded
  separately; this decision does not assert that a build has been verified.