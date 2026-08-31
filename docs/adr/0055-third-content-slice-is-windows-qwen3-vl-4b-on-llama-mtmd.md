---
status: accepted
---

# The third app-managed content slice is Windows x64 Qwen3-VL-4B on a Vulkan llama.cpp

[ADR 0039](0039-first-app-managed-local-content-is-windows-whisper-cpp-base.md)
proved the app-managed content flow on whisper.cpp and
[ADR 0043](0043-second-content-slice-is-windows-funasr-paraformer.md) extended
it to a second speech engine; both left "VLM content" explicitly out of scope
and pre-committed nothing about its packaging or runtime architecture.

The video-understanding subsystem
([ADR 0036](0036-pluggable-speech-backends-normalized-transcript.md)'s
architectural twin, serving `describe_clip` and `media://{id}/description`) has
been complete and tested since its own slice landed, and unreachable the whole
time: `vlm_config.json` starts empty, so every call answered "no
video-understanding backend available". Nothing stood between a user and scene
description except provisioning and a Settings surface.

## Decision

The third slice targets **Windows x64 Qwen3-VL-4B-Instruct on llama.cpp's
Vulkan build**, using these immutable upstream artifacts:

- Runtime: llama.cpp build **b10103**
  [`llama-b10103-bin-win-vulkan-x64.zip`](https://github.com/ggml-org/llama.cpp/releases/download/b10103/llama-b10103-bin-win-vulkan-x64.zip),
  33,479,917 bytes, SHA-256
  `3e3aa22631fa7d6cded90219e6e0d4d929b035280f5a9f209e535662e60eb33f`.
  The archive is **flat** (no `Release/` prefix, unlike whisper.cpp's) and the
  runtime is its whole extracted directory; entry point `llama-mtmd-cli.exe`.
  `llama-mtmd-cli.exe` and `llama.dll` dynamically import `MSVCP140.dll` and
  `VCRUNTIME140.dll`, so the Microsoft Visual C++ v14 x64 runtime is the same
  recorded prerequisite as the two speech runtimes.
- Model: **Qwen3-VL-4B-Instruct, Q4_K_M**
  [`Qwen3VL-4B-Instruct-Q4_K_M.gguf`](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf?download=true)
  at Hugging Face revision `1cd86afb9a95c410a6038ab3b40d8b578c892266`,
  2,497,281,664 bytes, SHA-256
  `66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a`.
- Vision projector: **mmproj F16**
  [`mmproj-Qwen3VL-4B-Instruct-F16.gguf`](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/mmproj-Qwen3VL-4B-Instruct-F16.gguf?download=true)
  at the same revision, 836,180,256 bytes, SHA-256
  `256f3a43bd4205ffef48d6b92715e1e70b5b0e9aef06522584967513a9985331`.

The model digests are the Hugging Face LFS object ids, which are SHA-256 by
construction; the claim was checked rather than assumed — the projector's local
copy hashes to the recorded value byte for byte.

**Three catalog items, not two.** The model and its projector are separate
downloads behind separate URLs, so they are separate entries — unlike the
Paraformer bundle, where one archive filled two config fields. This is also why
`vlmAutofillPlan` requires binary + model + **mmproj** before it writes an
entry: a GGUF without its projector is text-only, and `vlm::config::availability`
reports `NeedsModel` for exactly that state, so a two-of-three entry would only
produce a Settings row saying it is not ready.

**Vulkan, not the CPU-only archive, and it is not a tradeoff.** The Vulkan
archive ships `ggml-vulkan.dll` *and* the complete `ggml-cpu-*.dll` set, so it
is a strict superset of the CPU build: it uses the GPU wherever a Vulkan driver
exists — every current NVIDIA, AMD, and Intel Windows driver ships one — and
otherwise runs the same CPU backends the CPU archive would have provided. It
costs 33 MB against that archive's 18 MB. This does not revisit ADR 0039's
CPU-only choice for whisper.cpp; it records that a 4B vision model is a
different workload, where the measured local run was ~20 s for 8 frames on a
Vulkan RTX 3050.

**Q4_K_M and an F16 projector.** Q4_K_M is the quantization the subsystem's
spike measured and validated end to end, not F16 (8.0 GB) or Q8_0 (4.3 GB). The
projector stays F16 because it is small next to the model (797 MB against
2.4 GB) and quantizing it is where vision quality goes.

**The shared runtime claims only complete engines.** `llama-mtmd-cli` drives
MiniCPM-V as well as Qwen3-VL — spike-proven on the same frames-plus-text-marker
input path — which is why `VlmConsumer.backends` is a list. It names `qwen3_vl`
alone today: the catalog carries no MiniCPM model, and claiming that engine
would leave its Settings row offering a download that installs a runtime and
then reports the whole set present. `minicpm_v` joins that list in the same
change that adds its model and projector entries.

**Licensing.** llama.cpp is MIT; Qwen3-VL-4B-Instruct is Apache-2.0. Both
notices travel with the managed-content record, and the download manager fetches
from upstream on the user's request rather than redistributing either.

**The Settings surface.** Video understanding gets its own Settings category
beside Transcription rather than more rows under it, because it has a locality
speech does not: an OpenAI-compatible endpoint is a first-class way to run a VLM,
and it configures a URL rather than a file. The listing reuses the Rust
resolver's own `select_backend` for its "active engine" line, so the panel and
`describe_clip` cannot disagree about what would serve a call. Every row is an
editor, and the section shares no configuration with Transcription — not even a
key: the endpoint's optional API key is stored under its own `safeStorage` tag,
so a secret typed here changes nothing about transcription.

## Consequences

- Slice completion means scene description works from a fresh Windows install
  without the user locating any file by hand; manual paths remain a supported
  fallback, as does an OpenAI-compatible endpoint.
- The catalog schema gains a second consumer family (`VlmConsumer`) and two
  `kind` values; the managed-download component is now shared by both families
  and discriminates on one.
- `settings_get_vlm_backends` is the first Settings listing that takes its
  config as a call argument rather than reading a `Backend` field — the shape
  [ADR 0024](0024-stateless-compute-service.md) requires of this subsystem.
- MiniCPM-V content, non-Windows platforms, larger or smaller Qwen3-VL sizes, a
  quality-tier picker, automatic upgrades, and a local liveness "Test" probe
  stay out of this slice.
