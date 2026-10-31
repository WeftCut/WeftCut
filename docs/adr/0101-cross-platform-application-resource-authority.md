---
status: accepted
---

# One cross-platform application resource authority

Date: 2026-10-08

## Context

Per-subsystem knobs (preview cache, GPU buffer, decoder counts) could not
regulate native jobs, export, audio, models or several Electron windows, and
asked users to solve internal scheduling while independent subsystems still
oversubscribed the machine. Browser/GPU allocations and running codecs offer no
portable whole-process hard cap on Windows, macOS or Linux, and thread counts are
not CPU percentages.

## Decision

- Settings exposes intent only: memory target, processing effort, temporary
  cache space, and background processing during playback. Main derives the
  allocation from that intent and host RAM/CPUs/disk.
- The native `resources::Governor` is the single admission ledger for native
  tasks and owner-scoped Electron IPC leases. Renderer caches coordinate
  retention within an app allowance divided across windows.
- Measured process-tree memory governs pressure independently of estimated
  reservations; pressure reduces retention and closes admission with hysteresis.
- Leases survive until teardown/final release. Lowering a target never frees a
  live resource or cancels an export; new work waits or fails explicitly.
- Export's renderer/WebCodecs working-memory claims retry capacity refusals for
  at most 15 s (the native interactive deadline), holding no extra lease while
  waiting. Preview admission stays fail-fast.
- One policy and authority on all three OSes; platform decode and
  shared-texture adapters sit behind it. Resource settings never change decode
  quality, export format or model selection.

## Consequences

- The contract is cooperative: no OS-enforced RAM, CPU-percentage or VRAM cap.
  Brief overshoot is possible.
- Legacy preview budgets and saved computer-test profiles remain compatibility
  inputs beneath the app ceiling; they can lower, never raise, it.
- Temporary-disk quotas cover replaceable derivatives only; source media,
  projects, models and paid results are never evicted.
- Details and coverage: [performance-settings.md](../performance-settings.md).
