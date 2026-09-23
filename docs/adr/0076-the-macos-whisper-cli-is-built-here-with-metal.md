---
status: accepted
---

# The macOS whisper-cli is built here, with Metal

[ADR 0075](0075-the-macos-slice-is-two-engines-and-a-re-sign.md) brought
sherpa-onnx and llama.cpp to macOS arm64 and left Whisper out, runtime and model
together: whisper.cpp v1.9.1's only Apple asset is
`whisper-v1.9.1-xcframework.zip`, a library for linking into an app, and the
whisper backend spawns `whisper-cli` by path like every other engine. There is
no upstream macOS CLI to pin.

## Decision

macOS arm64 gets **whisper-cli v1.9.1 built by this project** and published as
a release asset of this repository:

- [`whisper-cli-v1.9.1-macos-arm64.tar.gz`](https://github.com/WeftCut/WeftCut/releases/download/content-whisper-cli-v1.9.1/whisper-cli-v1.9.1-macos-arm64.tar.gz),
  1,169,176 bytes, SHA-256
  `cda72d4951aa2adbcf4b109151fbfaa071be7fab0297acbf002f3cf5d007b8d1`;
  entry point `whisper-cli-v1.9.1-macos-arm64/whisper-cli`.
- The multilingual Base model repeats its Windows artifact byte for byte.

**The source is the upstream release, pinned twice.** The build script
([build-whisper-cli-macos.mjs](../../apps/desktop/scripts/build-whisper-cli-macos.mjs))
fetches tag v1.9.1 and refuses to build unless HEAD is commit
`f049fff95a089aa9969deb009cdd4892b3e74916`, so a moved tag cannot change what
is built. The version stays the one ADR 0073 fixed for every platform; only
who compiles it differs.

**One static binary.** The flags are

```
-DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64
-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DBUILD_SHARED_LIBS=OFF
-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=ON
-DGGML_NATIVE=OFF -DGGML_CCACHE=OFF -DWHISPER_COREML=OFF
-DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF
-DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
```

plus `-ffile-prefix-map` over the source and build directories. The deployment
target is the DMG's own `minimumSystemVersion`. The result links only `/usr/lib`
and `/System` frameworks (Accelerate, Metal, MetalKit, Foundation,
CoreFoundation); the script refuses to package anything else, strips the binary
and signs it ad hoc. The tarball carries the binary, upstream's `LICENSE` and a
`BUILD-INFO.txt` naming the commit and flags, with root ownership, a fixed mtime,
sorted entries and `gzip -n`.

**Metal is on — a deliberate departure from ADR 0039.** Windows runs
whisper.cpp CPU-only, with the CUDA/BLAS packages left out of that phase, and
Linux inherited the same answer as the only one upstream's tarball offers
(ADR 0073). A GPU build on either would pin a vendor toolkit or driver the app
does not ship. None of that holds on macOS: Metal and Accelerate are part of the
OS on every Mac the arm64 DMG installs on, there is no driver to pin, and
`GGML_METAL_EMBED_LIBRARY` compiles the shader library into the binary, so there
is no `.metallib` to keep beside it. A machine where Metal cannot initialise
falls back to the CPU backend in the same binary. The check was the output, not
the speed: a synthetic clip transcribes to the same text with Metal and with
`-ng` (CPU), differing only in casing and in one proper noun, the ordinary drift
between two backends — and the log shows `using embedded metal library` on the
M1.

**CI publishes, and the catalog pins what CI published.** The
[`content-whisper-cli`](../../.github/workflows/content-whisper-cli.yml)
workflow is dispatch-only on a pinned `macos-15` runner, because the toolchain
is part of the bytes. It publishes to the tag `content-whisper-cli-v1.9.1`, and
a rerun whose tarball differs from the published asset fails rather than
replacing what installs were verified against. The pinned digest is GitHub's
digest for that asset AND the hash of the downloaded file — not a local build:
a build on another machine with a different Xcode produces different bytes
(a local M1 build hashed `a1c736d8…3563`). The build is reproducible on one
toolchain — two builds from different work directories hash equal — which is
what makes the published bytes checkable, not what makes them the pin.

**The release stays out of the updater's way.** The app's updater runs with
`allowPrerelease` off, which resolves releases through GitHub's
`/releases/latest`. The workflow creates the content release with
`--latest=false`, so the newest app release stays "Latest" and the updater never
sees a content tag.

**Bumping.** A new whisper.cpp version means changing the tag and commit in the
build script and the tag in the workflow, dispatching it, and adding the new
asset's digest as a new catalog entry through an ADR update — the same rule
every other pinned artifact follows.

## Consequences

- On macOS arm64, all three engines install from Settings: Whisper Base,
  Paraformer 中文 and Qwen3-VL-4B, with the autofill wiring their paths.
- This is the one runtime in the catalog whose bytes this project produces. Its
  provenance is the upstream commit, the committed script and the CI run that
  published it, rather than an upstream release page.
- Whisper on macOS runs on the GPU where Windows and Linux do not, so the same
  clip transcribes faster on a Mac and may differ from the other platforms in
  casing or punctuation.
- darwin-x64, Core ML encoders, and a GPU whisper.cpp on Windows or Linux stay
  out of this slice.
