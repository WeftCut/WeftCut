# Motif preview and transport investigation (#62)

Local diagnostic scripts from the [macOS investigation](https://github.com/WeftCut/WeftCut/issues/62#issuecomment-6514220955).
They exercise the real Electron preview and compare four cached-frame transports.
These are opt-in measurements, not CI performance thresholds or production changes.

## Prerequisites

Use Node 24+, Python 3, installed workspace dependencies, the core native addon
with codec-2 zstd support, and an E2E app bundle. Follow the repository bootstrap
instructions for native prerequisites, then run from the repository root:

```sh
npm run build:e2e
node apps/desktop/e2e/scripts/motif-preview-bench/prepare.mjs --all
```

Preparation generates synthetic transparent Motif frames and a 61-second 4K
29.97 fps H.264 video. The default encoder is libx264; set
`WEFTCUT_BENCH_VIDEO_ENCODER=h264_videotoolbox` to use VideoToolbox on macOS.
`FFMPEG` can override the bundled encoder executable. `--video` and `--decoder`
can be used individually instead of `--all`.

The optional zstd decoder is pinned to `fzstd@0.1.1` and installed with lifecycle
scripts disabled under the ignored benchmark output directory. Application
dependencies and lockfiles are not changed. Preparation needs network access
for that isolated installation if it is not already present.

## Playback comparisons

```sh
node apps/desktop/e2e/scripts/motif-preview-bench/verify-preview.mjs --all
python3 apps/desktop/e2e/scripts/motif-preview-bench/summarize-results.py
```

The full run covers 15 cases, each with a fresh application profile and a
60-second observation window. It includes Group Full/Half/Quarter, hidden Group,
Color-only root/Group controls, root 4K Full/Half, two root 4K Motifs, a root
1080p Motif, a 2048 MiB cache experiment, and four video cases with a ready
quick proxy. Without `--all`, only the eleven non-video cases run; pass
`--expect 11` to the summarizer for that subset.

Each case records `perf.motifReader` (ADR 0154) before and after playback. The
summary reports reads per lane, Windows fallbacks, restarts, the divisor and the
reader's stage medians. It fails on a transport failure, a miss, or a divisor
that does not match Playback Resolution. Main still times `motif:read`, but
only the Windows texture lane passes through it, so `textureReadMs` stays empty
on other platforms.

For a short wiring check (not comparable performance data):

```sh
node apps/desktop/e2e/scripts/motif-preview-bench/verify-preview.mjs --all --duration-ms=3000
```

Use `--cases=shape-group-half,root-motif-4k-half` to select cases. The existing
`ISSUE62_CASES` environment variable is also accepted. `ISSUE62_OUTPUT` selects
a result filename; the summarizer accepts multiple result filenames and an
explicit `--expect` count when collecting separate batches.

Cache diagnostics discover the built module's cache objects rather than relying
on generated export aliases. This harness also uses Pixi initialization hooks,
the E2E control surface, and Electron's internal IPC handler map. It may need
adjustments when those internals change. A cache snapshot reports the populated
frame cache and aggregate allowance; it is not a new product preference.

## Transport comparisons

```sh
node apps/desktop/e2e/scripts/motif-preview-bench/run-transport.mjs
python3 apps/desktop/e2e/scripts/motif-preview-bench/analyze-trace.py
```

Do not run this concurrently with playback measurements. Each option gets three
warm-up samples and 40 interleaved measured samples:

1. Native read, full RGBA IPC, preload `ImageData` / `ImageBitmap`.
2. Main-process worker read/downscale, half-size RGBA IPC.
3. Main-process worker read/downscale, PNG deflate 1, preload bitmap decoding.
4. zstd payload IPC, renderer worker decode/downscale, bitmap transfer.

The analyzer reports outer renderer main-thread task occupancy between request
start and bitmap availability, including IPC deserialization. Subsequent canvas
draw and representative-pixel readback are timed separately. A missing >50 ms
Long Task does not imply an uninterrupted playback cadence.

## Outputs and limits

Outputs default to `apps/desktop/reports/motif-preview-bench/`, already ignored
by Git. `WEFTCUT_MOTIF_BENCH_DIR` can override it; the Python tools also accept
`--directory`. JSON exports replace known filesystem roots and credential fields.
Raw application profiles and performance traces stay in `.private/` under that
directory; keep them local. No profiles, traces, generated media, downloaded
dependencies, or machine-specific report files belong in a commit.

The fixture uses 30 synthetic periodic frames copied into 1828 independently
addressed cache files. It verifies playback of prepared frames, not capture or
bake speed. Each preview case runs once; compare observed counters without
treating differences as statistically established performance gains.

All three downscaling prototypes use nearest-neighbour. PNG uses pngjs, deflate
level 1, filter 0 and RLE strategy; it is not #89's exact encoder. The zstd
prototype validates framing/codec but omits the production reader's BLAKE3
check. Pixel checks sample a representative rectangle pixel, not the complete
image. Sparse transparent frames compress unusually well. Representative dense
content, full pixel correctness, cancellation, resource admission and lifetime
contracts still need validation before selecting a production transport.
