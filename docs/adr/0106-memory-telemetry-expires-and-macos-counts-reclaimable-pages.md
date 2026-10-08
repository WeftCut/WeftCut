---
status: accepted
---

# Expire memory telemetry and count macOS reclaimable pages without subtracting the compressor

The shared resource authority (ADR 0101/0105) was rejecting runtime archive
extraction on a Mac with no active leases and application RSS below its target.
sysinfo 0.37's macOS available-memory estimate subtracts compressor occupancy
from free, inactive and purgeable pages. That subtraction can saturate to zero,
which main interprets as critical host pressure and blocks all new admission.

Process-tree RSS continues to use sysinfo on all platforms. macOS host availability
uses checked Mach VM statistics: free, inactive and purgeable pages multiplied
by the actual page size. Compressor pages are already separate occupied pages;
they are neither added nor subtracted. Speculative pages are already included
in free pages. This remains an estimate, not a measurement of OS pressure or a
hard allocation guarantee. Windows and Linux retain their existing OS-backed
availability sources. Failed, overflowing or impossible host samples are
unavailable, distinct from a valid zero. Partial host failure still preserves
fresh process-tree RSS and its application target.

Main ages the two signals independently using a monotonic clock. Brief gaps
preserve hysteresis; readings expire after 10 seconds, before the existing
15-second interactive admission deadline. Expiration clears only that signal's
pressure and makes its reported usage unavailable. A heartbeat ages readings
even while a native query is pending, and a result taking at least 10 seconds
is discarded as stale. Fresh host samples can update host pressure even when
process telemetry is missing. Fresh usage is evaluated against the current
memory target.

App usage above target and host availability below 256 MiB still close new
admission. Their respective recovery thresholds remain 80% of target and
512 MiB. Host pressure alone marks critical pressure. When telemetry expires,
the resource ledger, estimates, working allowances and thread limits continue
to govern admission; no user setting or live lease is changed.

This replaces the indefinite preservation of failed telemetry described in
performance-settings.md. Portable regressions cover compressed-memory page
arithmetic, query validity, signal expiration and independent recovery. IPC
tests cover failed, hung and late samples. An Electron regression uses real
telemetry and native archive extraction under the default resource limits.
