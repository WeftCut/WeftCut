---
status: accepted
---

# Preview follows estimated audio output and bounds outstanding delivery

The preview clock read output timestamps but calibrated them back onto
`AudioContext.currentTime`. A controlled 100 ms output delay therefore advanced
the picture 100 ms ahead of output while the scheduling anchor remained correct.
The regression calls the real SyntheticClock: after a 10 ms start lead and
510 ms render-clock advance, output position must be 400 ms, not 500 ms.

PCM scheduling retains its currentTime anchor. Presentation projects the output
timestamp pair without adding the render lead. Invalid/old timestamps use both
latency properties when available, then currentTime; telemetry explicitly names
each source. Playback remains monotonic, including a hold while increased output
latency catches up. Seek/play hold at the requested position until scheduled
audio reaches output. This refines ADR 0087's clock mapping, preserving its
session ownership and PCM scheduling contract.

The compositor records visible frame intervals in root composition time,
including Group/clip rate mappings and held pictures. A successful Pixi render
submission samples the output clock again. Telemetry exposes target/output skew,
worst expired/future frame interval, missing layers, held scenes and the last
600 submission intervals (p95/p99/max). Unknown durations have no invented expiry;
empty pictures have no video interval. Submissions are not scan-out, and output
timestamps are not physical acoustic measurements. These metrics supplement the
existing drop/late indicator and appear in PerfHUD and playback-perf JSON.

Production software/copy-back preview enables native delivery credits: at most
eight outstanding payloads and 32 MiB, except that one oversized payload can
travel alone. A unique receipt stays charged through napi and IPC until the
renderer accepts or drops the frame. The producer may also hold one decoded
pending frame; codec surfaces, renderer caches and transient IPC copies are
separate. Duplicate/foreign receipts cannot create credit. Seek changes the
discontinuity identity without forgiving old receipts; ordinary forward refills
share the identity so useful lookahead already in IPC is still accepted. A cache
flush changes identity even at the same target and re-primes the native cursor.
Both native frame boundaries
and renderer acceptance reject superseded work. Renderer death/navigation closes
the producer. Native-only callers can retain the older uncredited contract.

Decode work has an eight-ms cooperative slice and yields between frame calls,
resuming the same cursor after credit or timer wake-up. It never changes playback
rate or promises to interrupt a codec/driver call. In particular, resuming the
same distant long-GOP target must not re-seek and repeatedly decode its prefix.

GPU slot recycling stays completion-driven. If both the GPU probe and CPU
fallback fail, the transport closes/reports failure without acknowledging an
unproven read. Live pending count/oldest age and completed-wait p95 remain visible
even when no frames arrive. Pool depth is unchanged pending hardware throughput
evidence; timeout is not proof that a shared texture can be overwritten.

Thread isolation and adaptive quality are explicitly deferred by the user.
No worker migration, automatic proxy choice or quality ladder is introduced.

Validation: 143 focused TypeScript tests and 36 native software-preview tests
pass (the packing microbenchmark remains ignored). Typecheck and native Clippy
pass. Electron checks cover hardware pool sizes 1/3/5, three/five concurrent
hardware sessions, budget refusal/fallback, software frame order, both color
charts, audio without presentation, and live synchronization telemetry under a
deliberate renderer stall. These are correctness checks, not a new multi-track
performance claim or a physical lip-sync calibration.
