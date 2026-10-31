# Native GPU → NVENC feasibility benchmark

Experimental, standalone Linux/NVIDIA benchmark. It is **not connected to the
editor export path** and must not be selected by a capability-only test.

The program renders synthetic moving rectangles in an NVIDIA EGL/GLES texture,
imports an EGLImage through CUDA/EGL, and feeds NVENC from a CUDA allocation.
The `gpu` mode copies device-to-device only; `cpu` mode deliberately copies
the same pixels through a host buffer and uploads them again. Both use the
same NVENC H.264 P4 / CBR 8 Mbit/s settings, 120 frames, 1920×1080 at 30 fps.
The compressed bitstream is written on the CPU in both cases. Output is an
Annex-B H.264 stream, not a muxed MP4; remuxing was measured separately.

Build dependencies: EGL/GLES development headers, CUDA Driver/EGL headers,
NVENC `nvEncodeAPI.h` from nv-codec-headers n13.0.19.0, and the host-injected
`libcuda.so` / `libnvidia-encode.so.1`. No CUDA compiler is required. Example:

```sh
g++ -std=c++17 -O2 egl-nvenc-bench.cpp -I/path/to/cuda/include \
  -I/path/to/ffnvcodec -lEGL -lGLESv2 -lcuda -ldl -o egl-nvenc-bench
timeout 30 ./egl-nvenc-bench gpu /tmp/native-gpu.h264
timeout 30 ./egl-nvenc-bench cpu /tmp/cpu-roundtrip.h264
```

Use isolated processes and new output paths: the sample overwrites the named
benchmark output. It is a bounded research program, not a production resource
manager; OS process exit reclaims resources if a GPU API operation fails.

## Evidence: RTX 4090, host 168, 2026-10-30

After warmup, five alternating-order runs per mode:

| Path | Median elapsed, 120 frames | Median throughput | Median transfer time |
| --- | ---: | ---: | ---: |
| GPU → GPU → NVENC | 240.976 ms | 497.976 frames/s | 10.717 ms |
| GPU → CPU → GPU → NVENC | 479.719 ms | 250.146 frames/s | 240.221 ms |

Ratio: 1.991×. The CPU roundtrip moves 1,990,656,000 uncompressed bytes per
run; the GPU path moves no uncompressed pixels through host memory. This is
not a measurement of the editor, its decoder, text/Motif pipeline, IPC or mux.
No user project or timeline was changed by the benchmark.

The final streams each contain 334,838 bytes and have identical SHA256:
`20a71b5d033bf8facc89b23a169fce386b256aadb69f3bb7c0c0da4e726544c7`.
The remuxed samples probe as 4.000 seconds, 1920×1080, 30 fps, H.264 yuv420p,
BT.709, intentionally without audio. A side-by-side decoded frame was inspected.
Bitstream identity verifies these two sample outputs, not lossless H.264
relative to the original GPU pixels.

## Integration gate not met

Isolated Electron 44.9.3 probes on the same NVIDIA GPU found no hardware
VideoEncoder configuration for H.264, HEVC or AV1. Enabling the accelerated
encoder features did not change that result. A healthy ANGLE GL renderer and
a checked nonzero canvas pixel did not produce an offscreen shared texture
within the bounded probe. The Wayland/Vulkan variant lost its own GPU process;
a headless Vulkan variant did not preserve a valid renderer. These flags were
not applied to the user's running editor.

Consequently, the synthetic native speedup is insufficient to enable this lane.
Before integration, implement and verify a real final-composition texture lease
from Electron to the native encoder, with producer/consumer fences, exact frame
identity, cancellation, bounded queues, color/alpha handling and no hidden CPU
fallback. Then compare full-editor jobs, not only encoder-stage throughput.
The existing export path remains unchanged.

## HEVC follow-up

The optional fourth argument selects `h264` (default), `hevc` or `hevc10`.
`hevc10` allocates a real GL_RGB10_A2 source, verifies CUDA's packed
CU_AD_FORMAT_UNORM_INT_101010_2 array layout and uses NVENC ABGR10/Main10.
This is not an 8-bit input relabelled as 10-bit. Both HEVC modes use picture
timing/buffering SEI and the same P4 / 8 Mbit/s target and frame count.

Five alternating-order runs per path after warmup, same host:

| HEVC input | GPU-only median | CPU-roundtrip median | Ratio |
| --- | ---: | ---: | ---: |
| 8-bit | 262.528 ms / 457.094 frames/s | 503.476 ms / 238.343 frames/s | 1.918× |
| 10-bit | 262.443 ms / 457.242 frames/s | 503.230 ms / 238.460 frames/s | 1.917× |

Both path outputs match byte-for-byte within each codec mode:

- HEVC 8-bit, 451,791 bytes:
  `f6b4b1eaddd024143aa753bd75432b94d422b6fd40ac10d0a126285f5def570e`
- HEVC 10-bit, 302,060 bytes:
  `5d05244cfc66c2a7a23b2f3f3f7349e5dac4a8ff13e54b139d04c146064f24b3`

The decoded pixel formats are respectively yuv420p and yuv420p10le, SDR
BT.709. No HDR support or real-project quality equivalence is claimed.
The HEVC elementary streams do not expose a recoverable frame rate to the
local FFmpeg demuxer (it defaults to 25 fps). Review-only stream-copy MP4s
therefore have 4.8-second/25-fps playback, not a validated 30-fps export.
Throughput above uses the actual 120 encode calls and wall time, not container
duration. Production integration must mux explicit PTS/durations from the
project frame grid. Identical GPU/CPU review frames were inspected. Audio and
subtitles are intentionally absent from these synthetic tests.

## Native video worker (second experiment)

`video-worker.cpp` is a separate, bounded process using libav APIs, not an
FFmpeg command-line wrapper or an Electron frame consumer. It reads a local
video, requires CUDA/NVDEC frames, scales with `scale_cuda` (bicubic), encodes
with NVENC and muxes an MP4 with explicit CFR timestamps. Optional AAC packet
remux preserves payloads and trims the final sample's MP4 duration. No HTML,
Motif, text, arbitrary transforms, source trims, frame-rate conversion, HDR or
10-bit source support is claimed. Non-identity display matrices are refused;
they must never be ignored to make a benchmark pass.

Build against a coherent libav development/runtime installation:

```sh
g++ -std=c++17 -O2 -Wall -Wextra video-worker.cpp \
  $(pkg-config --cflags --libs libavformat libavcodec libavutil libavfilter) \
  -o video-worker
g++ -std=c++17 -O2 -Wall -Wextra verify-video.cpp \
  $(pkg-config --cflags --libs libavformat libavcodec libavutil) -o verify-video
timeout 60 ./video-worker /path/to/isolated-job.json
./verify-video /path/to/new-output.mp4
```

This experiment used Debian libav 5.1.9 packages inside QA only, not the
editor's bundled libraries. Do not mix ABIs or change the shipping FFmpeg
installation to reproduce it. `nlohmann-json3-dev` supplies the JSON header.
CUDA/NVENC support in the libav build and host GPU driver is mandatory.

Example job (the dimensions/rate must match the intended scene, never force an
arbitrary aspect ratio merely to run a test):

```json
{
  "source": "/absolute/local/source.mp4",
  "output": "/absolute/new/output.mp4",
  "mode": "gpu",
  "codec": "h264",
  "width": 1920,
  "height": 1080,
  "frames": 240,
  "fps_num": 30,
  "fps_den": 1,
  "start_us": 0,
  "copy_audio": true
}
```

Use `hevc` to test H.265; `cpu-roundtrip` deliberately downloads/reuploads the
same post-scale NV12 pixels before the identical encoder. Jobs reject unknown
fields rather than silently drop requested effects. SIGTERM/SIGINT cancel and
remove only task-owned staging files. Atomic hard-link publication refuses an
existing destination; a staging collision cannot delete someone else's file.
Output and staging stay on the same filesystem. This is not yet a production
job/resource authority or durable export finalization protocol.

### Real-media evidence: RTX 4090, 2026-10-30

An 8-second portion of an existing screen recording, 1080×2520, 30 fps,
BT.709/limited, 240 frames, AAC mono 44.1 kHz. Original aspect and full
resolution retained. Five alternating-order measured pairs per codec after a
warmup pair; wall time includes process-side open/init, decode, GPU scale,
encode and MP4 finalization, but excludes OS process launch and SSH.

| Codec | GPU-only median | RAM-roundtrip median | Ratio |
| --- | ---: | ---: | ---: |
| H.264 | 743.141 ms / 322.953 frames/s | 747.355 ms / 321.133 frames/s | 1.006× |
| HEVC 8-bit | 818.382 ms / 293.262 frames/s | 820.887 ms / 292.367 frames/s | 1.003× |

These differences are insignificant for selecting a faster production lane.
The editor's native Wayland session remained open; no claim of an isolated GPU
or statistical hardware maximum is made. In this workload encoding wait masks
much of the roundtrip cost. CPU control moves 1,959,552,000 raw NV12 bytes;
GPU mode moves zero raw pixels through RAM. Compressed packets, metadata and
audio still use RAM. Stage times in JSON are **host API submission/wait times**,
not CUDA-event measurements of individual GPU kernels.

Within each codec, verification decoded and hashed **all 240 frames**: exact
GPU/control equality, identical PTS hashes and AAC payload hashes. This does
not mean lossy NVENC is lossless versus the source, nor that it matches Pixi's
composition. Both outputs are exactly 8.000 seconds, 30 fps, yuv420p/BT.709.
Side-by-side frames were visually inspected. The source AAC was already silent;
its preservation does not establish an audible speech-mixing test. YouTube
delivery checks correctly reject this research sample's 3:7 aspect and silent
audio, and warn about absent subtitles. No content was cropped, padded or
replaced just to satisfy those delivery checks.

Ten runtime safety checks passed: unknown effect, unsupported trim, odd
dimensions, unsupported frame-rate conversion, missing source, insufficient
source duration, destination collision, unowned staging collision, cancellation
drain/cleanup and unchanged source hash. Two local structural guards also pass.

**No editor automatic selection or default encoder was changed.** A first
production integration still needs an immutable project-snapshot compiler,
feature eligibility, shared ExportJobs admission/cancellation/finalization,
existing audio mixer reuse and full-project quality/performance comparison.
Unsupported scenes must retain the established renderer, never disappear.

### Three.js optimization is a separate gate

Instancing repeated geometry, sharing materials and disposing obsolete GPU
resources can improve authored Motifs without reducing resolution. Inspect
`renderer.info` first. Our sampled Motifs already render on the harness clock,
not an independent RAF loop, and use the default pixel ratio of one. Website
advice to lower DPR, disable effects or stop static rendering cannot be copied
blindly into frame-exact export. Export must retain authored appearance and
render every requested timestamp. These ideas do not themselves bridge an
Electron canvas to NVENC; no Motif content was changed by this experiment.
