# Platform codec capabilities and verification

The capability matrix per platform, the hardware evidence behind it, and the
platform boundaries the code works around. Dated items are observations on
named hardware, not promises about future Chromium, FFmpeg or driver versions.
Open platform work is tracked in [#35](https://github.com/WeftCut/WeftCut/issues/35)
and [#21](https://github.com/WeftCut/WeftCut/issues/21); see the end of this page.

## Encode and decode matrix

| Path | Windows | Linux | macOS (Apple Silicon) |
| --- | --- | --- | --- |
| Export hardware encode priority | NVENC → QSV → AMF | NVENC → VAAPI | VideoToolbox |
| Hardware encode verified | H.264 + HEVC NVENC, RTX 3050 | H.264 + HEVC NVENC, RTX 3050 | H.264 + HEVC VideoToolbox |
| Encode fallback | Software encoder selected by the registry | Same | Same |
| Lite engine export decode | WebCodecs hardware allowed | Software (`hwExportDecodeAllowed`) | WebCodecs hardware allowed |
| Standard engine export decode | Software FFmpeg session | Software FFmpeg session | Software FFmpeg session |
| Standard engine hardware preview | d3d11va shared texture | nvdec / vaapi copy-back | videotoolbox copy-back |
| Hardware preview transport | RGBA shared texture, converted natively (ADR 0032) | NV12 ship-bytes | NV12 or I420P10 ship-bytes |
| Hardware preview eligibility | 8-bit H.264 / HEVC / VP9 | 8-bit H.264 / HEVC / VP9 | H.264 / HEVC / VP9 / ProRes; 10-bit admitted |

- The encoder registry (`native/src/export/encoder_registry.rs`) owns
  candidates, real availability probes and software fallback. Its status-log
  entry names the encoder actually selected; a listed adapter is not proof.
  QSV, AMF and VAAPI encode are unmeasured because NVENC won selection or the
  GPU was absent (#35).
- Preview eligibility lives in `shared/hwLaneEligibility.ts` (seek-validated
  per lane; it narrows the one-frame probe, never overrides a negative verdict).
  AV1, MPEG-2 and intra formats other than ProRes-on-VideoToolbox never probe
  hardware.
- Hardware vs software is private to the Standard engine. Export freezes its
  own per-media routing at export start; do not infer it from preview
  priority (ADR 0030, ADR 0033).

## Hardware gates

A hardware pass means the spec asserted engagement of the named lane; a skip
means nothing was measured. Gates record the engaged lane, the probe
diagnostic and a per-clip fallback count around sampling. Timeout, crash,
IPC/admission failure, unknown rejection and any runtime fallback fail the
gate. Only affirmative unavailability may skip: no advertised/eligible lane,
no render device, a software frame observed during probing, a Linux inventory
without NVIDIA, or a Windows inventory of only Microsoft software adapters.
Missing fixtures or components are setup failures. Cache entries without a
cause are not unavailability evidence; audits use fresh profiles.

On macOS the VideoToolbox H.264 (all four color charts) and HEVC Main10 cells
are mandatory; ProRes is host-dependent. `WEFTCUT_REQUIRE_HW_VARIANTS`
(comma-separated: `nvdec-h264`, `vaapi-h264`, `d3d11va-h264`,
`videotoolbox-h264`, `videotoolbox-hevc10`, `videotoolbox-prores`) makes more
variants mandatory; unknown names fail configuration. It tightens assertions
only; product software fallback is unchanged.

Copy-back sessions check every received frame against the selected hardware
surface format before packing. A CPU frame in a hardware session reports
`hardware surface lost` and enters software-session recovery, so a hardware
label never covers software frames.

`preview-hw-color` measures matrix/range per engaged lane; natural-content SSIM
alone misses those errors (ADR 0032). Shared-texture ordering cells are
Windows-only; copy-back lanes have their own ordering cell. The opt-in
index-encoded fixture comes from `node scripts/gen-order-fixture.mjs` in
`apps/desktop/e2e`. Hosted CI has no GPU decode engines and skips these gates;
native-decode CI coverage is in
[the E2E guide](../apps/desktop/e2e/README.md#native-decode-ci-coverage).

## Hardware evidence

| Host | Result | Date |
| --- | --- | --- |
| Windows, RTX 3050 | H.264 + HEVC NVENC selected; d3d11va preview conformance, color (4/4, worst patch error 1–2 of 8 tolerated) and ordering green | 2026-07-23, 2026-08-31 |
| Linux, RTX 3050 + Intel iGPU | nvdec and vaapi preview green (both render nodes present in NVIDIA-exclusive mode); color 8/8, errors 2/1/1/1 per lane | 2026-08-12, 2026-09-03 |
| macOS, base M1 (MacBookAir10,1) | H.264 SSIM 0.982; HEVC Main10 I420P10 SSIM 0.9975; videotoolbox color 4/4, errors 1/1/1/2 | 2026-09-04 |
| macOS, M3 (Mac15,12) | ProRes I420P10 SSIM 0.9966 (floor 0.96); native export wedges 8/8; ProRes fidelity 2/2 (native 0.852 vs proxy 0.822); 10-bit ramps ~872 levels | 2026-09-02 |

Pinning an absent lane on each host produced clean skips.

## Platform boundaries

### 1. Linux WebCodecs hardware frames export black

On Linux/NVIDIA a hardware-decoded `VideoFrame` is an opaque GPU handle every JS
read path returns as zeros, with no decoder error (2026-07-21: SSIM 0.423,
indices aligned; NVIDIA-exclusive mode did not help). Windows (0.907–0.912) and
macOS (0.896–0.898) were faithful. `hwExportDecodeAllowed`
(`render/exportDecodeRouting.ts`) is an allowlist: Windows and macOS may
prefer hardware; Linux and unknown platforms pin software.

### 2. VAAPI copy-back and libva

The BtbN ffmpeg calls `vaMapBuffer2` (libva ≥ 2.21) during copy-back; on an
older libva (Ubuntu 24.04 ships 2.20) its implib trampoline aborts the process
on the first mapped frame while decoder open and the one-frame probe succeed.
The component bundles conda-forge libva 2.22 (+ libva-drm; glibc 2.17 floor,
ADR 0143), pins it with `RTLD_NODELETE`, and advertises VAAPI only when
`vaMapBuffer2` resolves (`vaapi_copyback_supported`); otherwise VAAPI sources
decode in software. libva then dispatches to the system driver's
`vaMapBuffer` when the driver predates the symbol. Local VAAPI conformance:
SSIM 0.983. Render-node numbering changes across boots; enumerate the nodes
and use the actual Intel node for `vainfo`. Cross-distro system-libva coverage
is #35.

### 3. AV1 capability probes can over-promise

On the recorded GPU, WebCodecs support probing succeeded but hardware AV1
decode failed without frames. `probeSourceDecodable` retries once with
`prefer-software` before declaring a source undecodable.

### 4. H.264 High10 is a software case

The recorded NVIDIA hardware has no Hi10P decode. The 10-bit WebCodecs lane
requests software. AV1 10-bit hardware decode emits opaque frames; software
gives copyTo-able I420P10.

### 5. ProRes range metadata

FFmpeg n7.1.5's ProRes encoders wrote primaries/transfer/matrix to the MOV
`colr` atom but no range; ffprobe reports `color_range=unknown`.

### 6. FFmpeg build identity matters

Builds differ in flags and encoders (one master build removed `-vsync`;
johnvansickle lacks libsvtav1). The GPL encode sidecar
(`scripts/fetch-ffmpeg.mjs`) and the LGPL shared decode runtime
(`scripts/fetch-ffmpeg-lgpl.mjs`) have different roles. The LGPL fetch script
is a Rust-artifact cache input: it selects the headers and co-located
libraries cached beside the decode addon.

### 7. An exe-adjacent FFmpeg shadow must not win

A stale ffmpeg beside the Electron executable silently forced software on
Linux and masked a Rosetta problem on macOS. The single resolver in
`native/src/ffmpeg` prefers the controlled PATH-resolved executable, walking
PATH explicitly (Windows process lookup starts in the application directory),
and refuses an adjacent shadow when that executable is reachable. All native
spawn sites use it; status logs name the binary and any refused shadow. An
adjacent executable is used only when no PATH candidate exists (the degraded
auto-download case; Linux never auto-downloads).

### 8. Render nodes and GPU mode

NVIDIA-exclusive mode kept the Intel render node on the Linux bench; that is
host evidence, not a driver guarantee. Enumerate DRM nodes and check the
engaged lane.

### 9. macOS FFmpeg must be native arm64

An x86_64 sidecar under Rosetta failed HEVC VideoToolbox session creation
with `-12908` (5/5); native arm64 passes. The macOS sidecar is a versioned,
SHA-256-pinned arm64 build.

### 10. WebCodecs encode hardware hints are mandatory

Chromium treats `hardwareAcceleration: "prefer-hardware"` on `VideoEncoder`
as a requirement and rejects codecs with no hardware encoder on that machine
(observed: H.264 on Linux; codecs without a WebCodecs hardware encoder, such
as AV1, on Windows RTX hosts). `encoderHwHint` (`shared/exportSettings.ts`) therefore
omits the hint under `auto` on every platform and sends `prefer-software`
only for a user's software pin; `smokeEncode` matches it. Do not infer encoder
support from decoder support.

### 11. VideoToolbox ProRes depends on silicon

Base M1 has no ProRes decode engine; the probe declines and ProRes decodes in
software. M1 Pro/Max and M2+ engage it (verified on M3). FFmpeg release/8.x
requires hardware for every VideoToolbox codec except HEVC; master switched
ProRes to "enable", which may open VT software sessions on base M1. Recheck at
an FFmpeg upgrade.

### 12. Export-from-original needs a proven Worker decode

`export_decodable_statically` (`jobs/proxy_decision.rs`) admits an original to
the export axis only for H.264 or AV1 in an 8-bit browser-friendly pixel
format; everything else exports from an H.264 full proxy. Export decodes in a
Web Worker, whose capability can differ from the main thread:
`VideoDecoder.isConfigSupported` returns true for codecs that then fail, HEVC
needs the Windows "HEVC Video Extensions" (absent on the reference machine),
and VP9 Worker decode is unverified. Admit a codec only after a real Worker
`decode()` succeeds. An AV1 export once wedged at frame 0 because of a PTS-grid
bug in `ExportFrameStore.waitForPts`, not Worker AV1 decode. On machines that
cannot decode an admitted codec, the pre-flight probe route-corrects the source
([render.md](render.md#export-source-resolution)).

## Where unfinished work belongs

- **#35:** macOS window restoration; P3 color-pick/readback; cross-distro
  VAAPI; unmeasured QSV/AMF/VAAPI encoders; Windows/macOS degraded
  auto-download and SOCKS; ProRes-engine Mac throughput/seek baseline
  ([decode-bench.md](decode-bench.md#macos-videotoolbox-copy-back)).
- **#21:** native hardware export decode (profiling-gated), wider 10-bit
  hardware-preview transport/eligibility, Intel decoder-util sampling. A codec
  is admitted only when the hardware and transfer format support it.
- **#37:** the Windows backward-cell test budget.
- **#11:** release acceptance, including installer install and launch.
