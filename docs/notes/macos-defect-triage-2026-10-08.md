# macOS defect triage — 2026-10-08

Follow-up to [the full Mac verification](macos-full-verification-2026-10-07.md).
The original run and its failures remain recorded there; this report separates
confirmed product defects from test defects and failures that no longer reproduce.
Final affected-case verification is green: 91 Electron runs, 8,930 unit tests,
94 build-script tests and typecheck passed. Two intermittent findings retain
unconfirmed root causes despite passing all final replays.

## Baseline and preservation

Fetched `origin/main` and fast-forwarded local `main` from `976fc853` to
`d1db8020`. The four incoming commits introduced resolution/layout presets,
track-divider highlighting and popup placement/anchor fixes. Local investigation
changes were backed up, stashed and reapplied without conflicts. The recovery
stash `mac-triage-before-main-2026-10-07` remains available.

The same M1 MacBook Air, macOS 26.5.2 and Electron 44.5.0 were used. Tests used
synthetic media and isolated temporary profiles, one worker and no retries.
Available disk space ranged from about 6.5 to 3.1 GiB; this remained sufficient
for the follow-up checks, so no additional cleanup was needed.
Native code and dependencies did not change in this follow-up.

## Confirmed product defects and corrections

| Finding | Evidence and correction |
| --- | --- |
| Programmatic scrolling moved the entire workspace | Revealing a timeline keyframe moved `.dock-workspace.scrollTop` to about 478 and the timeline above the window. `overflow: hidden` permits programmatic scrolling. Workspace/panel shells now use `overflow: clip`; their explicit inner scroll viewports still scroll. The effect-keyframe workflow checks that the inspector remains in view. |
| A clip context menu disappeared immediately after opening | A queued scroll notification from revealing the clip arrived after its context menu opened. The global capture listener also dismissed menus when another panel or the popup scrolled. Dismissal now observes the timeline viewport and requires its position to have changed since opening. Unit coverage retains dismissal on actual movement and rejects unrelated/unchanged scroll events. |
| Motif parameter page sometimes stayed blank | The opaque-origin iframe loaded its controls and received initialization, but HTML/body/page had no layout rects: page height stayed zero while the host frame was 240 px. Dockview can mount a portal before its container attaches. The frame now navigates only after it is connected with a nonzero viewport. A detached-container regression covers that boundary; sandbox permissions remain `allow-scripts` only. |
| Prefer Proxies reported a proxy while still decoding the original | Reproduced twice in ten diagnostic runs. Both backend and renderer settings were correct, and `builtFromKey` named `webcodecs:proxy`, but the actual source was VideoToolbox/NV12. An import-copy path change had already completed a swap into the fixed `#swap` slot. The next swap reacquired that occupied slot and reused its original decoder. Swaps now alternate free layer slots, release the actual old slot and include target identity in shared media keys. Synchronous first-frame completion also clears its poll timers. |
| Model-download paths through a symlinked root | Previously corrected during the full verification: nonexistent artifacts now resolve through the nearest existing ancestor, handling macOS `/var` → `/private/var` consistently. The ownership boundary remains enforced. |

The decode regression drives an import-path move followed by repeated
original/quick-proxy switches through a pool that reproduces occupied-slot
reuse. It checks actual engine/path, disposal of all old sessions and poll
cleanup. Restoring the old slot reuse/release behavior makes this regression
fail at the engine assertion. The Electron case additionally checks two full
proxy→original→proxy cycles while paused, without extra seeks between switches.

## Test defects corrected

| Test | Correction and retained assertion |
| --- | --- |
| Anchor submenu | Wait for the root popup's focus before ArrowDown, then the trigger's focus before ArrowRight. Diagnostic key events previously reached a Dock tab before popup focus settled. The outside click now uses an exposed part of the ruler. Pointer entry, keyboard submenu opening and outside dismissal remain asserted. |
| Effect keyframe click | The rotated 7 px diamond's bounding box includes empty corners; Playwright also adds the border to its requested position. Choose a point inside the visible diamond with the border offset accounted for. Locator actionability remains enabled; easing, drag, undo and instance identity checks remain. |
| Selection outline screenshot | A fixed sRGB blue failed on the Mac PNG's display-profile bytes. Independently painted token swatches calibrate the screenshot color; tolerance and relative line-thickness assertions stay unchanged. Hiding the actual primary outline must produce zero painted rows as a negative control. |
| Crop live-drag screenshot | The red video was visibly present, but the old green-channel cutoff of 40 excluded P3 `(234,51,35)`. The area oracle now accepts saturated red in the measured sRGB/P3 range and requires a nonzero baseline. Drag reduction and Escape restoration remain measured on screenshots; the export pixel checks remain unchanged. A CSS swatch was unsuitable here because its red differed from the video surface's `(255,24,0)` in the same screenshot. |
| ProRes decoder identity | Wait for the asynchronous import copy and renderer path update before comparing source identities. This prevents the legitimate external→`Media/` path move from being mistaken for an automatic proxy swap. The actual engine and full identity equality are still checked. |
| Popup-layering build-script scanner | Updated main introduced wrappers that forward their caller's class. The old scanner checked only raw `*.Positioner` tags and falsely rejected those delegates, while missing wrapper call sites. The scanner now verifies delegate forwarding and checks every raw/wrapped call site. Removing the layer class from `AppSelectPositioner` makes the corrected guard fail; all 94 script tests then pass with source restored. |
| New layout-theme dialog test | macOS restored the native 4K theme's 1280 px minimum after a forced 1000 px window resize. Use a 1000 px CDP viewport for the responsive dialog check. Native window minimums have their own independent test; typography, dialog containment and persisted settings assertions remain. |

## Verification

| Check | Result |
| --- | --- |
| Final related Electron run, all cases in eleven specs | 36 passed; no skips/failures/retries |
| Five-repeat run of original failures + layout/ProRes cases | 55 passed; no skips/failures/retries |
| Connected-frame stability experiment before integration | 10 preset/undo runs passed |
| Final full Vitest | 654 files passed; 8,930 tests passed, 3 skipped |
| Final TypeScript typecheck | Passed |
| Build-script tests, including real-browser popup layering | 94 passed, zero skips |

Before final integration, the connected-frame implementation passed ten
consecutive parameter-preset Electron runs. The swap/frame targeted unit
suites passed 14 and 30 tests respectively.

The focused Electron run covers all cases in eleven affected spec files,
including all decode-engine, layout-theme, popup-overflow, pause, composition,
keyframe and crop workflows. A separate five-repeat run selects the original
nine failures plus the new layout/ProRes cases. These runs do not replace the
historical full-suite result or repeat the native/package gates whose code
did not change.

Alt-drag keyframe scaling and populated-track reorder each passed the related
run and all five final repeats, following their initial independent replay.
Their original root causes remain unconfirmed; passing focused repeats establishes current replay behavior,
not a proven fix for those two intermittent findings.

## Evidence

Ignored, preserved artifacts are in
`apps/desktop/reports/mac-triage-2026-10-07/`:

- `main-baseline*`, `race-baseline*`, `params-detail*` and `related-full*`:
  pre-fix results and detailed event/frame diagnostics.
- `proxy-debug.json`, `proxy-debug-failure-{1,2}.json`: original decoder reuse
  despite correct preference and proxy identity; diagnostic timeout was
  shortened to 20 seconds only for this experiment, then restored.
- `crop-empty-preview.png`, `crop-empty-state.json`: visible red video excluded
  by the experimental CSS-reference oracle, with live preview/source probes.
- `params-attached.json`: ten connected-frame preset checks, all passed.
- `unit-source-swap-negative-control.log`: the new regression fails when the
  old occupied-slot behavior is restored; fixed source was restored afterward.
- `unit-complete-verified.{json,log}`, `typecheck-final.log`,
  `scripts-verified.log`: final broad quality checks. `scripts-final.log`
  preserves the earlier scanner failure; `popup-guard-negative-control.log`
  proves that a missing caller class is still rejected.
- `verification-summary.json`: final counts and revision.
- `verified-related-*`, `verified-repeat-*`: final Electron JSON/logs and
  preserved output directories; `run-verified.py` records their exact commands.

Temporary diagnostic hooks/helpers were removed. The local output application
is currently built with E2E enabled; the production package described in the
original report predates these follow-up changes.
