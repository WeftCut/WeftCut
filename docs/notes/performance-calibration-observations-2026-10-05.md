# Performance calibration observations — 2026-10-05

Why the [computer test](../performance-settings.md#computer-test-experimental-windows)
is a fixed, history-free sequence and stays labelled experimental.

**Environment.** i5-13400, ~32 GiB RAM, RTX 3050 OEM + UHD 730 (decoder
reported the RTX 3050), Windows. Reports were under the ignored
`.scratch/performance-calibration/`.

## Project-based 30 fps prototype (`npm run bench:calibration`)

- A full run took 194.6 s: 72.6 s sampling, 56.9 s waiting for import-triggered
  background work (both 4K fixtures hit the 15 s cap), 31.4 s warm-up, 19 s
  launch/project creation, 6.1 s first frames, 4 s for 16 seeks. Shrinking the
  fixtures 60 s → 20 s (718 → 243 MiB) saved only 25 s (13 %): fixed sampling
  dominates. The 90–120 s UX target was never supported by measurement.
- Short windows hide stalls: 3 × 4K H.264 showed 3 drops and frame-interval
  p99 7.1 ms in the first 2 s, but 51/186 drops and p99 2518.7 ms over 12 s.
  The then-current three-4K budget was not a validated stable limit.

These results led to the in-memory controlled host (no project, import or
derivative work) and to the rules: fixed loads/order/windows decided before
measurement; no history, previous score or hardware identity selects a start
or skips a stage; no adaptive early stop; incomplete runs keep the plan and
reasons instead of substituting a lighter workload.

## Controlled H.264 4K/60 host (`bench:calibration:controlled`)

An 8-cell run took 122.9 s: 64.1 s sampling, 12 s warm-up, 4 s first-frame
readiness and **41.8 s cleanup** — cleanup, not the sample window, is the first
optimization target. One stream advanced normally; higher counts stalled, and
the normal editor with the same reference, layout and 1280×720 canvas also
stalled. This does not establish a hardware limit or equivalence between the
two hosts; keep recommendations experimental until repeatability is checked.
Presentation submissions can exceed 60/s on high-refresh displays; decoded
frame advances are measured separately.
