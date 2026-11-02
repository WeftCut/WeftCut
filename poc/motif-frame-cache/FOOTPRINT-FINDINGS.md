# Motif frame cache: disk footprint and project-open cost

Date: 2026-10-26. This is a measurement of the shipped `.wfrm` layer (ADR 0078,
ADR 0108) on real projects, plus an offline comparison of alternative encodings
over frames copied out of those caches. No production source changes. Numbers
come from one Windows bench host (i5-13400, NVMe SSD, Defender real-time
protection on) and one Linux machine for the codec experiment; treat them as
one machine's evidence, not a cross-hardware guarantee.

Reproduce: `footprint/` holds the Rust comparison (`cargo run --release --
<dir of per-content frame dirs> [results.tsv]`) and `inventory-walk.cjs`, the
project-open walk. `footprint-results.tsv` is the run reported below.

## What the caches look like today

Every placed Motif is baked to disk automatically for its used range
(ADR 0108), one LZ4 block of straight RGBA per frame under
`<workspace>/Cache/raster/<hash>/<frame>.wfrm`. The cache key includes
canonical props, authored size, project fps and content duration, so a prop
edit, a retime or a fps change starts a new directory. The temporary-cache
budget defaults to 2048 MiB (`disk_cache_mib`); referenced directories are
retained against eviction, so a project whose live content exceeds the budget
simply stops growing.

| Project on the bench host | Content dirs | Frames | Bytes | Per frame |
|---|---:|---:|---:|---:|
| Lyric video, all 1920×1080 | 61 | 10,337 | 4,021 MB | 300–700 KB |
| Intro, 30 fps | 12 | 1,563 | 446 MB | see below |
| Same intro at 60 fps (fps is in the key) | 11 | 3,061 | 888 MB | same per frame |
| 17 e2e leftover caches under `tmp/` | — | — | ≈25 GB | each pinned at the 2048 MB budget |

In the intro, two full-frame Motifs hold 346 MB of the 446 MB (78%); the ten
sparse text Motifs are 87–110 KB per frame with a 32 KB floor. That floor is
the LZ4 cost of a fully transparent 1080p frame (8.3 MB of zeros encodes to
≈1/255 of its size): a blank frame costs 32 KB on disk.

## Project-open inventory opens every file

`MotifFrameStore.inventory()` opens each `.wfrm`, reads its 20-byte header
and stats it so the restored coverage is exact (docs/motifs.md#preparation-l2-baking, restoring persisted
coverage). The on-demand preview frame waits behind that barrier. On the bench
host the first open of a file since boot costs about 6 ms regardless of its
size; a second pass costs 0.03 ms. The drive is NVMe and the walk is
sequential, so the fixed per-open cost is consistent with on-access scanning
rather than disk latency. Stat alone is cheap cold.

| Cache | Files | stat-only, cold | open+read+stat, cold | open+read+stat, warm |
|---|---:|---:|---:|---:|
| Lyric video | 10,337 | 0.3–0.4 s | 61.8 s | 1.1 s |
| Intro 60 fps | 3,061 | 0.24 s | 18.2 s | 0.35 s |
| e2e baseline | 1,870 | 0.11 s | 10.3 s | 0.34 s |

On a cold machine, opening the lyric project therefore spends about a minute
enumerating frames before the first Motif can be previewed or baked. This is
the largest "loading" cost found, and it does not depend on the codec.

## Encoding comparison on real frames

Nine content directories (five from the intro, four from the lyric video,
32–90 consecutive frames each, 446 frames total) were decoded with the
production format and re-encoded nine ways. Sizes are per directory in MB;
"dprev" is the byte difference against the previous frame; "dkey30" against
the nearest earlier multiple-of-30 frame; "crop" keeps only the alpha bounding
box; "dups" counts frames byte-identical to their predecessor.

| Content | Frames | raw | LZ4 (today) | zstd‑1 | zstd‑3 | dprev+zstd‑1 | dkey30+zstd‑1 | crop+zstd‑1 | PNG fast | dups |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Text reveal, 1080p, 5% of frame painted | 48 | 380 | 5.1 | 3.0 | 2.8 | 0.9 | 1.9 | 2.8 | 5.3 | 32 |
| Lower third, 480×112 | 90 | 18.5 | 0.8 | 0.6 | 0.5 | 0.2 | 0.3 | 0.6 | 0.8 | 71 |
| Full-frame animated graphic | 48 | 380 | 68.2 | 38.2 | 35.5 | 28.7 | 63.4 | 38.2 | 57.9 | 7 |
| Full-frame soft overlay | 60 | 475 | 4.1 | 1.8 | 1.8 | 1.0 | 1.5 | 1.8 | 5.5 | 0 |
| Full-frame, mostly static after intro | 32 | 253 | 29.1 | 9.0 | 8.5 | 1.2 | 6.7 | 9.0 | 32.4 | 0 |
| Lyric line A | 48 | 380 | 15.5 | 10.4 | 10.1 | 11.7 | 16.2 | 10.4 | 17.4 | 0 |
| Lyric line B | 40 | 316 | 23.9 | 16.4 | 15.8 | 19.3 | 26.5 | 16.4 | 24.8 | 0 |
| Lyric line C | 40 | 316 | 11.3 | 7.3 | 7.1 | 5.6 | 9.8 | 7.3 | 13.1 | 0 |
| Lyric line D | 40 | 316 | 13.1 | 8.3 | 8.2 | 3.1 | 7.1 | 8.3 | 14.7 | 0 |

Byte-plane (planar) and PNG-style "sub" prefilters before zstd were also run;
neither beat plain zstd‑1 consistently (planar: 5.9 vs 9.0 on the static
full-frame content but 17.5 vs 10.4 on lyric line A) and both double the
decode work. The full columns are in `footprint-results.tsv`.

Decode and encode time per 1080p frame, single thread on the Linux machine,
each decode including the 8 MB output allocation:

| | LZ4 | zstd‑1 | zstd‑3 | dprev+zstd‑1 | PNG fast |
|---|---:|---:|---:|---:|---:|
| decode, ms | 5–18 | 10–14 | 10–16 | 16–23 | 15–32 |
| encode, ms | 3–17 | 3–21 | — | — | 17–47 |

LZ4 is fastest to decode on dense content (5 ms vs 10 ms) and slowest on
sparse content, where it spends its time replaying zero runs. zstd‑1 costs
0–5 ms more per frame on the native worker and never touches the UI thread;
ADR 0078 measured the whole disk-to-texture path at about 24 ms per frame, of
which decompression is a minor part, so this swap does not change playback
read latency materially in either direction.

## Readings

1. **zstd level 1 instead of LZ4 saves 31–69% of every directory measured**,
   with the same read/write architecture, no new dependency chain between
   frames, and encode cost on par with LZ4. Level 3 adds only 2–7% more.
   Blank and nearly blank frames drop from 32 KB to a few hundred bytes.
   For the lyric project this is roughly 4.0 GB → 2.7 GB; for the intro
   roughly 446 MB → 200 MB. A new codec number in the existing header keeps
   old LZ4 files readable, so no re-bake or migration is needed.
2. **The inventory walk should stop opening files.** Stat gives frame
   presence and byte size, which is all the coordinator consumes
   (`bakeWorkspace.ts` keeps only `frame → bytes`). The header, dimension and
   checksum checks already run on the read path and already demote a bad file
   to a live re-render. That takes the cold lyric-project open from about
   62 s to under half a second.
3. **Byte-identical consecutive frames are common in text Motifs** (32 of 48,
   71 of 90) and present in dense ones (7 of 48). A header-only alias frame
   that names the frame it repeats is cheap and keeps one file per frame; it
   mostly matters for held dense frames once zstd has made blank frames
   nearly free.
4. **Inter-frame deltas are the only route to another large step** (−82% to
   −96% on static-after-intro content) but they lose on moving content
   (lyric lines A and B grow 13–18%) and reintroduce the read dependency
   ADR 0078 avoided: a seek must decode predecessors, and a frame can only be
   written as a delta when its predecessor is already persisted and hashed.
   A per-frame intra-or-delta choice with a capped chain length would need
   its own prototype and a playback measurement before it is worth taking.
5. **Not worth pursuing:** PNG at fast settings is larger than LZ4 on seven of
   nine directories and 2–3× slower to decode (confirming ADR 0078);
   alpha-bounding-box cropping gains at most 7% once zstd has removed the
   zero-run tax; prefilters do not pay for their decode cost.
6. **Hygiene, not design:** the bench host carries about 25 GB of e2e leftover
   caches under `tmp/dropped-frames/`, and every copy of a project owns a full
   cache. Neither is a product defect, but both inflate "Motif uses a lot of
   disk" on that machine.

## Not measured here

Playback and scrub read throughput on the GPU transport (lanes, lookahead,
read barrier) were not re-measured; ADR 0078's figures stand. Live capture and
bake throughput (33–170 ms per frame in BAKE-FINDINGS.md) are the cost of the
first visit and are unaffected by the storage codec. Decode times above are
from a Linux desktop, not the Windows worker.
