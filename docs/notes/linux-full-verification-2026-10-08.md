# Linux full verification — 2026-10-08

The full verification is **not green**. Resource and configuration persistence,
shared admission, reload cleanup, single-slot exports and real-keyring storage
passed. Two low-memory export cases fail reproducibly during final mux. Two
ProRes/Lite cases expose an original-capability probe lifecycle defect.

Follow-up: the low-memory finalization defect was subsequently fixed and verified
in [export finalization verification](export-finalization-verification-2026-10-08.md).
The results below describe the original revision, before that fix.

## Environment and scope

- Revision: `76c5642ad8be9b5eafdf369ba885d6f48603a815`; no application source changes.
- Linux Mint 22.3, x86_64, Intel i5-13400 (16 logical CPUs), 31,719 MiB RAM.
- Node 24.18.0, pinned Rust 1.98.1, Electron 44.5.0.
- GPL sidecar FFmpeg `n7.1.5-2-g998de74adf-20260718`, retained from this
  workstation's existing resources; LGPL decode libraries use the n8.1 family.
  This is not a fresh-download validation of the newer n8.1 GPL sidecar URL.
- Synchronized stale npm dependencies with the existing lockfile; fetched missing
  locked Rust dependencies and installed the matching Clippy component.
- Rebuilt core/decode addons, WASM, conformance analyzer and E2E application.
- Full `@matrix` tier, native decode enabled, one worker, zero automatic retries.
  Serial machine-exclusive checks finished before the other project started.
- Throwaway userData, synthetic projects and media; real user projects/config
  were not used. Browser/Electron and loopback checks ran outside the execution
  sandbox after its socket restrictions were confirmed.

## Results

| Check | Result |
| --- | --- |
| TypeScript | Passed after forced regeneration of stale incremental outputs |
| Build-script tests, including real browser layering | 94 passed |
| Vitest | 654 files; 8,930 passed, 3 Windows-only skips |
| Rust eval / conversion / core / analyzer / decode | 63 / 14 / 657 / 20 / 56 passed; 5 opt-in tests ignored |
| Rust formatting and workspace/all-target Clippy with warnings denied | Passed |
| Full serial Electron project | 29 passed, 26 skipped, no failures; 4.8 minutes |
| Full other Electron project | 283 passed, 7 skipped, 14 failed; 39.3 minutes |
| Independent replay of 12 failures with existing Linux CI image thresholds | 10 passed, 2 low-memory export failures repeated |
| Minimal ProRes/Lite reproduction | Failed; bypassing only the proxy-presence probe filter in a debugger made it pass |
| Real-keyring configuration E2E supplement | 4 passed |
| Normal Electron key persistence through the actual keys module | Passed: encrypted write, read in a new process, clear |
| Maximum-zoom ruler, 10 s / 1 h / 24 h and scroll | 62 nodes throughout, ceiling 150 |
| Independent Float16/WebGPU gate | Blocked by EGL initialization failure; no precision verdict |
| 4K ProRes memory ratchet | Passed: 521 → 507 MB, ratchet −14 MB against a +30 MB ceiling |
| Production build and Linux packaging | Passed: AppImage and amd64 deb; afterPack checks passed |
| Packaged application smoke check | Passed: startup, native addons, settings, new project and visible text preview; software graphics only |

The initial typecheck saw TS6305 because `npm ci` removed declaration outputs
under node_modules while old `.tsbuildinfo` files remained. `tsc -b --force`
passed without source edits. Initial missing npm/Cargo dependencies and sandbox
browser failures were setup failures, not application regression results.

## Resource and configuration evidence

Passed checks include resource intent surviving restart, host-scaled defaults,
numeric-overflow rejection without leases, shared native/renderer admission,
excess rejection and release on renderer reload. Both audio-only and video
export completed with a single processing slot. Resource settings remained
independent of decode quality; defaults retained saved test evidence and legacy
cache values did not become an application memory limit.

The process-tree memory test measured 885.8 → 1311.8 → 915.8 MiB around creation
and teardown of child/grandchild processes. Their independently measured RSS
total was 394.4 MiB. This passed the test's accounting/teardown tolerances.

Model configuration, failed-candidate activation preserving the current model,
managed-download clearing that preserves user files/profiles, all six layout
theme tests, diagnostic export and forced-termination recovery passed.

The initially absent 4K ProRes fixture was generated and its skipped memory
ratchet case was run separately. The second settled floor was 14 MB below the
first, within the +30 MB allowance.

## Reproducible findings

### Original capability probe stops once a proxy exists

`decode-engine.spec.ts:507` and `:543` fail to show UnsupportedClipCard for
ProRes in Lite, both when Lite is selected before import and when switching
from an existing Standard preview. A separate small reproduction also fails
when the file starts inside the project, without a source-copy path change.

Debugger logpoints show available resources and the resolver permanently at
`webcodecs decodability untested`. A summary update can cancel the original
probe; once a quick proxy exists, `sourcesNeedingPreviewProbe` excludes the
source because its legacy preview path is no longer null. Lite's original-source
selection still needs that capability verdict.

Changing only this filter's temporary resolved preview path to null in the
diagnostic process made the same reproduction pass in 5.8 seconds. The actual
ProRes decoder config (`apcn`) was inspected and the unsupported verdict reached
the card. This is causal diagnostic evidence, **not a fix or a passing test of
the unchanged application**.

Follow-up: [probe lifecycle issue](../../.scratch/linux-full-2026-10-08/issues/01-lite-original-probe-stops-after-proxy.md).

### Low-memory export stalls at pressure-gated finalization

`export-resource-admission.spec.ts:68` and `:109` fail both initially and on
independent replay with the same 2304 MiB memory target. All 180 frames complete,
then `mux_export` reports resources busy. The managed ledger is empty; sampled
pressure is still constrained.

RSS was 1851.5 / 1882.6 MiB initially and 1863.3 / 1872.9 MiB on replay, above
the 1843.2 MiB hysteresis recovery threshold even though below the 2304 MiB
target. Approximately 24 GiB of system RAM remained available. The immediate
cause is pressure admission rather than outstanding managed leases. The peak
that entered pressure and the owner of the retained Chromium memory still need
a lifecycle trace; do not conceal this failure with larger test budgets.

Follow-up: [finalization pressure issue](../../.scratch/linux-full-2026-10-08/issues/02-low-memory-export-finalization-pressure.md).

## Environment and first-run-only findings

The loaded NVIDIA kernel driver is 595.91.07, while the NVML library is 595.99.
`nvidia-smi` exits 18 with `Driver/library version mismatch`. Electron reports
software/unavailable graphics features; the independent graphics gate cannot
initialize EGL. NVIDIA hardware decode tests skip. VAAPI did engage: color,
frame ordering, H.264 SSIM (0.982976), eight preview reopen cycles and recovery
after an intentional GPU-process crash passed. Hardware rendering on the RTX
3050 remains unverified until the driver installation is coherent.

The production `linux-unpacked/WeftCut` executable also started with a fresh
profile, without the E2E `--enable-unsafe-swiftshader` argument. Native addons
loaded, settings were readable, the E2E hook was absent, and a new project
displayed the text “Linux preview” (screenshot inspected). No renderer errors
were captured. Its GPU status nevertheless showed software compositing and
disabled WebGL/WebGPU; `getGPUInfo` reported that GPU access was disabled due to
frequent crashes. This is a basic software-preview pass, not hardware graphics
validation. The first smoke attempt stopped at that diagnostic API exception;
the rerun retained it as evidence and completed the preview checks.

AppImage (336 MiB) and deb (267 MiB) creation passed, including native-library,
licensing and skill packaging checks. The deb metadata identifies version 0.3.1
and architecture amd64. The packaged executable was exercised directly; no
system package was installed. The builder warned that `desktopName` was unset,
so installed taskbar association remains unchecked.

Eight initial image-conformance failures match the repository's documented
software-raster signature: BT.709 limited maximum error 12 and H.264 SSIM around
0.673–0.675 with correct frame alignment. All eight passed independent replay
using **existing** Linux CI values `WEFTCUT_E2E_COLOR_FAITHFUL_MAX=16` and
`WEFTCUT_E2E_SSIM_FLOOR=0.62`. No assertion or image floor was edited.

Two UI failures passed replay: preview click focus (`focus-regions.spec.ts:88`,
expected region `preview`, observed null), and property title editing
(`property-panel.spec.ts:7`, expected `Opening title`, observed `Opening titlec`).
Their causes remain unconfirmed; the initial failures are retained.

Playwright's Electron loader forces `--password-store=basic`, causing three
keyring cases to skip despite the desktop Secret Service being present. A
diagnostic copy of the original cloud/VLM specs, with only that startup override
removed, passed all four cases against `gnome_libsecret`, including plaintext
legacy-key migration and removal. Application code and original specs were not
changed. A separate normal Electron process also verified encrypted persistence
through the actual `keys.ts` implementation with a synthetic key.

Other full-run skips are Windows/D3D11 or macOS-specific cases, unavailable
hardware lanes, the initially missing 4K fixture, and maximized-window restoration
(the current window manager did not honor the test's maximize request).

Installed-model live inference, Stryker's mutation campaign, the complete
throughput benchmark matrix, cross-OS determinism comparison and long-duration
editing sessions are outside this run. PBT tests in the normal suites did run.

## Evidence

Ignored artifacts are under `apps/desktop/reports/linux-full-2026-10-08/`:

- `environment.json`, `stages.json`, `e2e-stages.json`, `supplemental-stages.json`.
- `unit.json`, `e2e-{serial,parallel}.json` and their original failure artifacts.
- `linux-calibrated-replay.json` and retained failure traces.
- `prores-*.json` and the explicitly named temporary diagnostic spec/config.
- `process-tree-memory.json`, `electron-gpu.json`, `nvidia-driver.txt`.
- `keyring-check.log`, `keyring-e2e.json` and copied diagnostic-only test harness.
- `memory-4k.json`, `packaged-smoke.json`, `packaged-editor.json` and screenshots.
- `package-metadata.txt` with artifact checksums; `run-*.py` verification runners.
- Native, lint, build, ruler, graphics, memory and packaging logs.

No changes were committed or pushed.
