# Motif texture lane: decode and upload after the barrier fix

Probe, 2026-11-07. Question: once the read barrier stopped reading frames back
(`motif-texture-read-path-2026-11-06.md`), what is left in a 4K stored-frame
read on the Windows texture lane, and which parts can go? **Answer:** a fresh
output buffer per decode cost about 7 ms in page faults, and premultiplying
then `UpdateSubresource` copied the frame twice on the CPU. Reusing the buffer
and premultiplying straight into the pool's own staging texture took a 4K read
from 25 to 14–17 ms. 4K playback was already at the content's ceiling; reads
now use about half the lane capacity instead of 82%.

## Probe and environment

- Windows 11, i5-13400 (16 threads, AVX2), RTX 3050, 60 Hz. Electron 44.9.3.
  App started from an interactive scheduled task.
- A real 15 s project with 58 Motifs, as stored (1080p) and with the same
  Motifs declared at 3840×2160 (4K). Caches filled by prebake before
  measuring.
- In-app: playback passes (new pictures per second, ticks with a Motif
  pending, late ticks), then reads with playback paused, one and three in
  flight. An uncommitted timing patch split main, native, IPC and import.
  Arms alternated; each claim rests on at least two runs per arm.
- A standalone microbenchmark ran on 24–40 real 4K frames from the same cache.
  Every variant was compared byte for byte against today's output, including a
  readback of the shared texture after the GPU copy.

## Baseline before the change (4K, warm cache)

| | 1080p | 4K |
| --- | --- | --- |
| pictures per second, three passes | 51.4 | 50.7–51.5 |
| ticks with a Motif pending / late ticks | 0 / 0 | 0 / 0–1 |
| reads during playback | about 63/s | about 77/s |
| paused reads, three in flight | 274/s | 95/s |

51 is this content's own ceiling: about 9 ticks a second show the same
picture as the tick before. A 4K read took about 30 ms during playback:
decode 13, premultiply 5, upload 7 (`UpdateSubresource` 3.4, completion wait
3.3), main process outside native 2.3 (address lookup 0.3, napi thread hop
1.9), import 2.5.

## Where the time went (microbenchmark, 4K, median)

| Stage | ms |
| --- | --- |
| zstd decode into a fresh `Vec` | 16.4 |
| zstd decode into a reused buffer and decompressor | 9.0 |
| premultiply in place, today's branches, alpha only 0 or 255 | 6.6 |
| the same with every visible pixel half transparent | 10.1 |
| branch-free premultiply into a separate buffer, SSE2 / AVX2 | 8.8 / 7.7 |
| `UpdateSubresource` call / completion wait | 2.2 / 3.1 |
| premultiply straight into a mapped staging texture, SSE2 / AVX2 | 4.4 / 3.5 |
| `CopyResource` staging → slot through completion | 3.2 |

- The real frames have alpha 0 or 255 only, so today's branches skipped most
  pixels. To exercise the partial-alpha path, variants of the same frames had
  every alpha halved, scaled by a horizontal gradient, or replaced by noise.
  The branch-free kernel costs the same on all of them.
- Writing into the staging texture is as fast as a plain copy. Splitting it
  across 2–8 threads did not help: memory bandwidth, not arithmetic, is the
  limit.
- Spinning instead of sleeping 100 µs between completion polls saved nothing:
  the GPU copy itself takes about 2.7 ms.

## In the app (4K, alternating arms)

| | before | after |
| --- | --- | --- |
| paused reads, one in flight | 39/s, p50 25.4 ms | 59/s, p50 16.7 ms |
| paused reads, three in flight | 93–95/s | 141–148/s |
| decode / premultiply / GPU copy | 11 / 4.5 / 5.5 ms | 6 / 4.5 / 3.2 ms |
| playback, one read end to end | about 32 ms | about 21 ms |
| playback pictures per second | 51.4 (some passes 46–50) | 51.4 (some passes 46–50) |

The occasional slow pass appeared on both sides at the same rate (2 of 20
passes each) with no pending or late ticks, so it is not the change. With the
frames on disk replaced by their half-transparent variants (240 frames), the
old path fell to 36 / 88 reads per second while the new one held. 1080p
paused reads went from 274 to 330–367 per second. A fingerprint check of 400
reads per arm, with alternating distinct frames, found no wrong frame.

## Not taken

- **Dropping the completion wait.** The keyed mutex alone does order the copy
  before the next acquirer: a second D3D11 device reading the slot right after
  `ReleaseSync`, without the wait, saw 0 wrong frames in 300, and 250 in 300
  when it skipped the mutex. In the app the native thread came free about 6 ms
  sooner and paused reads rose to about 166 per second. During playback the
  read took as long end to end: the copy's wait moved into the renderer's one
  barrier worker, where it grew from 2.3 to 6–7 ms behind the compositor's GPU
  work. That worker serves every read, so the change trades a per-lane cost for
  a shared one.
- **The main-process overhead.** About 2.3 ms remains; the 7 ms seen the day
  before came from a loaded machine.
