---
status: accepted
---

# Export streams Motif frames with consumption credits

Export used to decode every Motif frame into a fresh bitmap before starting
its worker. Even fully baked content paid a long preparation wait and retained
pixels proportional to the total Motif duration. A 1080p60 project with four
Motif layers required 1,290 bitmaps, roughly 10 GiB of expanded RGBA.

The renderer now plans pixels for each **output** frame using the existing
composition grid, content-frame descriptor and Group instance identity. It
streams owned bitmaps to the export worker. The worker waits for the exact
packet, composites it, closes its bitmaps and acknowledges consumption.
Transfer alone does not release the producer's byte reservation.

The initial window is three output frames and 128 MiB of reserved pixels.
Reservations include reads in flight, transferred packets and worker-held
packets, with a second pixel surface allowed for readback or persistence.
A single active frame larger than the budget is admitted alone to avoid
deadlock; extra prefetch is not allowed alongside it. This is a Motif transport
budget, not a cap on the whole application's GPU/CPU memory or native pools.

Disk frames are preferred. Missing or corrupt frames are captured at their
original authored size without dropping frames. Export writes these frames
back to the existing cache and updates its index, awaiting persistence within
the reservation so writes cannot accumulate an unbounded bitmap queue.
Write failures retain valid pixels, continue export and produce a diagnostic
log only. Capture failures stop export. Cancelling stops admission, cancels
keyed captures, closes late read results and retains completed cache files.

This extends ADR 0016's writer rule: export is now also an explicit cache
writer. It uses the same versioned frame format and atomic writer as the
background baker (ADR 0078), without triggering a full-content bake. The
background baker's own persistence-failure behavior is unchanged.

Motif preparation is part of ordinary export progress, measured in completed
output frames. It does not display a separate optimized-media/baking stage.
Cancellation is available during frame export. Existing video/audio readiness
gates and finalization stages keep their meanings.

Validation covers rational fps and Group frame selection, byte credits across
ownership transfer, cancellation and partial failures, cache repair and silent
write failure. Electron tests exercise built-in and user Motifs, cold and warm
exports, missing/corrupt cache repair, cancellation and a subsequent export.
An isolated copy of the representative 36.7-second project exported all 2,202
frames with identical decoded pixel hashes before and after the change.
