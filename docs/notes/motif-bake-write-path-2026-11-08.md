# Motif bake: where a 4K cold bake spends its frame

Probe, 2026-11-08. Question: once captures were pipelined (ADR 0159), what
limits a cold bake, and how much of it is the write? **Answer:** each bake
frame held one of the bake coordinator's three places until its file was
written, about 82 ms, and half of that was the write. The straightening step
alone took 15 ms per 1080p frame on one thread with a division per channel. A
table built from the same formula, run by the threads that compress each band,
took the whole encode from 26 to 15 ms per 4K frame, with identical bytes.
After that a bake is bound by the capture host's own serial work, mostly the
Motif's JavaScript; a single host has nothing large left to give.

## Probe and environment

- Windows 11, i5-13400 (16 threads, AVX2), RTX 3050. Electron 44.9.3. App
  started from an interactive scheduled task. The display ran at 57–141 Hz
  depending on the remote viewer; each run records its rate, and runs of one
  arm at 60 and 140 Hz did not differ.
- The 15 s DECO project, 58 Motifs declared at 3840×2160, cold cache, prebake
  on; 10,337 frames. Rate is files stored per second over a steady window
  (20–200 s or 20–115 s); completion time has 10 s granularity and is not
  used. Arms alternated, two runs each; repeated runs of one arm agreed within
  0.4 frames per second.
- An uncommitted probe split each frame: render (CDP round trip, Motif
  JavaScript, wait for the rendering step), wait for the paint, write slot,
  readback, encode, file write; the shell timed the parts of a render.
- A standalone microbenchmark ran today's and the table's straightening on 16
  4K and 24 1080p real frames, plus the same frames with half alpha and with
  random alpha, compared byte for byte.

## Per frame before the change (4K, ms)

| Render | of it Motif JS | Wait for paint | Write slot | Readback (lease) | Encode | File |
| --- | --- | --- | --- | --- | --- | --- |
| 15.0 | 11.7 | 18.5 | 1.6 | 14.1 | 25.8 | 2.0 |

The bake coordinator counts a frame until `persist` returns, which waits for
the file: three frames in about 82 ms each is 37 per second; measured 34.

## Arms (4K cold bake, frames per second)

| Arm | Rate |
| --- | --- |
| Main (`ae937311`) | 33.9 / 34.3 |
| Bake coordinator keeps 5 frames instead of 3 | 39.1 / 39.4 |
| + table straightening fused into the band encode | 41.4 / 41.4 |
| + capture keeps 5 frames in flight, coordinator 7 | 42.2 / 42.2 |
| + 4 write slots instead of 2 | 42.5 / 43.8 |
| + texture copied to a texture of the reader's own, lease released before readback | 43.1 / 43.9 |
| Table encode, coordinator 5, editor ticker stopped | 43.7 / 43.8 |
| Table encode, coordinator 5, no per-frame `__motifSetup` call | 43.5 / 43.6 (control 43.9 / 43.6) |
| Table encode, coordinator 5, 240 Hz capture clock | 43.3 / 43.2 (control 43.9 / 43.6) |

- Five coordinator frames moved the wait to the two write slots (15 ms per
  frame). The coordinator's count is a memory budget question: at 4K each
  frame reserves about 126 MiB against about 33 MiB of real pixels.
- More frames in flight or slots moved the queue to the single D3D11 readback
  thread (36 ms); releasing the lease before readback shortened the lease from
  27–36 to 7–11 ms without changing the rate. Every stored frame of four runs
  of these two arms was identical (MD5).
- After the table encode, setup and render took about 20 of 23.6 ms per frame.
  First frames of a window ran the Motif's JavaScript at 25 ms instead of 12
  (cold code); with 58 windows that is about 1 % of the bake.
- The editor's Pixi ticker renders every display frame while paused; stopping
  it took the editor renderer from 0.3 to 0.1 cores and the GPU process from
  0.89 to 0.60, worth 5.7 % here.

## The change alone (coordinator keeps 3 frames)

Main against main with the table encode, both without the probe, 130 s runs,
steady rate 20–115 s, frames per second. The bitmap rows force the bitmap host
(`WEFTCUT_MOTIF_CAPTURE=bitmap`) on the same machine; there the change also
moves straightening out of the lease and drops a full-frame copy.

| Host | Main | Table encode |
| --- | --- | --- |
| Texture, 4K | 35.1 / 35.5 | 38.7 / 39.3 |
| Bitmap, 4K | 15.7 / 13.9 | 18.3 / 19.1 |
| Texture, 1080p | 45.5 | 51.4 |

Every frame both 4K texture runs stored (4,847) was identical (MD5).

## Straightening, microbenchmark (ms per frame, p50)

| Content | Today, 1 thread | Table, 1 thread | Table fused into zstd, 2 threads | Today's whole encode |
| --- | --- | --- | --- | --- |
| 1080p real | 14.8 | 2.5 | 6.9 | 21.6 |
| 1080p all alpha partial | 15.1 | 5.3 | 7.7 | 20.8 |
| 4K real (75 % transparent) | 21.7 | 9.7 | 22.0 | 38.2 |
| 4K random alpha | 22.2 | 12.3 | 39.6 | 54.9 |

The table skips opaque and clear pixels; the fused column was measured with a
table that did not, so it is an upper bound. The in-app arms ran the shipped
form. Today's division is skipped for transparent pixels, so mostly transparent 4K
frames gain less than opaque 1080p ones. With two writers, today's encode
alone allows 50 4K frames per second, so the CPU encode was never the bake's
ceiling by itself; its length was, through the coordinator's count.

Not measured: macOS and Linux hardware (the bitmap rows above are Windows
running the bitmap host), playback with live writes, a host per CPU core.
