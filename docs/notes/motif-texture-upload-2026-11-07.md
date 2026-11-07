# Motif texture lane: decode and upload after the barrier fix

Probe, 2026-11-07. Question: once the read barrier stopped reading frames back
(`motif-texture-read-path-2026-11-06.md`), what is left in a 4K stored-frame
read on the Windows texture lane, and which parts can go? **Answer:** a fresh
output buffer per decode cost about 7 ms in page faults, and premultiplying
then `UpdateSubresource` copied the frame twice on the CPU. Reusing the buffer
and premultiplying straight into the pool's own staging texture took a 4K read
from 25 to 15 ms. Splitting each frame into eight zstd bands, decoded on two
threads and premultiplied into staging as each band lands, took it to about
11 ms. More threads per frame were faster still but made playback tick late.
4K playback was already at the content's ceiling; reads now use well under
half the lane capacity instead of 82%.

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

| | before | buffer + staging | + bands, 2 threads |
| --- | --- | --- | --- |
| paused reads, one in flight | 39/s, p50 25 ms | 66/s, p50 15 ms | 87/s, p50 11 ms |
| paused reads, three in flight | 93–95/s | 150–155/s | 178–182/s |
| playback, one read end to end | about 32 ms | about 21 ms | about 17–18 ms |
| late ticks per pass | 0–2 | 0–2 | 0 |

Playback held 51.4 pictures per second on every arm; an occasional pass of
46–50 appeared on all of them at the same rate (about 2 in 20) with no pending
or late ticks, so it is not a change's doing. With 240 stored frames replaced
by their half-transparent variants, the old path fell to 36 / 88 reads per
second while both new ones held. 1080p paused reads went from 274 to
461–463 per second. A fingerprint check of 400 reads per arm, with
alternating distinct frames, found no wrong frame.

## Bands and how many threads decode them

One zstd frame decodes on one thread. Splitting the rows into eight bands,
each its own zstd frame with its own checksum, costs nothing in size (0.30 MB
either way at 4K) and lets them decode in parallel. In the microbenchmark a
4K decode fell from 9.0 ms to about 4 ms with four or eight threads, 8.8 ms on
random-alpha frames from 16, and encoding from 15.7 to 7.6 ms with eight.
Premultiplying each band into staging on its decoding thread, while it is
still in cache, took decode plus premultiply from 9.0 to 4 ms.

In the app every lane decodes at once, so threads per frame multiply by
three. Sweeping the cap (two rounds of three playback passes each):

| threads per frame | late ticks per pass | paused reads 1 / 3 in flight | playback read |
| --- | --- | --- | --- |
| 8 | about 3 (7–12 in a first run) | 104 / 182–191 | 16–17 ms |
| 8, below-normal priority | about 10 | 103 / 188–191 | 16–17 ms |
| 4 | about 2 | 98 / 192–194 | 16 ms |
| 2 | 0 | 86 / 178–182 | 17.5 ms |
| 1 | about 0.5 | 65 / 148–150 | 20 ms |

Late ticks are the preview's dropped-frame indicator, so the cap is two per
frame on this 16-thread machine, one per eight hardware threads. Lower thread
priority made it worse: preempted bands held their lane longer. Baking the
same project took as long as before (12.9 and 13.4 frames per second at 4K
between a quarter and nine tenths done; 16.0 and 15.6 at 1080p).

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

## Memory the reads hold

Each texture-lane pool used to keep a whole decoded frame for reuse and a
staging texture, neither counted by the Motif GPU budget: about three times
what the budget showed, and the decode buffer was source-sized, so a 4K Motif
read at a quarter held 16 times its slot. Now:

- Bands are cut at multiples of 4 rows, so each band decodes, scales and is
  premultiplied on its own thread. No reader holds a whole decoded frame; the
  band buffers come from one process-wide set, at most 32 MiB idle, freed when
  the last pool closes.
- Only pools that read stored frames have a staging texture, and the budget
  counts it like the slot. The export plan's GPU lane allowance doubles with
  it.
- A lane the budget cannot give a pool of its own takes the next idle pool of
  the same shape. Without this, legacy allocation at the default 128 MiB fit
  two 4K read pools for three lanes, and the third lane retired the others'
  pools to make room: 4K playback fell to 14 pictures per second.

Same machine and projects, budget mode (the default) unless noted:

| | before | after |
| --- | --- | --- |
| 4K paused reads, one / three in flight | 85 / 169 per s | 91 / 190–195 per s |
| 4K playback, one read end to end | 19 ms | 16 ms |
| 4K at half resolution, one read end to end | 28–30 ms | 18–20 ms |
| 4K at a quarter, paused reads three in flight | | 196–206 per s |
| 1080p paused reads, three in flight | 382–430 per s | 480–505 per s |
| main process private memory, peak during a 4K pass | 507–564 MB | 390–494 MB |

Before, a half-resolution read decoded the whole frame and scaled it on one
thread. Late ticks stayed at 0–1 per pass, and a fingerprint check of 400
reads at full and at half resolution found no wrong frame. Baking 4K from an
empty cache, arms alternated twice, ran at 11.2 and 11.4 frames per second
before and 11.6 and 11.5 after, while the main process peaked at 684–703 MB
before and 515–567 MB after.

Legacy allocation at 128 MiB now plays at 51.4 pictures per second with no
late tick; paused reads with three in flight reach about 150 per second against
195 at 256 MiB, since two read pools serve three lanes.
