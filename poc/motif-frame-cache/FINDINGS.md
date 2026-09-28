# Motif cache and capture transport

For the subsequent full-bake comparison of PNG, RGBA IPC and native GPU
readback, plus the capture-reuse experiment, see [BAKE-FINDINGS.md](BAKE-FINDINGS.md).

Electron 44.1.1, Windows, local D3D11 GPU. Reproduce from the repository root
after `npm run napi:build` in `apps/desktop`:

```sh
node poc/motif-frame-cache/run.mjs --gpu
node poc/motif-frame-cache/run.mjs --gpu --png path/to/a/local/frame.png
node poc/motif-frame-cache/run.mjs --osr
node poc/motif-frame-cache/run.mjs --osr --fixed
```

Inputs are read-only. The default image and HTML are synthetic. Generated
frames, isolated Electron profiles, and JSON results live under `.scratch/`.
The GPU cases need Windows and the rebuilt core addon; no FFmpeg component.

## Disk cache

Thirty timed repetitions after five warmups, including main-to-renderer IPC
and ImageBitmap construction. A local 1920×1080 frame measured approximately
31 ms for PNG, 27 ms for raw RGBA, and 27 ms for LZ4 RGBA. Bitmap creation fell
from 27 ms to 3.3 ms, but copying 8.3 MB over ordinary IPC erased much of the gain.
PNG was 1.86 MB, LZ4 1.88 MB, raw 8.29 MB. This is one frame, not a universal
compression-ratio or throughput claim: the synthetic alpha/noise fixture's LZ4
is much larger than PNG.

Native reading/decompression followed by a persistent D3D11 slot avoids that
pixel IPC. Alpha must be premultiplied before upload: Electron interprets the
imported RGBA texture as premultiplied. Omitting this passed an opaque fixture
but failed over six million channels on the synthetic alpha fixture. With the
conversion, PNG/raw/LZ4/GPU all produce exactly the same Canvas readback bytes.
The synthetic GPU path measured about 19 ms, including its read-completion
barrier; it is not end-to-end zero-copy.

An isolated actual editor project with the LZ4 frame cache populated reached
165 bound frames over 5.5 seconds, zero cache misses and zero live captures.
Full frame reads averaged 24.4 ms in the final build. Main recorded 227 texture reads (including
warming), confirming this was the GPU path. A preliminary run overlapped
compilation and tests and was slower; performance runs must be isolated.

## Live capture

`osr.cjs` bundles the actual production capture module and clock runtime, then
compares shared-texture output with CDP PNG at the same frozen time. It covers
60 forward/reverse/repeated seeks, settle settings 0/1/2, text, partial alpha,
Canvas and alternating viewport sizes. `--fixed` keeps a stable viewport.

Naively awaiting the next paint failed: invalidate can emit a paint with no
shared texture, short settling returned old frames, and viewport resize could
clear Canvas after the requested frame had rendered. The production path now
settles resize before rendering, uses two native rAFs without advancing virtual
time, and restarts capture for static/repeated seeks. Both 60-frame variants
then passed with zero differing bytes. The fixed-size run averaged 41.6 ms
for shared capture versus 63.8 ms for PNG (including first-open setup).
Alternating-size measurements in this harness include re-importing the pool;
production retains pools by size/format, bounded by 128 MiB / eight pools.

This is Windows evidence. Other platforms retain PNG capture and CPU LZ4
loading. `WEFTCUT_MOTIF_CAPTURE=png` selects the previous capture output for
diagnosis. A shared capture failure disables that output for the process and
falls back to PNG. Deterministic time, authoring capabilities and export frame
selection remain shared.
