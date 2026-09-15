---
status: accepted
---

# The Linux slice is the same three engines at the same upstream versions

[ADR 0039](0039-first-app-managed-local-content-is-windows-whisper-cpp-base.md),
[ADR 0043](0043-second-content-slice-is-windows-funasr-paraformer.md) and
[ADR 0055](0055-third-content-slice-is-windows-qwen3-vl-4b-on-llama-mtmd.md) each
shipped a Windows x64 artifact and each explicitly deferred Linux. The catalog
schema was built for that phasing — `platforms` is a map, and an item with no
entry for the running platform reports `unavailable` — so on Linux every managed
row read "Automatic downloads are unavailable on this platform", and
transcription and video understanding were reachable only by locating files by
hand or by pointing the app at a cloud provider.

Nothing about those three decisions was Windows-specific except the artifacts:
the engines are external CLIs the Rust backends spawn by configured path, with
no `cfg(windows)` anywhere in `speech/` or `vlm/`.

## Decision

Linux x64 gets the **same three engines at the same upstream versions**, so a
platform is a set of artifacts rather than a new engine story:

- whisper.cpp **v1.9.1**
  [`whisper-bin-ubuntu-x64.tar.gz`](https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-ubuntu-x64.tar.gz),
  9,379,235 bytes, SHA-256
  `f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5`;
  entry point `whisper-bin-ubuntu-x64/whisper-cli`.
- sherpa-onnx **v1.13.4**
  [`sherpa-onnx-v1.13.4-linux-x64-shared.tar.bz2`](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-linux-x64-shared.tar.bz2),
  27,801,563 bytes, SHA-256
  `18887dc13c7d313d0e0f6c164ed31715c27c1c2c4f71acd7c0147dc84cf02514`;
  entry point `sherpa-onnx-v1.13.4-linux-x64-shared/bin/sherpa-onnx-offline`.
- llama.cpp **b10103**
  [`llama-b10103-bin-ubuntu-vulkan-x64.tar.gz`](https://github.com/ggml-org/llama.cpp/releases/download/b10103/llama-b10103-bin-ubuntu-vulkan-x64.tar.gz),
  32,238,620 bytes, SHA-256
  `ca2c3db8aa2787b2e49655460787190d0619caeeff259ffa1bf909fe5133264d`;
  entry point `llama-b10103/llama-mtmd-cli`.

Each digest is GitHub's own release-asset digest AND the hash of the locally
downloaded file; the four model entries (Base, Paraformer-zh, the Qwen3-VL GGUF
and its projector) are platform-independent data and repeat their Windows
artifact byte for byte.

**Each variant matches the Windows reasoning rather than re-opening it.** The
whisper.cpp Linux tarball carries only the `libggml-cpu-*.so` set, which is
ADR 0039's CPU-only choice arriving as the only available choice. sherpa-onnx's
`shared` build is the twin of the Windows `shared-MD` one — not `static`
(385 MB), not the CUDA variants, which would pin a toolkit the app does not
ship. llama.cpp is again the Vulkan build for ADR 0055's superset argument: that
archive carries `libggml-vulkan.so` *and* the full CPU backend set, so a machine
with no Vulkan driver runs exactly what the CPU archive would have given.

**Config field paths move from the item to the artifact.** A catalog item used
to name the config fields its files fill once, next to its consumer tag. Those
paths are the layout *inside one platform's archive* — `Release/whisper-cli.exe`
against `whisper-bin-ubuntu-x64/whisper-cli` — so they now live on
`ContentArtifact`, beside the `entryPath` they always agreed with. The
alternative, an item-level default with a per-platform override, would have made
the same question answerable from two places. `prerequisiteKey` moved for the
same reason: the MSVC v14 note is a fact about the Windows payload, and a Linux
row must not inherit it.

**The extractor sniffs the compression.** Two of the three Linux runtimes are
`.tar.gz` where Windows shipped `.zip`, so the Rust `content_extract_archive`
command reads the leading magic bytes and builds a gzip or bzip2 decoder. The
catalog still declares `archive`, which keeps the lane choice (tar vs zip vs raw
payload) explicit; what it does not do is make the TypeScript side carry a
second tar dep. The sha is verified before extraction runs, so sniffing chooses
a decoder for bytes that are already known to be the pinned artifact.

**The tar lane is load-bearing on Linux in a way it was not on Windows.** Both
gzip runtimes resolve their libraries through `RUNPATH=$ORIGIN`, and both ship
versioned `.so` files behind symlinks (`libwhisper.so.1` →
`libwhisper.so.1.9.1`). `tar::Entry::unpack_in` applies entry modes and
recreates symlinks; the zip lane, whose payloads are Windows-only, does neither.
An extractor that flattened either would install a runtime that passes the
status check and then fails to start.

**No new prerequisite note.** The three binaries need glibc ≥2.34 (whisper.cpp
and llama.cpp) and ≥2.17 (sherpa-onnx), read from their own symbol tables. The
app's own Linux build already requires glibc ≥2.38 for the bundled libva
(`docs/platform-codecs.md`), so every payload here is below the floor the app
already sets, and a Linux artifact carries no `prerequisiteKey` at all.

## Consequences

- On Linux x64, Transcription and Video understanding install from Settings with
  no file picking: Whisper Base, Paraformer 中文 and Qwen3-VL-4B all report
  `supported`, and the autofill wires their paths the way it does on Windows.
- macOS remains the uncovered platform — its rows still read "Automatic
  downloads are unavailable on this platform", and the custom-model and
  cloud/endpoint paths remain its answer.
- A catalog invariant now pins that every item covers Linux: a half-covered
  engine would offer a download that installs a runtime and then reports the set
  incomplete, which is the same trap ADR 0055 avoided for MiniCPM-V.
- Automatic upgrades, arm64 (Linux or macOS), the CUDA/ROCm/SYCL llama.cpp
  variants, and GPU-accelerated whisper.cpp on Linux stay out of this slice.
