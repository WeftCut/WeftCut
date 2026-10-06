---
status: accepted
---

# Performance controls own budgets and derive allocation

This revises ADR 0099: Performance exposes directly editable cache and
shared-texture budgets. It removes the fixed resource tiers and their implicit
reductions of the existing baseline. Cache shares are diagnostics; decode concurrency
and buffer depth are editable advanced controls. Decode engine and
playback resolution remain independent preferences.

A versioned policy stores per-resource intent (null inherits defaults). Main owns
machine facts, validation, migration and runtime projection. The UI receives the
same automatic reference and effective values that runtime consumers use. It can
save while telemetry is unavailable, and saving never disables an active input.
Queued partial writes preserve ongoing edits; failures remain visibly unsaved
and retryable. Runtime changes publish only after atomic persistence.

Defaults use detected capacity: retain the 1728 MiB cache baseline at 32 GiB RAM,
scale above it, and reduce it for small-memory systems. The GPU transport allowance
uses one eighth of dedicated capacity when known; 416 MiB is the unknown/shared
memory fallback. These are allocation heuristics, not measured optimums. Raw legacy
configurations remain exact until explicit adoption; old API patches still work.

The UI has no Automatic/Custom selector: a displayed budget is directly editable.
Restore defaults writes the machine's baseline budgets as concrete values and
resets baseline decode guards. The old nullable policy and `restore_auto` API
remain supported for compatibility, without exposing another user-facing mode.

Retention priorities start at 32:16:5:1. A renderer ledger lets video, animation,
thumbnail and waveform caches borrow unused shares. Under pressure, cache owners
reclaim safely. Video forward floors, protected lookbehind, current tiles and
pinned animation pictures remain protected; retained references stay accounted.
This is a soft target, not a hard OS memory limit.

Shared texture bytes have an aggregate main-process admission limit across video
and animation. Animation may borrow unused video allowance in policy mode. Pending
allocations and retired imports stay charged until final reference release. The
limit covers transport textures only, excluding decoder-private surfaces and
compositor resources. The UI states both budgets' actual scope.

Memory capacity and decode throughput are independent. The baseline decoder
count and pixel-area guards remain until a test or manual override is applied. Budget
bytes additionally constrain admitted pixel area, never increase measured
throughput. Existing sessions retain their allocation until naturally closed.
Manual concurrency raises the area guard as well, bounded by actual transport
bytes and configured buffer depth. The UI identifies default guards as untested.
GPU capacity is read from a native Windows D3D11 device; unknown capacity is
shown explicitly. The controls are named Preview cache and GPU buffer budget,
because total RAM/VRAM enforcement is outside the allocator's present scope.

The isolated H.264 4K/60 benchmark is an optional experimental aid. Saving records
its recommendation, current cache budget and machine/build/protocol provenance;
it does not apply the result. Applying the saved profile and restoring defaults
are separate actions. Default restoration retains test evidence; deletion is
explicit. Stale evidence cannot activate foreign throughput guards and never
silently overwrites manual budgets. A conservative all-slow result is not a pass.

Hardware identities and driver versions are local applicability checks. The test
does not establish optimal cache sizes, available VRAM or performance of other
codecs. Broader physical-memory accounting remains separate from this policy.
