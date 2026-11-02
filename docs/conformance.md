# Conformance

The conformance gates drive the real built app (Playwright `_electron`), export
real media through the full pipeline, and analyze the file on disk. They cover
frame alignment, audio sync and color, not unit logic. Layout, prerequisites,
fixture generation and run commands are in the e2e guide,
[`apps/desktop/e2e/README.md`](../apps/desktop/e2e/README.md).

## Analyzer

`media_conformance` (`apps/desktop/native/src/bin/media_conformance.rs`) is an
ffmpeg-backed analyzer that runs one mode per call. Specs reach it through
`e2e/lib/analyze.mjs`, which execs the prebuilt bin (`npm run analyzer:build`).

| Mode | Measures |
| --- | --- |
| default (`--samples`) | each sampled output frame's best SSIM match within a source window (burned-in counters make it unambiguous), plus app-only conversion loss |
| `--color` | per-patch displayed-color error: output decoded by its own tags, source by forced `--in-matrix`/`--in-range` |
| `--gradient-row` | per-channel banding (distinct steps) over one decoded row |
| `--self-ssim` | two indices of the output, no source |
| `--audio` | per-second tone alignment (Goertzel), drift slope, offset, SNR |
| `--audio-envelope` | windowed RMS against analytic expectations and a peak ceiling |
| `--audio-pan` | L/R RMS ratio against an expected dB delta |

The color mode measures displayed color, not the matrix tag, because WebCodecs
output is always 709-tagged ([ADR 0014](adr/0014-export-color-perceptual-conformance.md)).

## Fixtures

`e2e/fixtures/generate-fixtures.mjs` (`MATRIX`) is the single source of truth
for the media; each entry's comment names the gate that uses it. Recipe
identity is the hash of the ffmpeg argv, recorded with the entry's output set
in `media/manifest.json`; a pass regenerates exactly the entries whose hash
moved or whose files are incomplete. There is no way to mark stale media as
trusted. Playwright `globalSetup` runs the same pass; CI caches the media per
OS because the drawtext font and the bundled ffmpeg differ per platform.
`color_baseline.json` and `gradient_baseline.json` hold the expected errors.

## Gates

| Spec | Guards |
| --- | --- |
| `conformance.spec.ts` | 30 fps H.264 export: sampled frames align exactly above a loose SSIM floor (caught long-GOP deadlocks and a 301-from-300 frame-grid off-by-one) |
| `audio.spec.ts` | tone markers, drift and offset over 30/60/120 fps sources × mp4/mkv/mov; the audio-only format matrix (wav/mp3/flac/m4a/ogg; the mp3 carries cover art for `probe::detect_kind`); envelope, limiter and pan gates |
| `export-range-audio.spec.ts` | range export trims audio at the requested source time; AAC/Opus and muted settings; software video encoder alignment |
| `export_eos_tail.spec.ts` | a final GOP spanning several chunks with audio 1 s past video: completes, plans the audio-extended frame count, tail stays aligned |
| `export_overlap_same_source.spec.ts` | two copies of one media: same-phase copies share one decode pipeline (no extra dispatch); a 2 s-offset copy keeps its own source frames |
| `color-conformance.spec.ts` | 709/601 × limited/full patches stay faithful; all four DirectExport the original (`yuvj420p` is browser-friendly) |
| `export_codecs.spec.ts` | AV1/HEVC/10-bit HEVC/ProRes/DNxHR codec shape and container; 10-bit distinct steps above the 8-bit ceiling |

The conform format range itself is pinned by the Rust unit test
`jobs::conform::tests::conform_format_matrix_against_real_ffmpeg`. Proxy color
self-description is pinned by `proxy_carries_source_color_tags_and_colr_atom`.

## Decode color tags

`io/probe.rs` extracts ffprobe color tags into `MediaSummary`; the renderer
maps them with `ffprobeColorToWebCodecs`. `withDefaultColorSpace`
(`render/decoder/colorSpaceDefault.ts`) fills each field with this priority:

1. the decode target's container `colr` tag as mediabunny reports it
   (mediabunny never parses the SPS VUI);
2. the ffprobe source tag;
3. a resolution default: height ≥ 720 → BT.709, else SMPTE 170M; limited range.

Every decode pool applies the merged `VideoColorSpaceInit`; `VideoClipSprite`
then converts through the 2D-canvas snapshot
([`render.md`](render.md#frame-upload-the-snapshot-rule)).

## Running

See the e2e guide's Prerequisites and Run sections. The build must carry
`VITE_WEFTCUT_E2E=1` (`npm run build:e2e`); `npm run e2e` refuses a build
without it. The analyzer-backed gates also run in CI: electron-ci generates the
fixtures and prebuilds the analyzer.
