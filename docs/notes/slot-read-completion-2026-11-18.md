# Hardware preview slots: the page's fence against a one-pixel proof per frame

Probe, 2026-11-18. Question: should a d3d11va preview slot be released after a
synchronous one-pixel proof in the preload (draw one pixel of the bitmap, read
it back), or after the page's WebGPU fence (`onSubmittedWorkDone` after a
one-pixel copy on Pixi's queue)? Both are correct. **Answer:** the fence. The
proof buys no throughput in any cell that plays and costs the page 10–20 more
points of main-thread time with several sessions.

## Probe and environment

- Windows 11, i5-13400, RTX 3050, 60 Hz. A bench build that could switch the
  two strategies; H.264 60 fps sources, a 3-slot pool, 8 s windows, two rounds
  in opposite order, a remote viewer connected throughout.
- Each delivered frame carried a gray marker that was checked against its PTS:
  no mismatch in about 21 000 checked frames.
- fps is frames consumed per stream; busy is the page event loop's lag share
  of the window.

## Result

| Cell | fence fps | busy | proof fps | busy | proof cost per frame (p50) |
|---|---|---|---|---|---|
| 1080p × 3 | 59–60 | 13–15 % | 54–60 | 24–25 % | 1.5–1.7 ms |
| 1080p × 6 | 60 | 29–31 % | 58–60 | 39–47 % | 0.8–1.1 ms |
| 4K × 1 | 51–54 | 32–41 % | 55 | 36–37 % | 5.4–6.5 ms |
| 4K × 2 | 59 | 31–34 % | 57–59 | 52–56 % | 4.6–5.0 ms |
| 4K × 3 | 1–5 | 87–93 % | 9–10 | 98–99 % | 2.5–10 ms |

The proof leads only at 4K × 3, which neither strategy plays (the GPU is
saturated). It stays the fallback for a page with no WebGPU device to fence
on.
