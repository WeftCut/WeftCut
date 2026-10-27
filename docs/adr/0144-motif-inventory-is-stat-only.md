---
status: accepted
---

# Motif inventory is stat-only

Date: 2026-10-27

## Context

Opening a Workspace restores persisted Motif coverage (ADR 0016, ADR 0108)
by inventorying each content's `.wfrm` files. The inventory opened every
file, read its 20-byte header and checked dimensions, codec and size
before counting the frame. ADR 0108 called that header inventory cheap.

On the Windows bench host (NVMe, Defender real-time protection on) it is
not: the first open of each file since boot costs about 6 ms regardless of
its size, while a stat costs microseconds. The lyric-video project's
10,337 frames took 62 s to inventory cold against 0.3 s for stat alone
(`poc/motif-frame-cache/FOOTPRINT-FINDINGS.md`). Preparation and the first
on-demand preview wait behind that inventory.

The coordinator consumes only frame presence and byte size. The reader
already verifies the header, dimensions and checksum, and a failed read
drops the frame from coverage and admits a replacement capture.

## Decision

- **Inventory stats files and never opens them.** A frame counts when its
  canonical `<frame>.wfrm` name maps to a regular file larger than the
  52-byte header. Links, temporary files and other names stay ignored.
- **Validation belongs to the reader alone.** A malformed file counts as
  covered until it is read; the read miss removes it and reopens capture for
  that frame, as for any other corrupt frame.

## Consequences

- Cold project open no longer scales with per-file open cost. Measured on
  the bench host after a reboot, with the shipped and previous inventory on
  the same caches: lyric project (10,337 frames) 61.1 s → 0.73 s; intro at
  60 fps (3,061 frames) 18.1 s → 0.24 s. Both found identical frames and
  bytes.
- A corrupt or foreign frame can report "ready" until playback, export or
  preview reads it. It then heals by re-capture, as it already did for
  corruption the header checks could not see.
- A future codec (e.g. zstd) needs no inventory change: size bounds and the
  codec number live only in the reader.
