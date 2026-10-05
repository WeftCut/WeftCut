# Machine performance settings

Open **Settings → Performance** to edit this machine's resource policy.
Changes persist in `<userData>/app_settings.json` under `performance`, across
projects and restarts. Edits save automatically. Restore defaults resets only
performance settings and clears accepted test presets. Windows installations
also include an explicitly experimental playback test.

## Simple settings and presets

The Performance pane opens with **Less / Standard / Maximum**, an experimental
test action, then a collapsed **Advanced settings** section. Advanced exposes
all nine numeric fields and Restore defaults. Separate cache/parallel controls
have been removed.
Expanding or collapsing Advanced does not change any setting.

Maximum deliberately uses the existing shipping budgets. Standard and Less
reduce these fixed budgets; they are resource preferences, not measured machine
tiers. Maximum does not claim to exhaust available hardware or guarantee smoother
playback. Smaller hardware admission limits can shift decoding to the CPU, so
Less does not promise lower total CPU use.

`shared/performance-presets.ts` owns the complete mapping:

| Setting | Less | Standard | Maximum |
| --- | ---: | ---: | ---: |
| Accelerated videos | 2 | 3 | 5 |
| Combined original pixel area | 8,294,400 | 16,588,800 | 24,883,200 |
| Frames buffered per accelerated video | 3 | 3 | 3 |
| Video frame cache (MiB) | 512 | 768 | 1024 |
| Animation frame cache (MiB) | 256 | 384 | 512 |
| Animation graphics memory (MiB) | 64 | 96 | 128 |
| Animation buffer sets | 4 | 6 | 8 |
| Thumbnail cache (MiB) | 80 | 120 | 160 |
| Waveform cache (MiB) | 16 | 24 | 32 |

- Selecting a full preset replaces **all nine** performance values in one atomic
  settings patch, including previous Advanced edits.
- Built-in selection requires all nine fields to match; manual edits can show
  Custom. With accepted test presets, selection compares the two calibrated
  fields. The chosen tier is retained when small capacities make tiers equal.
- Resolved values are persisted. Opening the panel, upgrading a
  preset table or recognizing a selection does not rewrite existing values.
  Existing budgets stay unchanged; the previous default now displays Maximum.
  Reselecting a preset explicitly applies its current mapping.
- These controls do not change preview resolution, decode-engine preference,
  export quality or other settings. Saving still uses the shared runtime interface.

## Experimental test

**Test this computer (experimental)** pauses editor playback and launches an
isolated app process with a visible test window. Progress and Cancel remain in
Settings. Closing Settings does not abandon the process; reopening it restores
progress. Closing the app cancels its owned test. Other applications and retained
editor resources can still affect results.

The fixed H.264 4K/60 fps test takes about two minutes on the development machine.
No history or hardware model chooses stages. Completion never changes settings.
**Use test presets** atomically stores the candidate family under
`performance_calibration`, selects Standard, and patches only video count and
combined picture size. Subsequent Less/Standard/Maximum choices preserve the
other seven values. Invalid or cancelled runs cannot be applied; an all-slow
result explicitly offers conservative presets rather than a claimed pass.

The UI warns that results are experimental and may differ from real projects.
See [the measurement protocol](controlled-playback-calibration.md) for the known
editor/test-host discrepancy and thresholds. Accepted presets survive restarts
but are never consulted when a new test selects its plan.

## Numeric settings

`apps/desktop/src/shared/performance-settings.ts` owns the defaults, units,
integer ranges, disk recovery and runtime validation. Existing shipping values
are defaults, not a claim that every machine supports that workload.

| Field | Default | Allowed range | When a change takes effect |
| --- | ---: | ---: | --- |
| `preview_gpu_sessions` | 5 | 0–32 | Next preview hardware admission; 0 stops new admissions |
| `preview_gpu_pixel_area` | 24,883,200 pixels | 1–530,841,600 | Next preview hardware admission |
| `preview_gpu_pool_slots` | 3 | 1–16 | Next GPU decoder session open |
| `frame_ring_mib` | 1024 MiB | 128–8192 | Next frame-ring backpressure check, shared across live rings |
| `motif_cache_mib` | 512 MiB | 16–4096 | Next new frame insertion in existing default Motif caches |
| `motif_gpu_mib` | 128 MiB | 16–2048 | Next Motif GPU allocation |
| `motif_gpu_sessions` | 8 | 1–32 | Next Motif GPU allocation |
| `filmstrip_cache_mib` | 160 MiB | 16–2048 | Next thumbnail tile insertion |
| `waveform_cache_mib` | 32 MiB | 4–512 | Next waveform tile insertion |

MiB means 1,048,576 bytes. Pixel area is the sum of coded width × height,
displayed in the settings pane as megapixels (one million pixels per unit),
calibrated at 30 fps; it is neither a pixel rate nor detected GPU capacity.
Changing it does not change image resolution. Raising the session count alone
does not bypass the independent pixel-area limit. Preview pool VRAM grows with
both admitted area and texture slots; the performance HUD reports live usage
and current admission limits.

Lowering a limit does not revoke existing decoder leases or tear down textures
still being read. Usage can temporarily exceed a new limit. New admissions wait
for capacity or follow the existing software/CPU fallback. Increasing a limit
makes it available to subsequent admission attempts; it does not forcibly reopen
current software sessions. Existing decoder sessions keep their texture pool.
Diagnostic callers that explicitly supply a pool size keep that override.

Cache sizes are targets, not total-process memory caps. Frame rings preserve
their forward-frame floor and time-based lookbehind, Motif caches defer disposal
of pinned pictures, and tile caches protect the tile just delivered. Smaller
decoded-frame budgets can increase long-GOP re-seek cost. Idle caches may retain
their old contents until another insertion or normal eviction. Explicit
constructor budgets used by isolated caches and tests remain fixed.

## Runtime interface

Use the existing app-settings interface, so UI and future machine detection
share validation, persistence and notifications:

```ts
// Renderer: reads the saved profile through the existing appSettingsGet().
// setAppSettings also hydrates this renderer after the successful IPC reply.
await setAppSettings({
  performance: { preview_gpu_sessions: 3, frame_ring_mib: 512 },
});
await setAppSettings({ performance: null }); // restore performance defaults
```

IPC equivalents are `app_settings_get` and
`app_settings_set({ patch: { performance: { ... } } })`. Main-side detection
should use the same app-settings command path to broadcast to all windows;
calling a store directly does not send the `app_settings:changed` event.

Patches merge per field against persisted state, so independent edits from
different windows are retained. Runtime writes reject unknown keys, non-integers,
non-finite numbers and out-of-range values before writing anything. Old or
malformed disk fields recover individually to defaults. A failed disk write
does not publish a new runtime snapshot. The main process seeds its snapshot
before setting up consumers; renderers hydrate theirs on initial settings load
and every settings event. Consumers read `performanceSettings()` at the point
where policy is needed; they must not capture shipping defaults as live limits.

## Scope

This interface covers preview GPU admission/pools, decoded-picture retention,
Motif memory/transport pools and timeline caches. Native disk-cache limits,
background-job concurrency, audio scheduling and readback lane counts remain
separate. Extending them needs the same lifecycle treatment, including native
configuration plumbing where applicable. Protocol sizes, frame-retention floors,
color conversion, texture acknowledgments and synchronization barriers are
correctness constraints and are not exposed as machine tuning options.

See [ADR 0099](adr/0099-machine-performance-budgets-are-runtime-settings.md).
