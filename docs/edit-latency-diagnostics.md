# Edit-latency diagnostics

Opt-in, bounded probes for stalls after releasing a marker or clip drag. Off
by default and independent of commit, history and save policy. Past diagnosis:
[edit-latency diagnosis](notes/edit-latency-diagnosis-2026-10-13.md).

## Automated capture

After `npm run build:e2e`, from the repository root:

```powershell
node apps/desktop/e2e/scripts/profile-marker-drag.mjs `
  --project 'C:\path\to\project' --user-data "$env:APPDATA\WeftCut" `
  --work-dir 'tmp/marker-drag-diagnostics' --label baseline --samples 6 `
  --cpu-profile --chrome-trace
```

Add `--renderer-url http://localhost:1420` to drive a running `npm run dev`
renderer. The script copies the project, media/cache and Motif library into the
work directory once (later runs reuse it) and runs a separate Electron profile;
every mutation and autosave targets the copy. After a 12 s warm-up it makes
`--samples` (default 4) 40 px drags of one marker, 2.8 s apart, and writes
`<label>.timings.json`, `<label>.summary.json` and optional `.cpuprofile` /
`.chrome-trace.json`. Profiles can contain local paths: keep the work directory
out of version control.

The run fails unless every gesture produces one accepted edit with complete
visible-window measurement, refresh stays below `--max-refresh-ms` (100), and
autosave timer lateness stays below 100 ms; autosaved positions are checked
without forcing a save. Compare like with like (build mode, layout, project,
zoom, playback state, cache warmth, profiler flags); profiling adds overhead.
`e2e/electron/edit-latency.spec.ts` is the CI gate with synthetic dense markers.

## Manual capture

Set `WEFTCUT_EDIT_TRACE=1` before `npm run dev` (read at Vite build time, not
by a built executable), or run `localStorage.setItem('weftcut.debug.editTrace', '1')`
in DevTools (takes effect on the next edit; `'0'` disables). Drag 3–5 times,
≥ 3 s apart, with DevTools closed. Filter the terminal for
`[DEBUG-edit-latency]` and join JSON lines by `traceId`; lines are also in Help's
diagnostic export (`current/events.jsonl`). No project content, paths or entity
IDs are emitted. At most four observation windows run concurrently.

## Interpret

| Phase / stage | Measures |
| --- | --- |
| `renderer.invoke.*` | IPC invocation through the view-publication barrier or rejection; starts just after pointer release; excludes paint and save |
| `main.command.*` | Synchronous actor work; `commandAccepted` marks domain refusals |
| `recipe`, `reconcile_markers`, `reconcile_transitions` | Mutation and relationship maintenance |
| `produce_including_finalize` | The three above plus Immer finalize/freeze — **do not sum nested durations** |
| `locked_layer_check`, `stamp`, `validate`, `history_record`, `notify_subscribers` | Remaining commit costs |
| `main.summary` | Building the summary for the correlated refresh |
| `renderer.refresh / summary_ipc` | Waiting for that summary, incl. IPC and main queuing |
| `renderer.refresh / store_apply` | Synchronous store/index/selection work, before React render |
| `store_apply_to_two_raf` | Two rAF opportunities after applying; does not prove pixels were presented |
| `main.autosave / serialize`, `write_file`, `backup_and_gc` | Actual save costs |
| `main.autosave / timerLateMs` | Lateness of the 500 ms debounce callback — event-loop contention, not write time |
| `renderer.frames` | 2 s window from invocation: max rAF gap and offset, gaps > 50 ms, long tasks, visibility |

Durations use each process's monotonic clock; `startedAt` is wall-clock for
rough cross-process alignment only. Long invoke/summary waits with short main
stages → main-process queuing; long store/next-frame times or long tasks →
renderer work; large save stages ~500 ms after release → persistence.
`hiddenDuringWindow: true` voids frame comparisons. Autosave attributes a write
only to the latest traced edit; missing save lines alone do not mean saving
failed.
