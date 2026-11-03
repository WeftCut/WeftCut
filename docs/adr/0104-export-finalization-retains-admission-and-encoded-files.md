---
status: accepted
---

# Export admits one working set and keeps a finalization reservation for retry

Date: 2026-10-08

## Context

The native resource governor (ADR 0101) admits cooperative memory and CPU
claims. Two export failures came from admitting stages independently:

- Encoder, compositor and decoder reservations each fit the working allowance
  while their simultaneous demand did not, so an export held a sink/worker
  allocation while waiting for a decoder that could never fit. At the 2304 MiB
  memory target (921 MiB working allowance), a fixed 24-picture decode window
  rejected 1080p Main10.
- Admitting the stream-copy mux as a new task lost completed exports. On Linux,
  process-RSS hysteresis can stay "pressured" after every production lease has
  drained, and on three-core CI hosts background work briefly held the only
  free CPU slot.

## Decision

- **One parent reservation.** Metadata preflight builds up to three execution
  plans (`buildExportResourcePlans`), each summing encoder, compositor, Motif
  producer/capture and peak simultaneous decode demand (overlapping clips at
  different source phases count twice; adjacent clips do not). The governor
  atomically picks the first plan that fits and reserves its memory and native
  encoder threads. Worker, decoder, sink and Motif claims borrow from that
  parent; borrowing preserves the total and cannot cross owners. Cheaper plans
  shrink decode windows (to the AVC level's DPB + 8 credits, at most 24; unknown
  codecs keep 24) and the Motif producer from three frames to one. Resolution,
  bit depth, frame count and rate control never change.
- **Wait, don't hold.** A waiting export holds nothing. Releases, pressure and
  settings changes wake admission; temporary contention waits up to 15 s with
  cancellation. A static minimum above the working allowance fails before any
  production. An admitted working set is not revoked by ordinary pressure or a
  reduced target; critical host pressure (available RAM below 256 MiB,
  recovery above 512 MiB) still refuses new child allocations.
- **Audio first.** Audio is encoded before the video envelope is reserved, so it
  cannot deadlock behind it.
- **Finalization reservation.** Export reserves 64 MiB (no CPU) for
  finalization before video production; production borrows it and atomically
  returns it, so the phases are not charged twice. At mux, the parent shrinks
  to that tail and mux borrows one CPU slot against it. Only a live,
  owner-scoped finalization may proceed under ordinary RSS pressure; critical
  pressure still rejects. Queued finalization takes priority over new compute
  claims and waits at most 15 s. The renderer holds an opaque token that main
  maps to the native reservation; normal leases cannot act as continuations.
- **Encoded files are immutable.** After encoder flush, mux failure keeps the
  encoded files and the reservation for Retry (stream-copy only) or Discard.
  Retry is session-local; no crash/restart recovery exists.

## Consequences

- Retry never re-encodes or reads a newer project. A durable queue would need a
  persisted manifest, startup recovery UI and storage accounting.
- The memory target stays cooperative: the 2304 MiB retry runs peaked at
  ~2617 MiB process-tree RSS (Chromium allocator retention), with 76 MiB in the
  ledger at the mux boundary (64 MiB finalization + 12 MiB preview).
- Native encoding stays serialized (the encoder sink is a singleton); encoder
  threads return to the governor when the encoder closes.
- Preview suspends for the export and retires its Motif GPU caches before
  admission.

## Note (2026-11-01): export admission has no deadline

"Temporary contention waits up to 15 s" no longer holds. An export started
while a proxy build held the budget failed busy after 15 s, though the build
ran for minutes. The rule now:

- An export waits for admission until it is admitted or cancelled. The job
  reads `queued` with the holders; `get_export_status { wait_s }` and the export
  panel show the wait. The metadata preflight that sizes the plans is admitted
  the same way.
- `budget-too-small` (a static minimum above the working allowance) still
  refuses at once.
- While an export waits, the governor admits no new background claim (the
  `user_waiting` rule, counted in `export_waiting`).
- Running derivatives keep their leases: nothing is paused or pre-empted.

Child claims that borrow from the admitted plan keep their 15 s bounds: they
fit by construction.

No export work claims fresh resources outside the plan: the audio mix runs
after admission, before any video child, and borrows its 128 MiB from the plan
(no thread: the encoder after it needs the plan's). Every plan of an export with
audio is at least that large; an audio-only export is admitted for that one
plan. Before this, the mix took a fresh interactive claim between the metadata
preflight and admission, so on a one-thread budget a quick proxy refused it and
the export failed busy after 15 s without ever reading `queued`.

The queued finalization (the mux) has no deadline either. It holds its memory
but needs one CPU slot, and a WebCodecs plan holds none: on a one-thread budget
a proxy build running beside the admitted export held that slot for minutes, and
the 15 s bound failed the export into `awaiting_retry`. It now waits ahead of
every fresh claim (`finalization_waiting`) until the slot frees or the export is
cancelled; only critical host memory refuses it.
