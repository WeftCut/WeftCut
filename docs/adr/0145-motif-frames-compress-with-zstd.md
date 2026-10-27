---
status: accepted
---

# Motif frames compress with zstd

Date: 2026-10-27

## Context

ADR 0078 stores each baked Motif frame as its own `.wfrm` file: a 52-byte
header (magic, dimensions, codec number, BLAKE3 of the pixels) followed by
LZ4-compressed straight RGBA. On real projects that is 4.0 GB for a 10,337-frame
lyric video and 446 MB for a short intro. LZ4 also has a floor: a fully
transparent 1080p frame still costs 32 KB, because LZ4 encodes long zero runs
at about 1/255 of their length.

An offline re-encode of nine content directories from those projects
(`poc/motif-frame-cache/FOOTPRINT-FINDINGS.md`) compared LZ4 with zstd,
prefilters, PNG, alpha cropping and inter-frame deltas. zstd level 1 was
31–69% smaller than LZ4 on every directory, encoded at LZ4's speed, and
decoded 0–5 ms slower per 1080p frame on the native worker. That worker is off
the UI thread, and decompression is a minor part of the disk-to-texture path
ADR 0078 measured. Level 3 saved only 2–7% more. Deltas can save far more on
static content but grow moving content and give up frame independence.

## Decision

- **New frames are written as codec 2, zstd level 1.** The header, file name
  and checksum are unchanged; the codec number already in the header selects
  the decoder.
- **Codec 1 (LZ4) stays readable.** Existing caches keep working and are
  replaced only as frames are re-baked or collected; there is no migration.
- Frames stay independent. Deltas and repeat-frame aliases are separate,
  later decisions.

## Consequences

- Disk use for the measured projects falls by roughly a third to two thirds
  (lyric project ≈4.0 GB → 2.7 GB, intro ≈446 MB → 200 MB), and blank frames
  drop from 32 KB to a few hundred bytes. More content fits the same
  `disk_cache_mib` budget.
- Checked with the shipped addon on the Windows bench host: real LZ4 frames
  re-encoded through `motifEncodePng` read back pixel-identical, 34% smaller
  on the lyric project (291 frames) and 56% on the intro (101 frames); warm
  median `motifReadFrame` was 9.0 → 10.1 ms and 7.9 → 5.1 ms respectively.
  The first read of a freshly written file adds several ms on that host
  whatever the codec (on-access scanning), so cold timings are not a codec
  comparison.
- The native addon gains libzstd (C, via `zstd-sys`), compiled by each
  platform's addon toolchain and held to the Linux glibc floor (ADR 0143).
- The size bounds for admission and reading stay LZ4's worst case, which also
  covers zstd's (`MAX_BYTES / 256` plus framing).
- Older app versions cannot read codec 2 frames. They treat them as corrupt
  and re-render, which ADR 0078's "disposable cache" already allows.
