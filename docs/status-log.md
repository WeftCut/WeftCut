# Status / Log System

A status strip pinned to the bottom of the editor plus an expandable console
overlay that lifts over the editor (drag-resizable, does not push it up). It
records command results, long operations, MCP activity and errors. The agent
panel's activity stream is separate (see the last section). The work pill
(`WorkPill`) in the strip is the liveness signal for background work —
a background export (Preview during export), derivative jobs, clip-compute
jobs and agent calls; `ExportPanel` and `QueuePanel` own a foreground
export's progress. The strip's bell opens the notification center: what needs
the user and has no entry of its own.

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
  collapses them under the first row, which shows the op's state. **Every exit
  path owes a terminal row**, or the console shows the op as still running.

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
  (`jobs::emit_job_error`); no Started/Ok rows — the work pill owns liveness.
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
  workspace commit), schema upgrade, saving failing (`Warn` `"SaveFailing"`) and
  recovering (`Info` `"SaveRecovered"`) — one row per turn, never per failed
  attempt — checkpoint create/delete/restore,
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
cancelled. A Windows shutdown, restart or sign-out raises no `quit`: the editor
window's `session-end` saves and marks the session closed before the process is
terminated (`main/sessionEnd.ts`), and only a save that failed there marks it
for a report. An unfinished session or recorded process failure prompts after the
next splash ("did not exit normally"). Storage failures never block startup.

## Frontend

`renderer/logs/store.ts` mirrors the ring (1000), seeded by `log_list` and fed by
`log:entry`.

### Bar

```
[2] 14:32 [Agent · Claude] Added 3 layers to track V1  ⌃ │ ◔ Export 42% · +3 │ ⚠ Not saved │ 🔔•
```

The bar answers three questions, one element each: what just happened (the
log line), what is running (the work pill), what needs me (the bell). Colour
carries severity only. Not saved is the one exception: a problem with a place
of its own, because it must never be missed ([ADR 0166](adr/0166-the-status-bar-answers-three-questions.md)). Every popover opens
from its own trigger (`components/useStatusPopover.ts`): one is open at a
time, a second click or a click outside closes it, Escape closes it and hands
focus back. A popover whose trigger already says what it is has no title.

- **Log line**: the latest `Info+` message — level dot, time, source,
  message, in the console row's order; an `Error` sticks 10 s
  (`ERROR_STICKY_MS`). The leading segment (dot, time, source and a chevron)
  is the button that toggles the console, so the target keeps its width
  whatever the message; the message only reads, its full text in the
  tooltip. While errors
  arrived since the console was last open, a red count replaces the level dot
  (`unseenErrors` in `logs/store.ts`); opening the console clears it, and
  errors that land while it is open never count. It pulses once (1.5 s) when
  it appears. The button's accessible name is the count, the message and
  "Open the log".
- **Work pill** (`WorkPill`, model in `logs/workView.ts`): one pill for a
  background export (Preview during export), clip-compute jobs (ADR 0121),
  agent calls and derivative jobs. One piece of work is one row: an agent call
  running a clip-compute job is that job's row, tagged with the agent. Work
  shows once it has run 250 ms, so an agent's quick reads never flash; the
  export, started by the user, shows at once. The label: a running export
  leads with a progress ring and its percent, the rest counted after it
  ("Export 42% · +3"); otherwise one row names what it does (Transcribing,
  Generating derivatives…) and several are counted; when every row is queued
  for admission the spinner becomes an hourglass. The popover groups rows by
  owner, the export first and without a heading, since the trigger names it
  and its percent: the file and elapsed time, a bar, fps and speed, Cancel (no
  remaining-time estimate); clip jobs with their status and
  Cancel (`ComputeJobStatus`); agent calls with a link to the Activity tab;
  derivatives one row per media item with the kinds in progress. Every Cancel
  here is a small secondary button, so a row's one action shows focus. Log ops are
  not counted: the work a Started row stands for shows where it was started
  (the import row, the Shots panel, the Pauses buttons, the voiceover dialog),
  and the console shows the op. Derivative jobs are tracked app-wide
  (`state/derivativeJobsStore.ts`), since agent mode unmounts the bar; the
  bar's `data-derivative-jobs` carries their count, undelayed, for bench
  scripts.
- **Not saved** (`NotSavedPill`, amber): present only while main reports the
  project failing to save (`shared/save-status.ts`, [data-model.md §
  Saving](data-model.md#saving)). Its popover is the recovery in place: the
  reason, the last successful save and the project folder, then Retry
  (primary), Save As… and Open folder. A retry that succeeds takes the pill
  and popover away; one that fails says so in place. In agent mode, which has
  no status bar, the same pill sits in the titlebar and its popover drops
  down there.
- **Bell** (`notifications/NotificationBell.tsx`, model in
  `notifications/attentionView.ts`): always present; its dot is the most
  severe item not dismissed (info blue, warn amber, error red), and it carries
  no number — most items are states, not messages. No dot when nothing is
  listed or everything is dismissed. Its accessible name states the severity
  ("Needs attention: warning"). The same bell sits in agent mode's titlebar.
- Modes are not badges: a switch the user is in shows on its own control (the
  link override on its Quick Actions toggle and the dimmed link accents).
- A visually hidden `aria-live="polite"` region announces errors with the
  unseen count, and the turn to not saved (once per turn; its log row is a
  `Warn`).

The bar's right group grows to the bell, the work pill and Not saved at once;
the log line truncates to make room. Everything sizes off `--ui-px` and the
font-size tokens, so all six layout themes scale it, and popovers keep inside
the window at each theme's minimum size.

### Notification center

The bell's popover, titled "Needs attention" since the bell has no text. One
flat list: rows separated by dividers, no cards. A row is severity dot, title
and a description of at most two lines (full text in its tooltip). At its end,
the way to the fix (Open settings, Open review, View) is a link at the top; the
dismissal (Got it, Later), second in rank, sits grey at the bottom and shows
while the row is hovered or holds keyboard focus, so a list at rest reads as
what needs doing. Popover links carry a padded hit area and a faint chip on
hover, the focus ring's shape; no underline.
Empty: "Nothing needs attention".

Dismissing takes a row out of the center, nothing more: the center only
points. Each state keeps a home where it always shows and can be acted on,
and the dismiss link's tooltip names it — the native decode engine on
Settings · General (its engine marked unavailable), the agent Skill on
Settings · Agent (with Reinstall), unencrypted cloud keys on the model pages
where keys are entered, an offered update under Help · Check for Updates.

| Item | Level | Dismiss | Shows again when |
|---|---|---|---|
| Agent changes to review (ADR 0115) | info | no | — (gone once reviewed) |
| Environment notices (`app:notices`: keyring, native decode, agent Skill) | the notice's | Got it | the notice was gone, then returns |
| Update offered, not skipped | info | Later | a different version is offered |

Not saved is not listed: it has its own entry, and two ways in to one problem
would be one too many. Dismissals are main-owned app settings
(`dismissed_notices`, `dismissed_update_version`), so they survive restarts.
Main drops a dismissed code whenever it settles a notice set that lacks it
(at startup, once every startup notice is collected, and after the agent Skill
is reinstalled), so a notice that went away and came back is new.

### Console

- Filters: level (`Info+` default, `Warn+`, `Errors only`, `All`), category,
  source, free-text search over English message, translated rendering and
  `details`.
- Actions: autoscroll toggle, Copy (filtered view), Open log folder. Clear clears
  history rows only; it never touches the notification center.
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
