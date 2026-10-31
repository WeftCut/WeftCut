---
status: accepted
---

# The decode engine is a runtime overlay, and native decode ships as a conditional component

Date: 2026-07-18

## Context

- The persisted [Decode Route](../../CONTEXT.md#decode-routing) answers "which
  derivatives exist for this source". Which decoder should read the source
  depends on the machine: a GPU decode lane, the native component, whether
  WebCodecs opens the codec. A project moves between machines.
- Native decode links `ffmpeg-next` and therefore shared avcodec/avformat/
  swscale. A missing import in a `.node`'s import table fails that whole
  addon's `require()`.
- In-process decode must link an LGPL ffmpeg; the export/batch sidecar is a
  GPL build. Under the FSF plugin doctrine, a dynamically loaded module forms
  one work with what it calls; a separate `.node` file is not a separate work.
- On Linux, Electron's bundled Chromium `libffmpeg.so` exports ~840 global
  `av*` symbols and has no `file` protocol. Under ELF global symbol scope they
  interpose the component's own libavformat: every open fails
  `Protocol not found` inside Electron while the same `.node` works under plain
  Node (electron/electron#31397, closed "not planned"). PE and Mach-O resolve
  per module, so Windows and macOS are unaffected.

## Decision

- **Three layers of truth.** Disk: `DecodeRoute`, decided once by `decide()`.
  Machine: the capability cache (`<userData>/decode_capability.json`), keyed by
  lane + format class (+ DRM node for VAAPI) and wiped when the component's
  ffmpeg version or the GPU/driver identity changes. Session:
  `resolveDecodeEngine`, a pure function of the `auto`/`ffmpeg`/`webcodecs`
  setting, component presence, the session's WebCodecs verdict, the proxy
  opt-in and a "Standard failed terminally for this source" flag. It returns
  engine (Standard/Lite) × source (original/proxy) plus `ok`/`pending`/
  `unsupported`. Hardware vs software is private to the Standard engine.
  **No engine state is ever written to a media item or `DecodeRoute`.**
- **Native decode is its own addon**, `@weftcut/native-decode`, never linked
  into the core addon. Main `require`s it lazily, once, in a try/catch. Failure
  is the ordinary "not on this machine" state: Standard drops out of `auto`, the
  setting's native option is greyed with the reason, the rest of the app works.
- **The license boundary is the ffmpeg build, not the addon split.** The
  component links only a banner-gated LGPL build (checked at fetch, build and
  `afterPack`); GPL ffmpeg exists only as the sidecar behind a pipe.
- **Linux loads the component with `RTLD_NOW | RTLD_LOCAL | RTLD_DEEPBIND`**,
  OR-ed into `process.dlopen` for the one `require` (`main/native-decode.ts`).
  It cannot be a link flag: GNU `ld` ignores `-z deepbind` and no `DF_1` flag
  exists. `LD_LIBRARY_PATH` does not fix a symbol-level collision and would
  perturb Chromium's own media stack; `dlmopen` is not exposed by Node.
- **Linux links the addon with `--disable-new-dtags -rpath,$ORIGIN`** (a
  `DT_RPATH`). `DT_RUNPATH` is consulted only for direct `NEEDED`, and the BtbN
  `.so` carry no rpath, so transitive deps (`libavcodec → libswresample`) would
  not resolve. The `*.so*` ship beside the `.node` (asar-unpacked) with their
  SONAME symlinks kept relative (`cpSync(..., { verbatimSymlinks: true })`).

## Consequences

- Same inputs, same resolution; opening a project on a weaker machine
  degrades to Lite or an explicit `unsupported`, never to a stale promise.
- The core addon builds without `FFMPEG_DIR` or libclang; the component is a
  second build product (libclang is a Linux build prerequisite for bindgen).
- Deep binding is safe only while the component's sole host-shared symbols are
  `napi_*` (absent from libav*). Adding a symbol it shares with the host
  (e.g. an allocator) reopens the `dlopen(3)` `RTLD_DEEPBIND` hazard.
- Any future in-process ffmpeg consumer must link the same LGPL build.

Rejected: persisting a "last known good decoder" (stale, machine-bound);
folding native decode into the core addon behind a compile-time feature (a
missing DLL at run time would take down jobs, export and MCP); treating the
addon split as the licensing separation.
