# Lab notes

Point-in-time records: measurements, experiments, rejected approaches and engine or
platform facts. Each names the environment and the probe that produced it, so a
settled question is not re-probed without a reason. Re-verify before relying on an
entry after an Electron/Chromium major bump or on hardware the entry doesn't cover.
Evergreen behavior lives in `docs/`; see [domain.md](../agents/domain.md) for what
goes where.

## Engine and platform
- `electron-chromium-behavior.md` — verdicts on the pinned engine (Pointer Lock, foreignObject taint, encode hints, WebGPU device loss, macOS offscreen capture).
- `canvas-raster-facts.md` — engine-independent rasterization and image-encode facts.
- `napi-rs-multiplatform-testing.md` — how the napi-rs addons are tested and loaded on all three OSes.
- `inference-path-compatibility.md` — local inference engines and non-ASCII / comma paths.
- `dependency-security-verification-2026-10-30.md` — dependency audit result.

## Preview, playback and export
- `playback-perf-findings-2026-07.md` — max smooth tracks per decode leg and the measured non-levers.
- `preview-thread-split-2026-10-26.md` — moving decode or Pixi into a Worker does not help; the stall is in the GPU process.
- `edit-latency-diagnosis-2026-10-13.md` — causes of the post-drag stall.
- `performance-calibration-observations-2026-10-05.md` — why the computer test is fixed and stays experimental.
- `export-webcodecs-tail-alignment-2026-07-23.md` — WebCodecs tail-frame alignment across platforms.
- `motif-preview-progress-2026-10-05.md` — Motif preparation progress during playback.
- `macos-runner-videotoolbox-kill-2026-10-31.md` — on the GitHub macOS VM, a SIGKILLed VideoToolbox encoder hangs the next export; a graceful ffmpeg stop does not.

## Agent and MCP
- `agent-bench-baseline-2026-10-20.md`, `agent-bench-h1-2026-10-21.md`, `agent-bench-style-2026-10-25.md` — agent bench runs and what changed between them.
- `agent-review-commit-cost-2026-10-17.md` — per-commit cost of the review diff.
- `descriptions-vlm-facts.md` — video-description model facts and rejected approaches.
- `mcp-spec-2026-07-28-migration-2026-07-29.md` — assessment of the MCP 2026-07-28 / SDK v2 migration.

## UI
- `react-electron-docking-layout-research.md` — why dockview, and floating/popout panels stay off.
