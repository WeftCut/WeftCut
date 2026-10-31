---
status: accepted
---

# Temporary cache space follows the Workspace's disk size

Date: 2026-10-28

## Context

Temporary cache space is both the global disk-LRU target (filmstrips,
thumbnails, waveforms, audio-effect bakes, Motif frames across every Workspace
opened in the session) and the Motif-frame admission limit for the open
Workspace. A fixed 2 GiB default did not fit real projects: the lyric video's
Motif cache measured 4.0 GB with LZ4 and ~2.7 GB with zstd (ADR 0145), so
preparation paused, and because in-use Motif directories survive a sweep the
cheap timeline derivatives were evicted and regenerated repeatedly. One
10-minute stereo effect bake is ~230 MB. Everything covered is rebuildable, so a
larger default costs only disk. Premiere Pro and After Effects default to 10 % of
the cache volume (AE caps at 100 GB).

## Decision

- `disk_cache_mib: null` (the default) is automatic: 10 % of the **total** size
  of the disk holding the open Workspace, rounded down to 256 MiB, clamped to
  4–64 GiB. Before a Workspace opens, the app-profile disk stands in; unknown
  size resolves to 4 GiB.
- Total size, not free space, so the budget never shrinks from its own growth.
  Main re-measures only when a Workspace opens and republishes if it changed.
- Settings shows the value in force. An explicit value (256 MiB–1 TiB) wins;
  Restore defaults returns to automatic.
- Policy version 2. Version 1 stored its 2048 MiB default in every policy, so a
  v1 value of exactly 2048 is read as automatic; from v2 an explicit 2048 stays.

## Consequences

- 256 GB disk ≈ 23 GiB, 512 GB ≈ 47 GiB, ≥ 1 TB → 64 GiB; under 40 GiB → 4 GiB.
- A nearly full disk does not shrink the target; `ENOSPC` already pauses
  preparation. The value is a cache target, not a free-space guarantee.
- A user who deliberately chose 2 GiB under v1 is moved to automatic once.
