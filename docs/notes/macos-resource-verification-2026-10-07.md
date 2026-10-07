# macOS resource-management verification — 2026-10-07

Physical-machine verification of ADR 0101/0102 and the recent resource/settings
changes, based on `30c7b9b9` plus the fixes described below. Tests use rebuilt
native addons and an E2E-enabled development app, isolated temporary profiles
and synthetic media. The installed user's profile is untouched.

## Environment and effective allocation

MacBookAir10,1, Apple M1, arm64, macOS 26.5.2 (25F84), 8192 MiB RAM,
eight available logical processors. Electron 44.5.0, Chromium 152.0.7977.130,
embedded Node 24.21.0; build/test CLI Node 24.20.0; Rust 1.98.1;
FFmpeg sidecar 8.1.2; sysinfo 0.37.2.

| Automatic allocation | Actual value |
| --- | ---: |
| Memory target | 2816 MiB |
| Picture retention | 704 MiB |
| Working allowance | 1126 MiB |
| Export stream allocation, within working memory | 352 MiB |
| Controlled CPU threads | 4 |
| Threads per task | 2 |
| Background job ceiling | 2 |
| Temporary cache target | 2048 MiB |

The job ceiling is not guaranteed concurrency: thread, memory, playback and
pressure admission can reduce it. A saved 3072 MiB/low-effort configuration
survived full application exit/relaunch, including its 1024 MiB disk target and
background-playback flag. Invalid edits did not replace it. Switching to high
effort yielded six controlled threads, three per task and three background-job
slots while preserving memory/disk intent and decode-engine selection.

The shell initially selected Node 22.23.1 and had outdated/missing npm packages;
the native addons were September builds. Verification used the installed Node
24, `npm ci`, Electron installation, the pinned Rust toolchain and rebuilt core,
decode and WASM artifacts. Future local commands should select Node 24 or later.

## Reproduced defects and corrections

1. **Cache eviction followed directory symlinks.** With a filmstrip hash
   directory linked to an unrelated temporary directory, a zero-budget sweep
   deleted the external JPEG. The new regression failed before the fix. Sweeps
   now skip links at the cache root, category roots and nested entries. External
   bytes and link cycles are excluded from quota accounting. Three Unix
   regressions cover these boundaries. This protects existing links, not races
   against another process actively replacing directory components.
2. **NAPI resource claims could wrap.** `resourcesReserve(0, 4294967296)` was
   accepted with zero MiB charged; `4294967360` charged only 64 MiB despite a
   1126 MiB working allowance. IPC allowed these safe JS integers. IPC now rejects
   values above uint32 range, and native receives doubles and validates ranges,
   integers and finiteness before conversion. Both paths reject the original
   reproducers; native also rejects fractional, negative, zero-memory and
   non-finite claims. Valid caller argument types remain JS numbers.
3. **Mac graphics identity was missing from Settings.** The capacity probe is
   Windows-specific, so M1 showed an unidentified adapter and unidentified
   dedicated memory. An additive `graphics` field now carries Electron's active
   adapter identity and a memory-kind fact independently of native capacity.
   Complete GPU information is queried lazily and cached; Mac basic information
   before GPU startup contained only vendor ID `0x106b`. Settings displays
   `Apple M1` and shared graphics memory. No dedicated capacity is inferred and
   no allocation or test-profile provenance changes.

## Physical-machine evidence

After the resource fixes, the descendant-memory test sampled 550.5 MiB before,
863.9 MiB with two live descendants and 558.0 MiB after teardown. Independent
child/grandchild RSS totaled 303.8 MiB, consistent with the 313.4 MiB sampled
increase and ordinary Chromium drift. Available host RAM remained positive;
the sampler uses available/reclaimable memory rather than raw free pages.

Resource E2E passed the 2304 MiB 1080p export, 10-bit precision/EOS, long-GOP
preroll, sequential decoder release, cancellation followed by another export,
single-slot audio/video import and export, reopen/cache adoption, renderer
reload release, actionable rejection and settings persistence cases. Export
buffer peaks remained within the fixed 24-frame window.

VideoToolbox H.264 preview SSIM was **0.982047** (floor 0.96); HEVC Main10 was
**0.997468** (floor 0.98). Base M1 ProRes hardware decode was unavailable and its
hardware-only cell skipped as expected. Native ProRes export completed 300
frames with a native decoder engaged and passed identity/alignment/SSIM checks.
The skip does not represent a hardware ProRes pass.

The experimental calibration API reports `available: false`, reason `platform`,
on this Mac. Settings disables its button and states that the test currently
requires Windows. Windows calibration recommendations do not certify macOS.

## Checks and artifacts

- 90 targeted TS tests passed, including graphics identity/UI and IPC overflow.
- 94 build-script tests passed after dependencies were synchronized.
- 34 Rust cache tests and 14 resource/MCP-resource tests passed.
- 17 resource/settings Electron tests passed after the admission/cache fixes.
- Three native codec Electron tests passed; one expected ProRes hardware skip.
- Settings/graphics E2E was rerun after the portable graphics interface change.
- TypeScript build, E2E build, workspace/all-target Clippy with warnings denied
  and Rust formatting passed.
- `npm audit --omit=dev` reported zero known production dependency advisories.

Local JSON results, screenshots and logs are retained under the ignored
`apps/desktop/reports/mac-resource-2026-10-07/` directory. Resource results use
`resource-final-{serial,parallel}.json`, codec results `native-{serial,parallel}.json`,
and the final graphics/settings checks `settings-{serial,parallel}.json`.

Representative commands, after selecting Node 24:

```sh
npm run e2e -- resource-machine.spec.ts performance-settings.spec.ts resource-single-slot.spec.ts export-resource-admission.spec.ts import-reopen.spec.ts --workers=1
npm run e2e -- preview-hw-conformance.spec.ts export-native-wedges.spec.ts --grep 'videotoolbox|baseline: a single native ProRes' --workers=1
npm run e2e -- resource-machine.spec.ts performance-settings.spec.ts --workers=1
```

Rust commands run from `apps/desktop`, with two build jobs on this 8 GiB host:

```sh
CARGO_BUILD_JOBS=2 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path native/Cargo.toml --lib --features test-noop cache::
CARGO_BUILD_JOBS=2 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path native/Cargo.toml --lib --features test-noop resources::
FFMPEG_DIR="$PWD/resources/ffmpeg-lgpl/mac" CARGO_BUILD_JOBS=2 cargo clippy --manifest-path native/Cargo.toml --workspace --all-targets -- -D warnings
```

This covers the current development runtime on one base M1. Installer/signing,
Intel Macs, other Apple Silicon models, long-duration workloads and large local
model inference were not exercised. Memory/CPU targets remain cooperative;
these results do not establish an OS-enforced RAM or dedicated-VRAM cap. Windows
was not rerun for the fixes in this session.
