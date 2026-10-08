# CI pre-push verification — 2026-10-08

Reviewed the two most recent `electron-ci` failures against local `main`
`2ebb08c3` (export finalization retry), based on upstream `76c5642a`.

## Findings

- [Run 37712381349](https://github.com/WeftCut/WeftCut/actions/runs/37712381349):
  the 4K Relaxed header-search test failed on both macOS and Windows, including
  retries. English text needed 61/58 px but received 18/0 px respectively.
  Linux and the checks/native jobs passed.
- The same run also had a Windows media-protocol timeout (60 s), followed by a
  worker teardown timeout (another 60 s). The test passed its retry in 1.61 s,
  but the worker error still fails the job. The uploaded report has no call
  stack or trace identifying whether launch, fetch or close stalled. This
  remains an unresolved Windows flake, not a confirmed media-serving defect.
- [Run 37639633512](https://github.com/WeftCut/WeftCut/actions/runs/37639633512)
  also failed the popup-layering script's Windows path comparison and the
  macOS small-dialog geometry test. Both pass in the newer run, so no further
  changes were made for those failures. Other retry-only failures from that
  older run did not recur in the newer run.

## Changes

The search failure reproduces on Linux using a 1024 px renderer viewport and
4K Relaxed: Chinese text needed 47 px but received 31 px; English could receive
zero. Removing the shortcut hint alone was insufficient for English because
the menus and right-hand controls already consumed the available width.

Search now retains its intrinsic text width. A header container query uses a
theme-relative breakpoint to hide the wordmark, locale text and shortcut hint
and reduce menu spacing in constrained windows. Menu labels, search text,
the locale globe and window controls remain available at the chosen font size.
Full chrome returns when the window grows.

The E2E regression exercises Chinese and English at 960, 1024, 1280, 1360,
1400 and 1800 px, including shrinking and growing back. It checks complete
search text, header containment, group separation and opening the search
palette. CDP sets the renderer viewport so host monitor dimensions cannot
silently remove this coverage.

The Windows media-protocol test now retains failing-attempt traces, records
launch/fetch/close as separate steps and closes Electron in `finally` after
request/assertion errors. No timeout was increased and no retry assertion was
weakened. These changes improve diagnosis; they do not establish a root-cause
fix for the Windows timeout.

## Local validation

- `npm run build:e2e`: passed.
- Layout-theme, window-chrome and media-protocol E2E: 8 passed, no retries.
- Final header-search and instrumented media-protocol E2E: 2 passed.
- Build-script tests with bundled FFmpeg on `PATH`: 94 passed, none skipped.
- `npm run typecheck`: passed.
- React Doctor changed-scope scan: no new issues, score 77 (unchanged).
- Narrow-header screenshot reviewed at 960 px; search, menus, locale control
  and caption buttons remain visible without overlap.

Logs and local E2E output are under `/tmp/weftcut-ci-*` and
`apps/desktop/reports/ci-header/`. The viewport tests ran in Linux Electron;
native macOS/Windows behavior still needs the next CI run. No push was made.
