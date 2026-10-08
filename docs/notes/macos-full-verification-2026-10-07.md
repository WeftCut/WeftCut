# macOS full verification — 2026-10-07

Follow-up: [defect triage on updated main](macos-defect-triage-2026-10-08.md).
The results below preserve the original full run.

The full local verification is **not green**. The full Electron suite produced
314 passes, 22 skips and nine failures. An isolated replay of all nine failures
passed four and failed five again. These are reproducible **test failures**;
the replay alone does not distinguish product defects from test geometry,
focus, timing or visual-oracle defects.

One separate product defect, model-download path resolution through directory
symlinks, was corrected and verified with the full unit suite.

## Environment and preparation

- Revision: `976fc8539c25607e52b6a99ed84ac9bfdf8a42c2`, followed by the
  model-download fix in this working tree.
- MacBookAir10,1, Apple M1, arm64, 8 GiB RAM; macOS 26.5.2 (25F84).
- CLI Node 24.20.0; pinned Rust 1.98.1; Electron 44.5.0; bundled FFmpeg 8.1.2.
- Rebuilt both native addons, their co-located decode libraries, WASM, the
  conformance analyzer and the E2E-enabled application.
- `--full`, `WEFTCUT_DECODE_E2E=1`, one Playwright worker, zero retries.
  Serial/GPU measurement gates completed before the other E2E project started.
- Fresh throwaway userData and synthetic media; the installed user's profile
  was not used. Browser, Electron, loopback and process-inspection checks needed
  execution outside the filesystem/process sandbox.
- With the user's authorization, removed old v0.0.0 package output and
  completed Rust compilation caches. Generated the DNxHR/MPEG-2 and 4K ProRes
  fixtures only when needed, then reclaimed the large finished fixtures.
  Test reports and failure evidence were retained.

## Results

| Check | Result |
| --- | --- |
| TypeScript typecheck, including after the path fix | Passed |
| Build-script tests, including real browser layering | 94 passed |
| Full final Vitest suite | 651 files passed; 8,907 tests passed, 3 skipped |
| Rust eval / conversion / core / analyzer / decode | 63 / 14 / 657 / 20 / 63 passed; 5 opt-in tests ignored |
| Rust formatting and workspace/all-target Clippy, warnings denied | Passed |
| Full serial Electron project | 31 passed, 17 skipped, 1 failed; 3.6 minutes |
| Full other Electron project, also one worker | 283 passed, 5 skipped, 8 failed; 28.1 minutes |
| Independent replay of the nine failures | 4 passed, 5 failed again |
| Float16 effect pool and real WebGPU sharpen parity | Passed |
| Maximum-zoom ruler count, 10 s / 1 h / 24 h + scroll | 58 nodes throughout; ceiling 145 |
| Supplemental 4K ProRes software-preview memory ratchet | Passed: 424 → 411 MB, −13 MB; growth ceiling 30 MB |
| Production arm64 package and afterPack gates | Passed; `release/WeftCut-mac-arm64.dmg`, 231 MB |
| Deep/strict application signature verification and DMG checksum | Passed |
| Production `.app` startup with isolated userData | Passed; visible welcome screen, version 0.3.1, no renderer page errors |
| Native modules and bundled hardware encoder inside the package | Core and decode loaded; software/VideoToolbox capabilities; H.264 VideoToolbox sidecar encode passed |

The memory check proves its retained-memory assertion over two seek sweeps;
it does not establish smooth 4K playback throughput. VideoToolbox H.264 preview
SSIM was 0.982047 and HEVC Main10 was 0.997468. Native export overlap, backward
clip reuse, EOS tail, slow-consumer credit, 10-bit precision and ProRes fidelity
checks passed. Audio synchronization/mixing, CJK export, resource admission,
reopen/reload recovery and external MCP connection gates also ran.

The production app's E2E hook was absent as expected. Its embedded runtime was
Node 24.21.0 / Chromium 152.0.7977.130. Package startup was from the generated
`.app`, not an installation into `/Applications`; DMG integrity was verified
separately. The final build left `out/` as a production build: rebuild with
`npm run build:e2e` before any future E2E replay.

## Corrected model-download defect

`model-downloads.ts` resolved an existing download root with `realpathSync`, but
resolved a missing artifact lexically. On macOS `/var` points to `/private/var`,
so a valid missing artifact appeared outside its own resolved root. This broke
byte accounting after deletion and ownership checks for not-yet-existing files.

Missing paths now resolve through their nearest existing ancestor. Errors other
than missing-path errors still propagate, and catalog directories redirected
outside the owned root are still refused. A portable symlink-root regression
covers partial-only, missing, installed and removed artifacts; all six tests in
the file and the full final unit suite passed.

## Failures that reproduced independently

| Test | Evidence |
| --- | --- |
| `composition-tabs.spec.ts:159` | Expected two menu popups, found one. Full run failed during pointer entry; replay reached the later keyboard ArrowRight step and failed there. |
| `keyframe-effects.spec.ts:36` | Clicking the first keyframe timed out: the curve's transparent segment hit target, and sometimes the sticky header, intercepted the requested point. |
| `motif-params-page.spec.ts:218` | Before clicking the preset, frame-height minus page-height stayed 240 rather than 0 for 15 seconds. Preset/undo assertions were not reached. |
| `pauses.spec.ts:488` | The expected “Detect pauses in selected clip…” menu row was absent, or disappeared before its disabled-state assertion. |
| `timeline-selection-focus.spec.ts:22` | The secondary clip screenshot contained zero rows matching the test's fixed blue selection color; expected at least one. The full-window screenshot visibly paints the outline at RGB `(78,129,238)` versus the oracle's `(59,130,246)`: its red-channel difference of 19 exceeds the strict `<10` tolerance. This establishes a visual-oracle mismatch in that screenshot, not a missing outline; the P3 display's precise role remains untested. |

Local tickets and exact replay commands are in
[the verification map](../../.scratch/mac-full-2026-10-07/map.md).

Four first-run failures passed in the isolated replay: crop live-drag screenshot
count, Prefer Proxies routing, Alt-drag keyframe scaling and populated-track
reordering. They remain intermittent-test findings; no retries concealed the
first-run failures. The crop failure used a zero-red-pixel baseline and then
asserted `0 < 0`; its independent replay completed the crop export pixel checks.

## Skips and coverage boundaries

The 22 full-run skips consisted of Windows/D3D11-only tests, unavailable
non-Mac hardware lanes, base-M1 ProRes hardware decode, the initially missing
4K ProRes fixture, and two window-restoration tests. The 4K fixture was generated
afterwards and its memory test passed. The display work area was 1280×681;
position/size and maximized restoration require at least 1100×760, so those two
remain unverified. Window visibility, no-drift and off-screen rejection passed.

No Intel Mac or other Apple Silicon model was tested. Installed-model live
inference, the Stryker mutation campaign, the entire throughput benchmark matrix,
and long-duration editing sessions are outside this run. Packaging checks do
not by themselves test a quarantined download's Gatekeeper approval flow.

## Artifacts

Durable, ignored evidence is under
`apps/desktop/reports/mac-full-2026-10-07/`:

- `unit.json`: first full run, including the two path failures.
- `unit-final.json`: sandbox-restricted attempt; loopback EPERM failures are
  environmental and are superseded by `unit-verified.json`.
- `unit-verified.json`: final full unit run after the fix, outside the sandbox.
- `e2e-{serial,parallel}.json` and matching `*-artifacts/`: complete initial E2E.
- `failed-replay-{serial,parallel}.json` and matching `*-artifacts/`: independent
  failure replays with step traces. Electron traces here record test steps;
  they do not include ordinary browser-context screencast snapshots.
- `memory-4k.json`, native/build/lint logs, shader/ruler logs, `stages.json` and
  `supplemental-stages.json`: additional checks and command exit statuses.
- `run-checks.py`, `run-supplemental.py`, `packaged-smoke.mjs`: the actual local
  orchestration and package smoke check.
- `package.log`, `package-signature.log`, `dmg-verify.log`,
  `packaged-smoke-verified.log`, `packaged-smoke.json` and `packaged-smoke.png`:
  production package evidence. The smoke harness required ESM-compatible
  built-in module access and canonical temporary-path comparison; its initial
  harness failures are superseded by the final successful run.
