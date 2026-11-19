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
| `color-conformance.spec.ts` | 709/601 × limited/full patches stay faithful; all four DirectExport the original (`yuvj420p` is browser-friendly); the untagged SD, HD and 1280x544 charts and the two RGB-coded charts export faithfully through both decode engines, the patches the preview colour gates sample; the two full-range charts also export through the ffmpeg decode engine |
| `export_codecs.spec.ts` | AV1/HEVC/10-bit HEVC/ProRes/DNxHR codec shape and container; 10-bit distinct steps above the 8-bit ceiling |

The conform format range itself is pinned by the Rust unit test
`jobs::conform::tests::conform_format_matrix_against_real_ffmpeg`. Proxy color
self-description is pinned by `proxy_carries_source_color_tags_and_colr_atom`
and, for an RGB-coded source, by
`an_rgb_coded_source_gets_proxies_whose_tags_match_their_pixels`.

## Decode color tags

`io/probe.rs` extracts ffprobe color tags into `MediaSummary`.
`resolveSourceColor` (`render/decoder/ffprobeColorSpace.ts`) turns them into
the one complete colour every decode lane uses, per field:

1. the mapped ffprobe tag;
2. when absent: BT.709 if the ORIGINAL is at least 1280 wide or taller than
   576 lines, SMPTE 170M otherwise (`undeclaredIsHd`; width counts so that a
   cropped HD picture such as 1280x544 stays HD); limited range.

An RGB-coded original (`isRgbCoded`: `gbrp`, `rgb24`, `bgra`, `pal8`, ...) has
matrix `rgb` and full range whatever it is tagged, so an untagged QuickTime
Animation file resolves as a `gbr`-tagged libx264rgb one does. The WebCodecs
config needs exactly this: Chromium's software H.264 decoder ignores the
bitstream's RGB matrix in High 4:4:4 and follows the config.

The ffmpeg jobs that convert colour themselves (the JPEG derivatives and the
proxies, below) use the same size and RGB rules from the native crate
(`VideoStreamMeta::undeclared_is_hd`, `is_rgb_pix_fmt`); one list of cases,
`undeclaredColourGolden.fixture.json`, holds both sides.

The native lanes (software, copy-back hardware, d3d11va, native export decode)
deliver YCbCr planes, so they use it through `nativePlaneColor`: a YCbCr
source's planes keep its own colour, an RGB-coded source's planes are BT.709
limited. Each lane is opened with that value (the pack converts RGB samples
into it with an explicit matrix and range) and its frames are read back with
the same value, so the pack and the ingest cannot disagree. The WebCodecs pools pass it through `withDefaultColorSpace`
(`render/decoder/colorSpaceDefault.ts`), where a field the decode target's
container `colr` tag carries (as mediabunny reports it; mediabunny never parses
the SPS VUI) wins over it. `VideoClipSprite` then converts through the
2D-canvas snapshot ([`render.md`](render.md#frame-upload-the-snapshot-rule)).

Two lanes need help to show that colour:

- A hardware WebCodecs decoder converts by what the bitstream declares, and as
  BT.709 when it declares nothing, whatever the config says (observed on macOS
  VideoToolbox; Windows' D3D11 decoder follows the config for such a stream,
  and the rule below applies on every system so the lanes agree). A source whose matrix the rule supplied, and is not BT.709,
  therefore decodes prefer-software on the WebCodecs pools
  (`decodesInSoftwareForColour`); by the rule it is an SD picture.
- The native software pack converts a YCbCr frame's format and size, never
  its levels (`pack_sws` in `preview_sw/decoder.rs`): swscale would otherwise
  squeeze a full-range `yuvj420p` frame into limited range under a full-range
  label. An RGB frame it converts into the plane colour it was opened with;
  left to itself swscale would use BT.601 at full range.

## Proxies

Both proxy recipes (`jobs/proxy.rs`, `jobs/quick_proxy.rs`) keep a YCbCr
source's matrix and range and assert its tags (`color_args`, with the mp4
`colr` atom). An RGB-coded source is converted into BT.709 limited in the same
`scale` and tagged so (`video_filter`, `RGB_PROXY_COLOR`): its own `gbr` tag on
a YCbCr encode made libx264 abort, and an untagged one left ffmpeg's BT.601
with no tag, which the size rule read as BT.709.

The two kinds of source are separate recipes with their own versions
(`ProxyRecipe`), in the proxy's cache file name and the route's
`format_version`: the RGB recipe is at 8 / `q5`, the YCbCr recipe, whose
output did not change, stays at 7 / `q4`.

## JPEG derivatives

Thumbnails, filmstrip tiles and the MCP `media://…/frame` image are JPEGs. A
JPEG carries no colour description and every viewer decodes it as BT.601 full
range, so the extracting ffmpeg call converts each frame to that matrix
(`jobs/jpeg.rs`): from the frame's own tag when the source declares one, from
the size rule above when it declares none. Pinned by the Rust test
`bt709_red_is_red_in_the_jpeg_whether_the_source_declares_its_matrix_or_not`.

Filmstrip tiles carry a recipe number in their cache directory (`orig-2`,
`quick-2`, `full-2`) and the cache sweep deletes other directories, so a strip
never mixes tiles from before and after a recipe change. Thumbnails and cached
MCP frames have no recipe number: ones made before the conversion keep their
old colour until they are made again.

ffmpeg/swscale read an unspecified matrix as BT.601 at every size, so the
analyzer never infers a source's colour: every gate passes `--in-matrix` and
`--in-range`, including for the untagged charts.

## Running

See the e2e guide's Prerequisites and Run sections. The build must carry
`VITE_WEFTCUT_E2E=1` (`npm run build:e2e`); `npm run e2e` refuses a build
without it. The analyzer-backed gates also run in CI: electron-ci generates the
fixtures and prebuilds the analyzer.
