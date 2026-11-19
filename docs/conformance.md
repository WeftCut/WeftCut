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

A colour chart's expected displayed colour is computed, never measured from
the app: `displayedColour` (`generate.mjs`) converts the authored patch into
BT.709 by the definition in § Owned conversion, reading the matrices from the
same golden the app's code is held to. The gates that read a native lane
(`preview-sw-color`, `preview-hw-color`, the ffmpeg decode engine of
`color-conformance`) expect it for the charts whose primaries those lanes
convert (BT.2020, PAL); every other chart is expected as authored.

## Gates

| Spec | Guards |
| --- | --- |
| `conformance.spec.ts` | 30 fps H.264 export: sampled frames align exactly above a loose SSIM floor (caught long-GOP deadlocks and a 301-from-300 frame-grid off-by-one) |
| `audio.spec.ts` | tone markers, drift and offset over 30/60/120 fps sources × mp4/mkv/mov; the audio-only format matrix (wav/mp3/flac/m4a/ogg; the mp3 carries cover art for `probe::detect_kind`); envelope, limiter and pan gates |
| `export-range-audio.spec.ts` | range export trims audio at the requested source time; AAC/Opus and muted settings; software video encoder alignment |
| `export_eos_tail.spec.ts` | a final GOP spanning several chunks with audio 1 s past video: completes, plans the audio-extended frame count, tail stays aligned |
| `export_overlap_same_source.spec.ts` | two copies of one media: same-phase copies share one decode pipeline (no extra dispatch); a 2 s-offset copy keeps its own source frames |
| `color-conformance.spec.ts` | 709/601 × limited/full patches stay faithful; all four DirectExport the original (`yuvj420p` is browser-friendly); the untagged SD, HD and 1280x544 charts and the two RGB-coded charts export faithfully through both decode engines, the patches the preview colour gates sample; the two full-range charts and the BT.2020 SDR (8-bit H.264, 10-bit HEVC) and PAL charts also export through the ffmpeg decode engine, which must show them converted into BT.709 primaries (§ Owned conversion) |
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

The rule maps BT.2020 non-constant luminance (`bt2020nc` → `bt2020-ncl`),
BT.2020 primaries, and the BT.2020 SDR transfers `bt2020-10`/`bt2020-12` (the
BT.709 curve, so `bt709`); PQ and HLG map to `pq` and `hlg`. A tag it does not
map counts as absent and the size rule fills it: a matrix no owned conversion
implements (constant-luminance BT.2020, ICtCp, YCgCo, SMPTE 240M) reads as an
untagged source of that size does, with `matrixAssumed` set.

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

## Owned conversion

On the native lanes the app converts the planes itself: the ingest shaders
(`Nv12Ingest`, `TenBitIngest`; GLSL and WGSL) and the d3d11va HLSL
(`native/decode/src/color.rs`). One function decides what they do with a
frame's colour, `planeConversion` (`ffprobeColorSpace.ts`): its matrix and
range, and the primaries it converts from. The numbers live in
`render/yuv/colourConversion.ts` and its Rust twin `color.rs`; both are held to
`colourConversionGolden.fixture.json` (Kr/Kb, the primaries matrices, and
reference pixels computed independently of either).

1. YCbCr → R'G'B' with the matrix (BT.709, BT.601 under both names, BT.2020
   non-constant luminance) and range. A declared BT.2020 matrix converts as
   BT.2020 whatever the primaries.
2. Primaries: when the source declares BT.2020 or `bt470bg` (EBU) primaries,
   R'G'B' is clipped to [0, 1], linearised, taken into BT.709 primaries by a
   3x3 matrix derived from the CIE xy chromaticities and the D65 white,
   clipped per channel in linear light, and re-encoded. The transfer both
   ways is BT.1886's pure 2.4 power for every SDR source: the conversion is
   display-referred (the picture as an SDR display shows it, re-shown in
   BT.709 primaries), where inverting the camera OETF would change its tone.
   A frame without the step runs a shader variant that has none.

Only those two take the step because Chromium converts exactly those on the
WebCodecs lanes (Lite preview, the WebCodecs export decode engine; its 2D
`drawImage`, observed on macOS and Windows), so converting them makes the
lanes agree. Deferred: `smpte170m` (SMPTE C) primaries, declared or assumed,
take no step on any lane, the same as Chromium gives them. That is a
temporary exclusion tied to the WebCodecs lanes, not a claim that SMPTE C is
BT.709: converting it on the native lanes alone would part them from the
WebCodecs lanes by up to about 48 steps on common SD material. It ends when
the WebCodecs lanes stop delegating colour to Chromium. Primaries the size
rule fills in for an untagged source are BT.709 or SMPTE C, so an untagged
source never takes the step.

The SMPTE C primaries matrix is implemented and held to the golden like the
others, so lifting the exclusion is a change to `planeConversion` alone.

An HDR source (PQ, HLG) is not handled by this step: no lane tone-maps,
so it takes no primaries step and a BT.2020 matrix converts with BT.709
coefficients; the right matrix without a tone map would change its colours
without making them right. A frame stamp that names no matrix or primaries
the conversions implement (only Chromium's stamp on a WebCodecs-decoded
10-bit frame can) converts as BT.709.

## HDR sources

No lane of the app converts HDR (a PQ `smpte2084` or HLG `arib-std-b67`
transfer): the owned conversion leaves such a source as it is (§ Owned
conversion), and every export is tagged SDR BT.709. The two export decode engines
therefore disagree on an HDR source, by up to 137 per 8-bit channel on the PQ
and HLG charts (measured on macOS):

- through the WebCodecs engine, Chromium tone-maps each frame to SDR in the
  2D-canvas snapshot ([`render.md`](render.md#frame-upload-the-snapshot-rule)):
  a viewable picture;
- through the native engine, the code values pass through BT.709
  coefficients into the SDR-tagged file: not.

As a temporary policy, until the app converts HDR itself, export decode
routing sends an HDR source to the WebCodecs engine under every decode-engine
setting whenever its Decode Route is not `native-sw` (`hdrTakesWebCodecs`,
`exportDecodeRouting.ts`). A `native-sw` HDR source (ProRes, DNxHR) keeps its
setting's route, so its export still depends on the setting: native under
`auto` and `ffmpeg`, its Export master under `webcodecs`.

The same policy keeps an HDR source off the 10-bit lane (`takesTenBitLane`).
That lane decodes a 10-bit H.264 or AV1 original into planes for the owned
ingest, which would pass the code values through; instead a 10-bit export
reads the Export master like an 8-bit one and is tone-mapped the same way, so
the result does not depend on the bit depth either. The export resource plan
asks the same predicate, so it sizes the decode the Worker runs.

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
The conversion is the matrix's only: a source in other primaries keeps them in
its JPEGs (§ Owned conversion).

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
