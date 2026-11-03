---
status: accepted
---

# Local engines are pinned upstream artifacts, one version per engine on every platform

Date: 2026-10-31

## Context

The local speech and vision engines are external CLIs the Rust backends spawn
by configured path; nothing in `speech/` or `vlm/` is platform-specific. Users
should get them from Settings without locating files, but a mutable "latest"
URL would let upstream change what installs. The app ships no GPU vendor
toolkit or driver (CUDA, ROCm, SYCL). Upstream publishes, for the chosen
versions:

| Engine | win32-x64 | linux-x64 | darwin-arm64 |
|---|---|---|---|
| whisper.cpp v1.9.1 | CPU zip | CPU-only tarball | xcframework only, no `whisper-cli` |
| sherpa-onnx v1.13.4 (FunASR) | `shared-MD` tar.bz2 | `shared` tar.bz2 | `shared` tar.bz2, two dylibs with broken signatures |
| llama.cpp b10103 (video understanding) | Vulkan zip | Vulkan tarball | Metal tarball |

Measured facts that shaped this: the Vulkan and Metal llama.cpp archives also
carry the full CPU backend set, so a machine with no GPU driver runs what the
CPU archive would give. On Apple Silicon a Mach-O whose signature does not
cover its bytes is SIGKILLed at load (exit 137); sherpa-onnx's
`libonnxruntime*.dylib` ship that way. The Linux runtimes resolve libraries
through `RUNPATH=$ORIGIN` and versioned `.so` symlinks. sherpa-onnx and the
Paraformer model publish only tar.bz2; the model hangs off the rolling
`asr-models` tag.

## Decision

- **Every artifact is pinned** by versioned URL, byte count and SHA-256 in
  `src/shared/content-catalog.ts`; models pin an exact revision. A new upstream
  version is a new catalog entry through an ADR update, never an edit in place.
  The SHA-256 carries the trust, which is why a rolling tag is tolerable.
- **One upstream version per engine on every platform**; a platform is a set
  of artifacts, not a new engine story. Models are the same bytes everywhere.
- **CPU-only whisper.cpp on Windows and Linux**; llama.cpp takes the
  GPU-plus-CPU superset archive. A GPU whisper build there would pin a vendor
  toolkit.
- **The macOS whisper-cli is built by this project** from commit `f049fff9`
  (tag v1.9.1), static, Metal + Accelerate with the shader library embedded
  (`GGML_METAL_EMBED_LIBRARY`), deployment target 13.0, by
  `scripts/build-whisper-cli-macos.mjs` on a pinned `macos-15` runner
  (`.github/workflows/content-whisper-cli.yml`), published to the
  `content-whisper-cli-v1.9.1` release with `--latest=false` so the updater
  never sees it. The pin is the published asset's digest, not a local build
  (another Xcode yields other bytes). Metal is acceptable here because it is
  part of the OS; a Metal and a CPU run of one clip differed only in casing and
  one proper noun.
- **darwin installs ad-hoc re-sign** (`codesign --force --sign -`) every
  Mach-O that fails `codesign --verify`, after extraction and before the
  install is renamed into place (`sealInstall`, `main/contentSign.ts`). Valid
  upstream signatures are left alone. Downloads go through `net.fetch` +
  `node:fs`, so no quarantine attribute is set and Gatekeeper is not involved.
- **Tar archives extract in Rust** (`content_extract_archive`), gzip or bzip2
  sniffed from magic bytes after the SHA check. The tar lane preserves modes
  and symlinks (a flattened Linux runtime passes the status check and fails to
  start); `tar`'s `unpack` containment is the traversal guard. Zip stays in
  main (fflate) for Windows payloads.
- **Coverage invariant**: an engine's items are offered on a platform all
  together or not at all, so no row installs half an engine
  (`content-catalog.test.ts`).
- Windows payloads carry `prerequisiteKey: content_prereq_msvc14` (VC++ v14
  x64 runtime, installed through ADR 0064's preparation step).

## Consequences

- All three engines install from Settings on win32-x64, linux-x64 and
  darwin-arm64; manual paths and network engines remain the alternative.
  darwin-x64 and arm64 Linux have no managed content.
- The macOS whisper-cli is the one runtime whose provenance is this repo (the
  commit, the script, the CI run). It runs on the GPU, so its output can
  differ slightly from Windows/Linux.
- The Linux whisper.cpp and llama.cpp runtimes need glibc ≥ 2.34 (sherpa-onnx
  ≥ 2.17), above the app's own 2.28 floor (ADR 0143), and carry no
  prerequisite note.
- Licensing: runtimes are MIT / Apache-2.0. Paraformer-zh also carries FunASR's
  `MODEL_LICENSE` (attribution, anti-disparagement clause); the app fetches
  from upstream on request and records name + URL in each `manifest.json`.

Rejected: CUDA/ROCm builds (vendor toolkit); sherpa-onnx `static` (231–385 MB)
and universal2 (doubles the download for an unusable x86_64 half); a JS bzip2
decoder (an order of magnitude slower on a 234 MB archive); offering the
Whisper model on macOS without a runtime.
