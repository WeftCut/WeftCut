---
status: accepted
---

# The macOS slice is two of the three engines, plus an ad-hoc re-sign

[ADR 0073](0073-the-linux-slice-is-the-same-three-engines-at-the-same-versions.md)
brought Linux x64 to parity and left macOS as the uncovered platform: every
managed row on the arm64 DMG still read "Automatic downloads are unavailable on
this platform". The same rule applies here as it did there — a platform is a set
of artifacts at the versions already chosen, not a new engine story — but only
two of the three upstream releases publish something a macOS row can install.

| Engine (version per ADR 0073) | macOS arm64 asset upstream | Usable as shipped |
|---|---|---|
| llama.cpp b10103 | `llama-b10103-bin-macos-arm64.tar.gz` | yes |
| sherpa-onnx v1.13.4 | `sherpa-onnx-v1.13.4-osx-arm64-shared.tar.bz2` | after a re-sign |
| whisper.cpp v1.9.1 | `whisper-v1.9.1-xcframework.zip` only | no — a library, no `whisper-cli` |

The app ships only an arm64 DMG
([electron-builder.yml](../../apps/desktop/electron-builder.yml)), so the slice
is `darwin-arm64` alone.

## Decision

macOS arm64 gets **sherpa-onnx and llama.cpp at the same upstream versions**:

- sherpa-onnx **v1.13.4**
  [`sherpa-onnx-v1.13.4-osx-arm64-shared.tar.bz2`](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-osx-arm64-shared.tar.bz2),
  27,044,587 bytes, SHA-256
  `809ab5d0c77bd8f358364a244e6ab17f2afecf9779eb9fd436fa469c3ff5375c`;
  entry point `sherpa-onnx-v1.13.4-osx-arm64-shared/bin/sherpa-onnx-offline`.
- llama.cpp **b10103**
  [`llama-b10103-bin-macos-arm64.tar.gz`](https://github.com/ggml-org/llama.cpp/releases/download/b10103/llama-b10103-bin-macos-arm64.tar.gz),
  10,803,401 bytes, SHA-256
  `1c07a23cf98d80b6349860b6d30f9e15548a7fd91a4b44b15e749f377b6f6246`;
  entry point `llama-b10103/llama-mtmd-cli`.

Each digest is GitHub's release-asset digest AND the hash of the locally
downloaded file. The Paraformer-zh archive and the Qwen3-VL GGUF + projector
repeat their Windows artifact byte for byte.

**Each variant repeats an earlier choice.** sherpa-onnx's `shared` build is the
twin of the Linux `shared` and Windows `shared-MD` builds — not `static`
(231 MB), not the universal2 build, which doubles the download to carry an
x86_64 half the arm64 DMG cannot use. The llama.cpp macOS arm64 archive is the
Metal build — upstream publishes no other — and carries `libggml-cpu` and
`libggml-blas` beside `libggml-metal`, the same superset shape that chose the
Vulkan archives in ADR 0055 and ADR 0073.

> **Superseded in part by [ADR 0076](0076-the-macos-whisper-cli-is-built-here-with-metal.md):**
> macOS arm64 now carries Whisper — a whisper-cli this project builds from the
> v1.9.1 commit and publishes, plus the same Base model. The paragraph below
> records why it was absent from this slice.

**Whisper is absent on macOS, runtime AND model together.** whisper.cpp v1.9.1
publishes an xcframework for linking into an app, no command-line binary, and
the whisper backend spawns `whisper-cli` by path like every other engine.
Offering the Base model on its own would install half a set that can never
configure the engine — the trap ADR 0055 avoided for MiniCPM-V. The route to a
macOS Whisper row is a whisper-cli built from the v1.9.1 tag and published as a
pinned artifact of this project's own, which is a separate decision (who builds
it, from what flags, with or without Metal) and a separate change. Until then
the Whisper row reads unavailable on macOS, and the custom-path and
cloud/endpoint answers remain.

**The install ad-hoc re-signs what fails to verify.** Apple Silicon refuses to
map code whose signature does not cover its bytes: the process is SIGKILLed at
load (exit 137), before it prints anything. The upstream sherpa-onnx osx-arm64
tarball ships `lib/libonnxruntime.1.27.0.dylib` and `lib/libonnxruntime.dylib`
in exactly that state — `codesign --verify` reports "code or signature have
been modified" — so `sherpa-onnx-offline --help` dies as extracted and runs
once those two files are re-signed with `codesign --force --sign -`. All 42
Mach-O files in the llama.cpp archive and the other 33 in sherpa-onnx's verify
as shipped.

The step is an optional `sealInstall` on the downloader's deps
([contentDownload.ts](../../apps/desktop/src/main/contentDownload.ts)), run
over the staged payload after extraction and before it is renamed into place,
so a signing failure leaves no manifest and the item never reads installed. It
is bound only on darwin ([index.ts](../../apps/desktop/src/main/index.ts)); the
logic ([contentSign.ts](../../apps/desktop/src/main/contentSign.ts)) sniffs
Mach-O headers, runs `codesign --verify` on each, and re-signs only the ones
that fail — a valid upstream signature is left exactly as shipped. It lives in
the TypeScript main process rather than in the Rust extractor because it is a
platform side effect (spawning `/usr/bin/codesign`), not decompression, and
because the downloader's other side effects are injected the same way. The
sha256 pin is unaffected: it covers the downloaded archive, verified before
extraction, and re-signing rewrites only the signature of bytes already known
to be that artifact.

**No quarantine step.** The main process downloads through Electron `net.fetch`
and writes with `node:fs`, neither of which sets `com.apple.quarantine`, so
Gatekeeper never assesses the extracted runtimes; the kernel's signature check
is the only gate, and the re-sign answers it.

## Consequences

- On macOS arm64, Paraformer 中文 and Qwen3-VL-4B install from Settings with no
  file picking, and the autofill wires their paths the way it does elsewhere.
  Whisper Base reads unavailable.
- The ADR 0073 invariant that every item covers Linux stays; a second invariant
  now holds on every platform: an engine's items are covered all together or
  not at all, which is what keeps Whisper's model out of the macOS catalog
  while its runtime is.
- An upstream bump on macOS is re-checked for the signature trap by the install
  itself rather than by a per-artifact note; a payload that still cannot be
  signed fails its install instead of passing the status check.
- darwin-x64, a macOS Whisper runtime, and a Core ML or Metal-specific tuning of
  either engine stay out of this slice.
