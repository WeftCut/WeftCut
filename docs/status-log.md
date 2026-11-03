# Status / Log System

A status strip pinned to the bottom of the editor plus an expandable console
overlay that lifts over the editor (drag-resizable, does not push it up). It
records command results, long operations, MCP activity and errors. The agent
panel's activity stream is separate (see the last section). The
`derivatives-pill` in the strip is the liveness signal for background derivative
jobs; `ExportPanel` and `QueuePanel` own export progress.

## Backend

`LogBus` (`native/src/logs/bus.rs`) is workspace-scoped: built when a workspace
opens, replaced on switch, dropped on close.

- Ring: 1000 entries in memory. Broadcast to the renderer as `log:entry`.
- Persistence (`logs/writer.rs`): `<workspace>/Logs/session-<YYYYMMDD-HHMMSS>.jsonl`,
  one JSON line per entry, rolling to `…-partN.jsonl` past ~50 MB. On open the 20
  most recent `session-*.jsonl` files are kept (parts count individually). The
  writer channel holds 4096 entries; overflow drops lines **silently** (no drop
  counter; producers never block). The file is flushed when the bus drops.
- Before a workspace opens there is no bus: Rust producers drop silently and
  startup errors go to `tracing` stderr and the application diagnostics below.
  Exception: MCP host rows (it binds at `app.whenReady`) wait in a 50-entry FIFO
  (`src/main/deferredLog.ts`) and replay once when `commitWorkspace` installs the
  bus.
- `tracing` → log: only `Error` events from `weftcut*` targets become
  `System`/`Error` rows (`logs/tracing_layer.rs`). Never call `tracing` inside
  `emit` — it recurses.
- Commands: `log_list` (seed the mirror), `log_clear` (clears the ring, not the
  file, then emits one `Log cleared` row), `log_emit` (renderer-originated rows),
  `log_dir_path`.

### Entry schema

`LogEntry` in `native/src/logs/entry.rs` is canonical: UUIDv7 `id` and `ts`
stamped by the bus; `level` (trace…error); `category` (`Shortcut`, `Mcp`, `Job`,
`Export`, `Import`, `Project`, `System`, `Agent`, `Other(name)`); `source`
(`User`, `Agent { client }`, `System`); English `message`; optional `i18n_key` /
`i18n_args`; `op_id` + `op_state` (`Started`, `Progress(0..1)`, `Ok`, `Err`);
`details`.

- `details` only is redacted (`logs/redact.rs`: `Authorization: Bearer`,
  `api[_-]?key=`/`:`, `x-api-key:`) before broadcast and persistence; producers
  keep secrets out of `message`. Over 4 KB serialized, `details` is replaced by
  `{ truncated, original_bytes, preview }`.
- A long op emits one entry per state change under one `op_id`; the console
  collapses them. **Every exit path owes a terminal row**, or the running badge
  never clears.

## Producers

The house shape for anything a user may wait on: settles within 250 ms → one row,
no `op_id`; otherwise `Started` then `Ok`/`Err` under one `op_id`. A cancel
closes the op as `Ok` at `Info`; a cancel is not a failure. Never log per frame
or per chunk — the ring is 1000 entries.

- **Command dispatch** (`Shortcut`): one row per dispatch from any surface —
  keyboard and native menu call `runWithLogging`; the command registry
  (`commands/registry.ts`) wraps every `CommandDef.run`, so palette, menu bar and
  Quick Actions log automatically. No-ops (`NothingToUndo`, empty selection) at
  `Debug`.
- **Direct commits** (`Project`): inspector, drags, drops, context menus, mixer
  and similar refusals go through `renderer/errors/tryMutate.ts`, one row with the
  structured `CommandError` in `details`. Components with an inline error slot
  keep it and show the same copy. Prose refusals have Electron's
  `Error invoking remote method …` prefix stripped.
- **Speech runs and analysis surfaces** (`Project`, `source = User`): transcribe,
  voiceover, Shots analyze/measure/apply, Pauses, describe. Always a `Started` /
  terminal pair under one `op_id`, even under 250 ms, because the rows carry what
  went out and what came back (counts, engine/model). Keys live under `log.*`
  (`auto_caption_*`, `voiceover_*`, `shots_*`, `mark_pauses_done`,
  `remove_pauses_*`, `describe_*`). Failures use `logMutationFailure` with the
  run's `op_id`. Rows never contain the voiceover script, only its length.
  A cancelled job (ADR 0121) closes with a `*_cancelled` key. A refusal that
  names a Settings pane also opens it when the gesture has no inline slot.
- **Import** (`Import`): `Started` → `Ok`/`Err`; no per-file progress rows (the
  import queue UI owns that). Import timing diagnostics: below.
- **Export** (`Export`): `renderer/app/exportLog.ts` mirrors `ExportState`; house
  shape plus a `Progress` row per tenth of the encode. The native sink adds one
  `System` row with the resolved encoder plan (`Warn` when the ffmpeg shadow
  refused).
- **Derivative jobs** (`Job`, `Error` only): one row per failed job
  (`jobs::emit_job_error`); no Started/Ok rows — the pill owns liveness.
- **MCP tool calls** (`Mcp`): one `withLog` decorator (`main/mcp/withLog.ts`) on
  every request handler, so new tools log automatically. Level from
  `routeMcpTool`: mutations `Info`, quick reads `Debug`, failures `Error`; any op
  crossing 250 ms is `Info`. A synchronous mutation's `message` is the history
  change summary with the same `history.*` key; async hybrids, reads, refusals
  and no-ops keep `MCP: <tool>`. `details = { tool, args, duration_ms,
  client_info, error? }`, strings over 512 bytes elided to
  `{ omitted, bytes, sha256_8 }`. `source = Agent { client }` from `initialize`
  (sanitized, 64 bytes; `"mcp"` before it). An op crossing a workspace switch
  drops its `op_id`.
- **MCP server lifecycle** (`Mcp`, `System`): host listening, client connected
  (`Info`), disconnected / session closed, bad bearer and host-guard rejections
  (`Warn`, never the header value), other transport faults (`MCP transport
  error`), and token rotation (`User`). Host rejections are only visible via
  `transport.onerror`, because the SDK enforces `allowedHosts` itself.
- **Project** rows: deliberately no row per successful mutation — the history
  panel is that feed. What lands: refusals, load-time repairs (relink `Info`/`Warn`
  `details.kind = "Relink"`; grid repair `Warn` `"GridRepair"`, emitted after the
  workspace commit), schema upgrade, checkpoint create/delete/restore,
  `TransitionPlacementBounce` and `MarkerReconcileDrop` (actor), motif staleness,
  and the cross-composition Alt-drag refusal
  (`renderer/timeline/crossCompositionRefusal.ts`).
- **System**: `tracing` errors (above) and startup capability notices, mirrored
  once the bus exists.

### Import timing diagnostics

UI and MCP imports share an `import_id`. Rows: category `Import`, message
`Import timing: <stage>`, `details` with `schema: 1`.

- `Info`: request start, renderer milestones, `background_settled` summary
  (`completed` / `incomplete`). `Debug`: registration and each native stage's
  queued/running/terminal event. `Warn`: failures, distinguished from cancel.
- Stages: `probe`, `hash`, `gop_probe`, `copy`, `thumbnails`, `conform`,
  `waveform`, `quick_proxy`, `proxy`. `queue_ms` runs from stage entry to
  resource admission (single-flight and copy FIFO waits included); `work_ms` from
  admission; `total_ms` is their sum. Cache hits have zero queue. `cache` is
  `hit` / `miss` / `shared`. `admission_at_enqueue` is context, not cause.
- Renderer milestones, once per media: `pool_observed`, `editable`,
  `first_frame_submitted` (a real frame bound and `app.render()` returned — not
  scanout), `audio_prepared` (PCM ready — not audible). Elapsed is measured at
  main's receipt; frame/audio milestones include user idle time.
- Session-only, bounded to 2048 requests (`main/importDiagnostics.ts`); eviction or
  a workspace transition emits `tracking_ended`. Never alters import scheduling.

### Application diagnostics and issue reports

Independent of the bus. `main/entry.ts` starts it before the editor loads.
`<userData>/diagnostics` (`diagnostics-dev` unpackaged) keeps 8 sessions
(`main/diagnosticsStore.ts`); each has a marker, hardware/version snapshot and up
to two 512 KiB JSONL segments. Pending writes cap at 32 KiB, flush every 2 s;
fatal errors flush immediately. It records console messages, renderer errors,
child-process failures, project log messages (minus tool args, free-form
details and i18n args; import timing by explicit field selection) and resource
status every 10 s. Credentials, paths, URLs and emails are redacted before disk.

Report an Issue (startup screen, Help menu) exports a local ZIP (current session +
latest abnormal one + environment + README) and opens a prefilled GitHub issue
draft; the user attaches the ZIP. Nothing is uploaded automatically. Only the
`quit` event (after autosave) marks a session closed — `before-quit` can be
cancelled. An unfinished session or recorded process failure prompts after the
next splash ("did not exit normally"). Storage failures never block startup.

## Frontend

`renderer/logs/store.ts` mirrors the ring (1000), seeded by `log_list` and fed by
`log:entry`.

### Bar

```
[●] 14:32  Added 3 layers to track v1 · agent  [N to review] [⚠2] [↻1] [System N] [Update] [Logs ▾]
```

- Latest `Info+` message with time and source; an `Error` sticks 10 s
  (`ERROR_STICKY_MS`); the error badge pulses once (1.5 s) on increment.
- Badges: unreviewed agent changes (ADR 0115; opens the agent panel's Changes
  tab), errors, running ops, running clip-compute jobs, system notices (opens the
  status panel with recovery cards), update offer (`docs/releases.md`).
- A visually hidden `aria-live="polite"` region announces errors only.

### Console

- Filters: level (`Info+` default, `Warn+`, `Errors only`, `All`), category,
  source, free-text search over English message, translated rendering and
  `details`.
- Actions: autoscroll toggle, Copy (filtered view), Open log folder. Clear clears
  history rows only; it never touches the system-status panel.
- Rows: time, level, category and source pills, message; disclosure shows
  `details` JSON and `op_id`. Ops collapse to one row with a counter; progress ops
  show an inline bar. `role="log"`. Not virtualized (1000 rows render fine).
- Footer: `showing N / M` and the logs folder path.
- Keys: `toggleLog` `Mod+\``, `focusLogSearch` `Mod+Shift+\``. Escape in search
  clears the query, then collapses; elsewhere in the console it collapses.

### Refusals

A refusal crosses IPC as `Error(JSON.stringify(CommandError))` (Electron's
`invoke` drops custom Error props). `renderer/errors/parseCommandError.ts` parses
it; `formatCommandError.ts` maps every variant to a tier through an exhaustive
`Record`, so a new variant without a tier fails to compile:

- **suppress** — `NothingToUndo`/`NothingToRedo`, logged at `Debug`.
- **generic** — plumbing variants, code humanized, English only.
- **curated** — user-reachable refusals (`LayerOverlap`, `TrackLocked`,
  `FpsLockedByContent`, …): `errors.*` copy (en-US, zh-CN) with ids resolved to
  display names, never raw uuids.

No toast layer: prevention plus the status bar is the NLE convention.

### i18n

- `message` is canonical English. High-frequency producers (shortcut names, MCP
  and project change summaries via `history.*`, import/export verbs, curated
  refusals) also emit `i18n_key` + `i18n_args`. Mechanical lines (`MCP: <tool>`)
  and `tracing` rows have no key.
- `renderer/logs/renderMessage.ts` prefers the key, falls back to `message`; used
  by the bar, console rows and search. Untranslated rows render verbatim.

## Agent activity is a separate stream

The MCP handler funnel feeds both the diagnostic decorator and the main-owned
`AgentActivityService`, which has its own ids, session ownership, history ids and
execution state. Clearing or evicting log rows never touches activities;
checkpoint restore marks reverted effects without pruning the log.
