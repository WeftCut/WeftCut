// The app-managed content catalog: every artifact the app can download for
// the user, pinned to immutable versioned URLs with byte counts and SHA-256
// digests (supply-chain rule, docs/licensing.md — never a rolling "latest").
//
// Values are verbatim from ADR 0039 (Windows x64 CPU-only whisper.cpp v1.9.1
// + multilingual Base), ADR 0043 (sherpa-onnx v1.13.4 + Paraformer-zh for
// the FunASR backend), and ADR 0055 (llama.cpp b10103 Vulkan +
// Qwen3-VL-4B-Instruct Q4_K_M for the video-understanding backend). Do not
// re-derive or "refresh" them — a new upstream
// release is a NEW catalog entry with its own pinned url/bytes/sha, decided
// through an ADR update, not an edit here.
//
// content-catalog.test.ts enforces the pinning invariants over every entry.

import type { ContentItem } from "./content-download";

export const CONTENT_CATALOG: readonly ContentItem[] = [
  {
    id: "whisper-cpp-runtime",
    kind: "speech-runtime",
    version: "1.9.1",
    labelKey: "content_whisper_runtime",
    license: { name: "MIT", upstreamUrl: "https://github.com/ggml-org/whisper.cpp" },
    // The official Windows build dynamically imports the Microsoft Visual C++
    // v14 x64 runtime (MSVCP140, VCRUNTIME140[_1], VCOMP140) — ADR 0039 makes
    // that an explicit prerequisite rather than an unrecorded assumption.
    prerequisiteKey: "content_prereq_msvc14",
    speech: { backend: "whisper_cpp", fields: { binary: "Release/whisper-cli.exe" } },
    platforms: {
      "win32-x64": {
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
        sha256:
          "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
        bytes: 7982101,
        archive: "zip",
        // The runtime is the archive's complete Release/ directory (the
        // dynamically selected CPU backend DLLs must stay beside the exe).
        entryPath: "Release/whisper-cli.exe",
      },
    },
  },
  {
    id: "whisper-model-base",
    kind: "speech-model",
    // Hugging Face revision — the model file is platform-independent, but it
    // still installs under <id>/<version>/ like everything else.
    version: "5359861c739e955e79d9a303bcbc70fb988958b1",
    labelKey: "content_whisper_model_base",
    license: {
      name: "MIT",
      upstreamUrl: "https://huggingface.co/ggerganov/whisper.cpp",
    },
    speech: { backend: "whisper_cpp", fields: { model: "ggml-base.bin" } },
    platforms: {
      // Multilingual Base — neither ggml-base.en.bin nor a quantized variant
      // (ADR 0039). Byte-identical on every platform; listed per-platform so
      // coverage stays an explicit decision as other OSes phase in.
      "win32-x64": {
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin?download=true",
        sha256:
          "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        bytes: 147951465,
        archive: "none",
        entryPath: "ggml-base.bin",
      },
    },
  },
  {
    id: "funasr-runtime",
    kind: "speech-runtime",
    version: "1.13.4",
    labelKey: "content_funasr_runtime",
    license: { name: "Apache-2.0", upstreamUrl: "https://github.com/k2-fsa/sherpa-onnx" },
    // The shared-MD build dynamically links the MSVC v14 x64 runtime, same as
    // the whisper.cpp runtime above (ADR 0043).
    prerequisiteKey: "content_prereq_msvc14",
    speech: {
      backend: "funasr",
      fields: {
        binary:
          "sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe",
      },
    },
    platforms: {
      "win32-x64": {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2",
        // Double-confirmed: GitHub's release-asset digest and the locally
        // validated archive agree (ADR 0043).
        sha256:
          "d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab",
        bytes: 20034576,
        archive: "tar.bz2",
        entryPath:
          "sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe",
      },
    },
  },
  {
    id: "funasr-model-paraformer-zh",
    kind: "speech-model",
    version: "2023-09-14",
    labelKey: "content_funasr_model_paraformer",
    // Apache-2.0 per the official FunASR org's Hugging Face model card; the
    // FunASR repo's bespoke MODEL_LICENSE is the second recorded signal — both
    // in ADR 0043. The manifest's name + upstream record satisfies its
    // attribution requirement.
    license: {
      name: "Apache-2.0",
      upstreamUrl: "https://huggingface.co/funasr/paraformer-zh",
    },
    // One archive fills two config fields — model AND tokens ride together.
    speech: {
      backend: "funasr",
      fields: {
        model: "sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx",
        tokens: "sherpa-onnx-paraformer-zh-2023-09-14/tokens.txt",
      },
    },
    platforms: {
      // Platform-independent data, listed per-platform like the whisper model
      // so coverage stays an explicit decision as other OSes phase in.
      "win32-x64": {
        // ⚠️ Rolling `asr-models` release tag, not a version tag — the pinned
        // sha256 below is what carries the trust (ADR 0043): a swapped asset
        // fails verification loudly instead of installing.
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2",
        sha256:
          "9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03",
        bytes: 234051698,
        archive: "tar.bz2",
        entryPath: "sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx",
      },
    },
  },
  {
    id: "llama-mtmd-runtime",
    kind: "vlm-runtime",
    // llama.cpp build tag — the build both VLM engines are validated against.
    version: "b10103",
    labelKey: "content_llama_mtmd_runtime",
    license: { name: "MIT", upstreamUrl: "https://github.com/ggml-org/llama.cpp" },
    // Same MSVC v14 x64 dependency as the whisper.cpp runtime: llama-mtmd-cli.exe
    // and llama.dll both dynamically import MSVCP140 + VCRUNTIME140 (verified
    // against the pinned archive), so the note is shared rather than restated.
    prerequisiteKey: "content_prereq_msvc14",
    // The BINARY is engine-agnostic — one llama-mtmd-cli drives Qwen3-VL and
    // MiniCPM-V alike, which is why `backends` is a list at all. It claims only
    // qwen3_vl today on purpose: the catalog carries no MiniCPM model, so
    // claiming that engine here would leave its Settings row offering a
    // "download" that installs a runtime and then reports the whole set
    // present. `"minicpm_v"` joins this list in the same change that adds its
    // model + mmproj entries, never before.
    vlm: {
      backends: ["qwen3_vl"],
      fields: { binary: "llama-mtmd-cli.exe" },
    },
    platforms: {
      // The VULKAN build, not the CPU-only one, and not a tradeoff: this
      // archive ships ggml-vulkan.dll AND the full ggml-cpu-*.dll set, so it
      // is a strict superset — it uses the GPU where a Vulkan driver exists
      // (every current NVIDIA / AMD / Intel Windows driver ships one) and
      // falls back to the same CPU backends the CPU archive would have given.
      // 33 MB against the CPU archive's 18 MB buys that (ADR 0055).
      "win32-x64": {
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b10103/llama-b10103-bin-win-vulkan-x64.zip",
        sha256:
          "3e3aa22631fa7d6cded90219e6e0d4d929b035280f5a9f209e535662e60eb33f",
        bytes: 33479917,
        archive: "zip",
        // The archive is FLAT (no Release/ prefix, unlike whisper.cpp's), and
        // the runtime is its whole extracted directory — the dynamically
        // selected ggml backend DLLs must stay beside the exe.
        entryPath: "llama-mtmd-cli.exe",
      },
    },
  },
  {
    id: "qwen3-vl-4b-model",
    kind: "vlm-model",
    // Hugging Face revision — platform-independent data, still installed under
    // <id>/<version>/ like everything else.
    version: "1cd86afb9a95c410a6038ab3b40d8b578c892266",
    labelKey: "content_qwen3vl_model",
    license: {
      name: "Apache-2.0",
      upstreamUrl: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF",
    },
    vlm: {
      backends: ["qwen3_vl"],
      fields: { model: "Qwen3VL-4B-Instruct-Q4_K_M.gguf" },
    },
    platforms: {
      // Q4_K_M, the quantization the spike measured (~20 s for 8 frames on a
      // Vulkan RTX 3050) — not F16 (8.0 GB) or Q8_0 (4.3 GB).
      "win32-x64": {
        url: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf?download=true",
        sha256:
          "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
        bytes: 2497281664,
        archive: "none",
        entryPath: "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
      },
    },
  },
  {
    id: "qwen3-vl-4b-mmproj",
    kind: "vlm-model",
    version: "1cd86afb9a95c410a6038ab3b40d8b578c892266",
    labelKey: "content_qwen3vl_mmproj",
    license: {
      name: "Apache-2.0",
      upstreamUrl: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF",
    },
    // The vision projector is a SEPARATE download from the model (two URLs, so
    // two entries — unlike the Paraformer bundle, where one archive filled two
    // fields). Without it the GGUF is text-only and the availability probe
    // reports NeedsModel, which is why it is a first-class catalog entry rather
    // than an afterthought on the model row.
    vlm: {
      backends: ["qwen3_vl"],
      fields: { mmproj: "mmproj-Qwen3VL-4B-Instruct-F16.gguf" },
    },
    platforms: {
      // F16 projector, not the Q8_0 one: the projector is small next to the
      // model (797 MB vs 2.4 GB) and quantizing it is where vision quality goes.
      "win32-x64": {
        url: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/mmproj-Qwen3VL-4B-Instruct-F16.gguf?download=true",
        sha256:
          "256f3a43bd4205ffef48d6b92715e1e70b5b0e9aef06522584967513a9985331",
        bytes: 836180256,
        archive: "none",
        entryPath: "mmproj-Qwen3VL-4B-Instruct-F16.gguf",
      },
    },
  },
];
