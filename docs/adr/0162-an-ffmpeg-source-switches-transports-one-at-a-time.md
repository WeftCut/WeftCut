---
status: accepted
---

# An FFmpeg source switches transports one at a time

Date: 2026-11-09

## Context

`FfmpegSource` replaces its transport in four places: the HW→SW fallback when
an open fails, the same fallback when an open transport fails later, a
playback-resolution re-open, and a spilled clip retrying hardware after the
pool reclaims a lease. Each place kept its own ordering, and the source's state
was spread over flags (`ready`, `readyP`, `transport`, `openedTransport`,
`fatalFired`, `budgetSpill`, `capacityError`).

Two failures followed:

- `SwTransport.open` reported a failure twice, through `onError` and through
  its rejection. On a copy-back lane (nvdec, vaapi, videotoolbox) the first
  started the runtime fallback, the second found the lane already software and
  fired the fatal: the media left the FFmpeg engine for the app session. A
  capacity refusal there also marked the media hardware-unusable.
- The runtime fallback and the re-open started the next open without waiting
  for the old transport to close. A GPU session holds memory credits until main
  closes it, so under pressure the software open could be refused by the
  session it was replacing, and a re-open failure of any kind was fatal.

## Decision

- **One slot.** The source's transport is one union (`idle`, `resolving`,
  `opening`, `ready`, `releasing`, `blocked`, `failed`, `disposed`) with a
  table of allowed moves; any other move throws
  (`ffmpegSourceLifecycle.ts`). Every switch passes through `releasing`: the
  old transport's `dispose` is awaited before the next opens. `disposeAndWait`
  also waits for a transport a switch was still closing.
- **One switch at a time.** A runtime error, a re-open or a reclaim retry
  starts only from `ready`. A divisor changed during a switch is applied once
  that switch settles.
- **One report per failure.** A failed open is its rejection. `onError` is a
  failure of an open transport; one that arrives before the open settles is
  taken as that open failing. Callbacks from an attempt that is no longer
  current are dropped by identity. `SwTransport` never calls `onError`.
- **One failure table** (`judgeFailure`) for every switch: a capacity refusal
  holds the source in `blocked`, unmarked, and a frame request retries after
  1 s; a budget refusal asks the pool to reclaim once, then spills; a
  reservation mismatch falls to the ordinary software profile; any other
  hardware failure marks the media and falls to software; a software failure
  or a bench-forced lane is fatal, reported once.
- The `FrameRing` belongs to the source, not the slot, and survives every
  switch.

## Consequences

- A runtime GPU→SW fallback waits for main to close the GPU session; the ring
  keeps the last frame on screen meanwhile.
- A forced lane is now fatal on a runtime failure too, not only at open.
- Software and copy-back lanes still cannot report a decode error after open:
  main only logs native's `Error` events. Forwarding them is a separate change
  through native, main and preload.
