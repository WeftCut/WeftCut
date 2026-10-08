---
status: accepted
---

# One cross-platform application resource authority

Preview budgets in ADR 0100 cannot regulate native jobs, export, audio, models or
multiple Electron windows. More pool knobs would ask users to solve internal
scheduling while still allowing independent subsystems to oversubscribe.

Settings exposes memory target, processing effort, temporary cache space and
background processing during playback. Main derives allocation from intent and
host RAM/CPUs. The native core owns one admission ledger for native tasks and
owner-scoped Electron IPC. Renderer caches coordinate retention within an app
allowance divided across windows. Measured process-tree memory governs pressure
independently from estimated reservations.

Windows, macOS and Linux use the same policy and authority. Platform-specific
decode and shared-texture adapters remain behind that common contract. Portable
resident-memory telemetry uses sysinfo. Optional platform diagnostics and
benchmarks must declare their narrower scope.

Leases survive until teardown/final release. Reducing a target does not free live
resources or cancel export. New work waits or fails explicitly; pressure reduces
retention and closes admission with hysteresis. Resident decoders reserve memory
and carry thread caps without retaining an exclusive job slot while idle.
Fallback routes acquire through the same memory authority.

Export's renderer and WebCodecs working-memory claims retry capacity refusals
for at most 15 seconds, matching native interactive admission. Waiting holds
no additional lease, ends on export cancellation/worker teardown, and preserves
the final resource error if capacity does not recover. Claims larger than the
entire work allowance and non-capacity errors fail immediately. Preview retains
its fail-fast admission. This lets finite background work drain before export
decoding without increasing the memory target or bypassing pressure checks.

The contract is cooperative: browser/GPU allocations and running codecs do not
offer portable whole-process hard caps. Thread counts are not CPU percentages,
and shared textures are not total VRAM. Temporary disk quotas protect original
media, projects, models, expensive/paid results and unvisited workspaces.

This supersedes ADR 0100's editable preview/decode controls. Legacy preferences
and test records remain compatibility inputs beneath the app ceiling. Resource
settings never silently change decode quality, export format or model selection.

Coverage, thresholds and verification are in
[performance-settings.md](../performance-settings.md).
