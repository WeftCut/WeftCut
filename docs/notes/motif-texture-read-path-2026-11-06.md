# Motif texture lane: where a stored-frame read spends its time

Probe, 2026-11-06. Question: what does a stored Motif frame cost on the Windows
texture lane at 4K, and what limits reads per second? **Answer:** the read
barrier read the whole frame back to the CPU to prove one copy had run. One
pixel on an accelerated canvas proves the same thing for 1–2 ms, and doubles
4K throughput. What remains is native decode and upload in main.

## Probe and environment

- Windows 11, i5-13400, RTX 3050, 60 Hz. Electron 44.9.3 / Chromium 152. App
  started from an interactive scheduled task so the renderer had a real GPU.
- A real 15 s project with 58 Motifs and a warm cache. The 4K case declares the
  same Motifs at 3840×2160, which renders their pixel-sized parts sparser than
  real 4K content.
- Playback paused. Stored frames read through the document's reader via the E2E
  hook, 240 frames spread over the cache, one or three in flight. An
  uncommitted timing patch split each stage (main, native, IPC, preload,
  barrier worker). A Chromium trace (`gpu`, `gpu.service`, `toplevel`, `ipc`)
  covered 60 reads.
- Background indexing slowed some runs by up to 2× in absolute terms. Compare
  stages within a run, not across runs.

## One 4K read, one in flight (p50 about 66 ms in a slow run)

| Stage | ms |
| --- | --- |
| barrier: whole-frame readback | 22.4 |
| zstd decode and checksum | 14.6 |
| premultiply (CPU, scalar, one thread) | 8.4 |
| main outside native (address lookup 1.9, napi thread hop about 3) | about 7 |
| `UpdateSubresource` | 4.9 |
| wait for GPU completion (event query, 100 µs polls) | 3.3 |
| file read, IPC, `createImageBitmap`, port back | about 1 |

`createImageBitmap(VideoFrame)` resolves in 0.2 ms. 1080p has the same shape
(barrier 6.7, decode 5.5, premultiply 1.5).

## The barrier

The trace shows `RasterImplementation::ReadbackImagePixels` and
`RasterDecoderImpl::DoReadbackARGBImagePixelsINTERNAL` once per read: 11–15 ms
in the GPU process and 24–30 ms on the barrier worker. With three reads in
flight the worker was 95% busy, which capped 4K at about 45 reads per second.
The cause: `drawImage` of a GPU bitmap into a `willReadFrequently: true` canvas
takes `PaintImage::GetSwSkImage` and reads the whole image back, whatever the
destination size.

Barriers compared on the same build, 1 / 3 reads in flight:

| Barrier | 4K ms | 4K reads/s | 1080p ms | 1080p reads/s |
| --- | --- | --- | --- | --- |
| whole-frame readback | 17–35 | 24 / 45 | 5–7 | 73 / 171 |
| 1 px, `willReadFrequently: false` | 1.4–2.3 | 37 / 82–88 | 1.0–1.5 | 104 / 263–268 |
| WebGL2 `fenceSync`, polled 1 ms | about 4.7 | 32–34 / 83–85 | about 4.5 | 75 / 214–217 |
| WebGPU `onSubmittedWorkDone`, own device in the worker | about 4 | 35 / 83–84 | about 4 | 79 / 224–226 |
| none | 0 | 40 / 90 | 0 | 118 / 297 |

3,000 consecutive 1 px reads stayed at 1.3–2 ms (4K) and about 1.1 ms (1080p).
The video lane recorded about 90 ms for `onSubmittedWorkDone` on the preview's
own device; a separate worker device did not show that.

**Correctness check.** Alternate frames with distinct content. Hold each bitmap
until two later reads have reused the lanes. Then compare a 128×72 fingerprint
exactly with a reference read under the readback barrier. Every barrier above
gave 0 wrong frames in 400–800 checked reads each.

The check can fail. Releasing the slot before the copy and then waiting
0–100 ms at random gave 11 of 200 wrong frames at 4K and 41 of 200 at 1080p,
with three in flight. A fixed 40 ms wait gave none. Reads in flight equal the
lanes, and a free lane is reused oldest first. So with equal waits every
overwrite hit a slot whose copy had already run. No barrier at all also gave 0
wrong frames, for the same reason. That is timing, not a guarantee.

## Engine facts (Electron 44 / Chromium 152 source, not re-measured)

- Chromium acquires an imported D3D11 texture's keyed mutex with key 0 and
  releases it right after issuing its commands, without a fence
  (`dxgi_shared_handle_manager.cc`). Key 0 on both sides only excludes access.
  It does not order the copy before the producer's next write, so a barrier is
  required. Alternating keys would hang Chromium's `AcquireSync(0, INFINITE)`.
- A 2D canvas whose `willReadFrequently` is unset moves to the CPU after two
  `getImageData` calls (`kFallbackToCPUAfterReadbacks`). The worker's canvas
  did not in practice, but the hint must be explicitly false.
- Each `createImageBitmap(VideoFrame)` makes two full GPU copies. One goes into
  a temporary shared image (`PaintCanvasVideoRenderer`), the other into a
  pooled canvas resource.
- Electron's `SharedTextureImported.subtle.release(cb)` and the import's
  `allReferencesReleased` fire once the GPU process has run the copy, with no
  readback. Using them per frame needs the subtle transfer API on both sides.
  Not tried.
- A shared D3D11 texture cannot be DYNAMIC or STAGING. A cheaper upload decodes
  into an owned staging texture and copies inside the mutex. Not tried.
