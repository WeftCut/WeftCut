# Motif frame check: zstd's content checksum against BLAKE3

Probe, 2026-11-06. Question: what does a stored frame's content check cost, and
does zstd's own checksum catch what BLAKE3 over the pixels caught? **Answer:**
the checksum adds under 1 ms at 1080p and about 3 ms at 4K. BLAKE3 cost 4.7 and
19 ms. Every single-bit flip was rejected. ADR 0078 records the decision.

## Probe and environment

- i5-13400 (Windows 11). Frames from a real project's cache: 206 at 1080p, and
  52 of them doubled to 3840×2160. WebAssembly runs used `zstddec` 0.3.4 in a
  classic worker (20 and 6 frames).
- Native: the `zstd` crate at level 1, single thread. In-app: the Windows
  texture lane with playback paused, stored frames read through the reader,
  four runs per side.

## Cost, median per frame

| | 1080p | 4K |
| --- | --- | --- |
| BLAKE3 over the pixels | 4.7 ms | 19 ms |
| zstd decompression, native, checksum off → on | 4.6 → 5.2 ms | 13.6 → 16.5 ms |
| the same in WebAssembly | 4.6 → 5.1 ms | 18.2 → 21.9 ms |
| zstd level-1 compression, checksum off → on | 5.6 → 6.5 ms | 13.0 → 16.9 ms |

In the app, decompression plus verification fell from 5.6 to 4.2 ms (1080p) and
from 17.8 to 11.1 ms (4K). Reads rose from 66 to 72 per second (1080p, one in
flight), from 163 to 169 (three in flight), and from 21 to 23 at 4K. With three
in flight at 4K both stayed at about 45: the texture lane's read barrier set
that ceiling. 1080p playback was unchanged at 51 pictures per second with no
Motif pending.

## Detection

One bit at a time was flipped across each stored payload, checksum included.
All 1,032 flips natively and all 104 in WebAssembly were rejected; none decoded
to other pixels. `zstddec` signals a failed check only by returning a wrong
length.

The checksum is the low 32 bits of XXH64 over the original pixels. It covers
the file and the decompression, but not the 16-byte header. A damaged width or
height almost always changes the byte count, which the read rejects; dimensions
swapped to the same product would pass.

Hashing only the compressed bytes would cost less, but cannot see a wrong
decompression.
