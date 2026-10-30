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

The optional decoders are pinned (`fzstd@0.1.1`, `zstddec@0.3.4`, `hash-wasm@4.12.0`)
and installed with lifecycle scripts disabled under the ignored benchmark output
directory. Application dependencies and lockfiles are not changed. Preparation
needs network access for that isolated installation if it is not already present.

## Playback comparisons

```sh
node apps/desktop/e2e/scripts/motif-preview-bench/verify-preview.mjs --all
python3 apps/desktop/e2e/scripts/motif-preview-bench/summarize-results.py
```

The full run covers 13 cases, each with a fresh application profile and a
60-second observation window. It includes Group Full/Half/Quarter, hidden Group,
Color-only root/Group controls, root 4K/1080p Motifs, a 2048 MiB cache experiment,
and four video cases with a ready quick proxy. Without `--all`, only the nine
non-video cases run; pass `--expect 9` to the summarizer for that subset.

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

## Fair comparison

The transport comparison above uses sparse frames and skips verification. The
fair comparison runs every lane in one app on the same frames. Each lane verifies
BLAKE3 and scales with the same alpha-weighted box filter (`downscale.mjs`; the
native `motifReadFrameScaled` produces identical bytes). It needs the core native
addon built from this branch (`npm run build` in `apps/desktop/native`).

```sh
node apps/desktop/e2e/scripts/motif-preview-bench/prepare.mjs --decoder
node apps/desktop/e2e/scripts/motif-preview-bench/run-fair.mjs
python3 apps/desktop/e2e/scripts/motif-preview-bench/analyze-fair.py
```

Content: `sparse` (the fixture above), `typical` (an overlay of about 1 MB per 4K
frame) and `dense` (close to incompressible, 32.5 MB). Lanes:

| Lane | Path |
|---|---|
| a@1 | native read in main, full RGBA IPC, preload `ImageData` (macOS / Linux today) |
| e@1, e@2 | Windows texture lane; at 1/2 the native pool downscales before upload (Windows only) |
| h@2 | native read + native downscale in main, scaled RGBA over `ipcRenderer` |
| d2@2 | compressed bytes to a renderer worker: zstddec (WASM) + hash-wasm BLAKE3 + JS downscale |
| f@1, f@2 | as h, posted by main on a `MessagePortMain` straight to a renderer worker |
| g@1, g@2 | as f, from a utility process |

It checks full-image correctness against a reference, rejects a corrupted
frame, times 30 interleaved rounds per lane and content (traced), and measures
throughput with 3 reads in flight. `fair-result.json` holds per-stage native
times and main's serialization cost for lane f (`mainPost`).
`fair-thread-result.json` holds the page main-thread occupancy. A run takes
about 10 minutes.

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
