# Platform codec capabilities and verification

Updated 2026-09-05. This is the maintained reference for the capability matrix
and platform boundaries formerly tracked as a permanently open
[issue #7](https://github.com/WeftCut/WeftCut/issues/7).
That issue retains the original dated investigations and comments.
[Issue #15](https://github.com/WeftCut/WeftCut/issues/15) closed on 2026-09-05:
its three-platform verification was completed; remaining host requirements
belong to [#35](https://github.com/WeftCut/WeftCut/issues/35), and optional
implementation work belongs to [#21](https://github.com/WeftCut/WeftCut/issues/21).

A hardware pass means the spec asserted engagement of the named lane. A skip
means no measurement was made. Building an installer does not verify that a
user can install and launch it.

## Encode and decode matrix

| Path | Windows | Linux | macOS (Apple Silicon) |
| --- | --- | --- | --- |
| Export hardware encode priority | NVENC → QSV → AMF | NVENC → VAAPI | VideoToolbox |
| Hardware encode verified | H.264 + HEVC NVENC, RTX 3050 | H.264 + HEVC NVENC, RTX 3050 | H.264 + HEVC VideoToolbox |
| Encode fallback | Software encoder selected by the registry | Same | Same |
| Lite engine export decode | WebCodecs hardware allowed for eligible sources | Software by the platform allowlist | WebCodecs hardware allowed for eligible sources |
| Standard engine export decode | Software FFmpeg session | Software FFmpeg session | Software FFmpeg session |
| Standard engine hardware preview | d3d11va shared texture | nvdec / vaapi copy-back | videotoolbox copy-back |
| Hardware preview transport | Browser frame from shared texture | NV12 ship-bytes | NV12 or I420P10 ship-bytes |
| Hardware preview eligibility | 8-bit H.264 / HEVC / VP9 | 8-bit H.264 / HEVC / VP9 | H.264 / HEVC / VP9 / ProRes; 10-bit admitted |

The encoder registry owns candidate selection, real availability probes and
software fallback. Its status-log entry identifies the actual encoder,
acceleration and FFmpeg executable; an adapter being listed is not proof that
it was selected. QSV, AMF and VAAPI encode remain unmeasured on the recorded
benches because NVENC won selection, or the required GPU was absent (#35).

Hardware versus software is private to the Standard engine. Decode Route is
the source's persisted truth; Decode engine is the runtime overlay. Preview's
Automatic setting prefers Standard when available; export freezes its own
per-media resolution at export start. Do not infer export routing from preview
priority (CONTEXT.md; ADR 0030 and ADR 0033).

## Hardware evidence

- **Windows:** H.264 and HEVC NVENC selected on the RTX 3050 on 2026-07-23
  (status-log support at `61fb4d86`). The d3d11va preview conformance, colour
  and ordering gates passed on 2026-08-29 and were reconfirmed on 2026-08-31.
  The colour gate remained 4/4 green after `6e3d12f0`, with worst patch error
  1–2 out of 8 tolerated. Pinning absent vaapi produced four clean skips.
- **Linux:** nvdec on the RTX 3050 and vaapi on the Intel iGPU passed on
  2026-08-12 after the bundled-libva fix `7fbdc75e`. Both render nodes
  remained available in NVIDIA-exclusive mode. On 2026-09-03, the hardware
  colour suite was 8/8 green, 0 skipped, with errors 2/1/1/1 for each lane
  across 709-limited / 601-limited / 709-full / 601-full. Pinning absent
  videotoolbox produced four clean skips.
- **macOS:** the base M1 hardware preview measured H.264 SSIM 0.982 and HEVC
  Main10 I420P10 SSIM 0.9975. A MacBook Air M3 (Mac15,12, macOS 26.6.2,
  FFmpeg sidecar 8.1.2) also passed ProRes on 2026-09-02: I420P10,
  SSIM 0.9966 against a 0.96 floor. Native export wedges were 8/8;
  ProRes fidelity 2/2, native-vs-proxy SSIM 0.852 vs 0.822, and the
  10-bit ramps retained about 872 distinct levels.
- **macOS colour is verified, not pending:** a base M1 (MacBookAir10,1,
  macOS 26.5.2, sidecar 8.1.2) passed all four videotoolbox colour legs on
  2026-09-04, errors 1/1/1/2 out of 8. Pinning absent d3d11va yielded
  four clean skips. The report is in #15. This supersedes #7's old
  “only the videotoolbox legs remain unrun” paragraph.

`preview-hw-color` measures matrix/range correctness per engaged lane.
Natural-content SSIM alone does not catch those errors (ADR 0032).
The shared-texture ordering cells are Windows-specific; `7ed8de20` (PR #36)
added a separate copy-back ordering cell for nvdec/vaapi/videotoolbox and
gated the shared-texture cells to Windows. The opt-in index-encoded fixture
still comes from `node scripts/gen-order-fixture.mjs` in `apps/desktop/e2e`.

## CI coverage and its limits

The latest audited main run,
[33904374835](https://github.com/WeftCut/WeftCut/actions/runs/33904374835)
on `7ed8de20`, passed all 19 jobs. It includes TypeScript checks and unit
tests, build-script tests, Rust tests plus rustfmt/clippy on three OSes,
14 E2E slices, unsigned packaging on each OS, and cross-OS determinism.
The [2026-09-04 nightly](https://github.com/WeftCut/WeftCut/actions/runs/33854892205)
also passed. These runs predate the Linux-nightly decode opt-in described below.

The Stryker 10 upgrade was verified by a fresh main-branch
[mutation run 33941526966](https://github.com/WeftCut/WeftCut/actions/runs/33941526966)
on 2026-09-05: initial run 1,464 tests, final mutation score **83.77%** against
the 75% break threshold, completed successfully in about 11 minutes overall.

The main media fixtures are generated by globalSetup and explicitly cached in
CI. The two software-family benchmark fixtures (DNxHR and MPEG-2) are generated
on the serial-project carrier. The 4K ProRes memory-ratchet and hardware
ordering fixtures remain outside hosted CI.

The native-decode group was measured on `4c850942` with explicit dispatch
opt-in: Linux 3/3 green, each 16 passed / 1 hardware-only skip in 17–21 min;
Windows 3/3 failed the same backward clip-reuse test, each 15 passed /
1 skipped / 1 failed. The failure was its total test budget, not evidence of
decode instability. Evidence:
[Linux](https://github.com/WeftCut/WeftCut/actions/runs/33888127766),
[Windows](https://github.com/WeftCut/WeftCut/actions/runs/33899875905).

The workflow now selects these gates for **Linux nightly**, in the existing
slices at one worker; push/PR cost stays unchanged. Windows and macOS still
require dispatch opt-in. [#37](https://github.com/WeftCut/WeftCut/issues/37)
tracks Windows validation of the backward cell's 1,500-second total budget.
That covers the measured 800–870 seconds of analysis without changing the
export stall detector or the analyzer's 600-second per-call default cap.
The analyzer already decodes each candidate range in one FFmpeg pass.
See [the E2E guide](../apps/desktop/e2e/README.md#native-decode-ci-coverage)
for the dispatch commands.

A green macOS run does **not** verify window restoration: the audited
`e2e-timings-macos-latest-rest/parallel.json` skipped both the position/size
restore and maximized restore cells because the work area was 1024×677;
they require 1100×760. The no-drift and off-screen rejection cells passed.
The two M3 restore failures remain unresolved in #35.

## Platform boundaries

These are dated observations and implemented policies, not promises about all
future Chromium, FFmpeg or driver versions.

### 1. Linux WebCodecs hardware frames can export black

On the Linux/NVIDIA bench, hardware-decoded VideoFrames could not be read
faithfully by the export path. NVIDIA-exclusive mode did not fix it:
2026-07-21 output SSIM was 0.423 / PSNR 3.28 dB despite aligned indices.
The same force-test was faithful on Windows (SSIM 0.907–0.912) and macOS
(0.896–0.898). The `hwExportDecodeAllowed` allowlist therefore permits eligible
Windows/macOS sources (`35647f63`, `0cb604fb`) and retains software on
Linux/unknown platforms. The original all-platform workaround was superseded.
Issue #7's 2026-07-21 comments contain the broader import-path probe.

### 2. VAAPI copy-back and libva

The recorded Ubuntu 24.04 system libva lacked `vaMapBuffer2`; FFmpeg's
implib trampoline could abort on the first copy-back frame even though opening
the decoder succeeded. `7fbdc75e` bundles libva 2.22, pins the loaded library
with RTLD_NODELETE and guards symbol availability before advertising vaapi.
The bundled build requires glibc ≥2.38; an unavailable lane falls back to
software. Local VAAPI conformance passed at SSIM 0.983 without an nvdec
regression. A system-libva ≥2.21 cross-distro pass remains #35.
Use the actual Intel render node for `vainfo`; node numbering changed across
the recorded boots, so never hardcode the historical renderD128/renderD129 map.

### 3. AV1 capability probes can over-promise

On the recorded GPU, WebCodecs support probing succeeded but hardware AV1
decode immediately failed without frames. The import probe retries once in
software before declaring the source undecodable (`10301fab`). This differs
from boundary 1, where decoding succeeds but pixels cannot be read correctly.

### 4. H.264 High10 is a software case

The recorded NVIDIA hardware has no Hi10P decode path. The 10-bit H.264
WebCodecs lane requests software. AV1-10 is a separate case: hardware can emit
opaque frames, whereas the software decoder provides copyTo-able I420P10.

### 5. ProRes range metadata

The measured FFmpeg n7.1.5 ProRes encoders wrote primaries/transfer/matrix into
MOV's colr atom but no range flag; probe output was `color_range=unknown`.
The test was adjusted at `497eccae`. This is a dated encoder observation,
not a claim that range metadata is unimportant to pixel interpretation.

### 6. FFmpeg build identity matters

Different builds expose different flags and encoders: the recorded master
removed `-vsync`, and johnvansickle lacked libsvtav1 available in the chosen
Linux BtbN GPL build. The static encode sidecar and the LGPL shared decode
runtime have different roles and must not be conflated. Current selections
live in `fetch-ffmpeg.mjs` and `fetch-ffmpeg-lgpl.mjs`.
The latter must also be a Rust-artifact cache input: it selects the headers
and co-located libraries cached beside the decode addon.

### 7. An exe-adjacent FFmpeg shadow must not win

Stale auto-downloads beside Electron once shadowed the controlled sidecar:
on Linux every hardware probe silently fell back to software; on macOS an
arm64 shadow masked the old Rosetta problem. The single resolver in
`native/src/ffmpeg` now prefers the controlled PATH-resolved executable and
refuses an adjacent shadow when that executable is reachable. All native
spawn sites use it. It walks PATH explicitly because Windows process lookup
starts in the application directory. Status logs include the resolved binary
and warn when a shadow was refused.

An adjacent executable remains usable only when no PATH candidate is reachable,
which is the degraded auto-download case. Linux never auto-downloads.
Packaged-sidecar resolution was verified in #15; the remaining Windows/macOS
degraded-download and SOCKS checks are #35.

### 8. Render nodes and GPU mode

NVIDIA-exclusive mode did not remove the Intel render node on the Linux bench:
both nvdec and vaapi ran on 2026-08-12. That is host evidence, not a universal
driver guarantee. Enumerate the present DRM nodes and check the engaged lane;
VAAPI encode is still unmeasured because NVENC wins selection on that bench.

### 9. Rosetta FFmpeg and HEVC VideoToolbox

The former x86_64 macOS sidecar failed HEVC VideoToolbox session creation under
Rosetta with `-12908` (5/5), while native arm64 passed. `8f8b4fbc` replaced it
with a versioned, SHA-256-pinned arm64 sidecar; HEVC then selected hardware
and the conformance/codec suites passed. WeftCut's macOS target is Apple Silicon.

### 10. Linux WebCodecs encode hardware hints

The recorded Linux H.264 VideoEncoder rejected `prefer-hardware`; software
or an omitted hint encoded successfully. `309cd220` made the hint
platform-dependent: Windows/macOS request hardware, Linux/unknown omit it,
and an explicit user software pin stays software. The pinned-WebCodecs export
cell protects this path. Do not infer encoder support from decoder support.

### 11. VideoToolbox ProRes depends on silicon

The base M1 probe declined ProRes hardware decode; the M3 engaged it.
Both sides are verified, including I420P10 pixels and fidelity on the M3.
FFmpeg release/8.x's hardware-required setting contributed to the base-M1
failure; a future FFmpeg change may alter fallback behaviour, so recheck at
an upgrade. The M3 conformance pass did not measure the ProRes throughput/seek
benchmark; that optional measurement remains in #35 and
[decode-bench.md](decode-bench.md).

## Where unfinished work belongs

- **#35:** macOS window restoration; P3 colour-pick/readback; cross-distro
  VAAPI; unmeasured QSV/AMF/VAAPI encoders; Windows/macOS degraded auto-download
  and SOCKS behaviour; optional ProRes-engine throughput/seek baseline.
- **#21:** native hardware export decode (profiling-gated), wider 10-bit
  hardware-preview transport/eligibility, and Intel decoder-util sampling.
  A codec may be admitted only when the actual hardware and transfer format
  support it; this is not a promise of ProRes hardware decode on NVIDIA.
- **#37:** only the Windows backward-test budget and its validation.
- **#11:** release acceptance, including Windows/macOS installer installation
  and launch. Platform backlog is explicitly deferred, not silently completed.
