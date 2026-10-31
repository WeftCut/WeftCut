# Setup

Building WeftCut needs Node 24+ (`.nvmrc` pins the CI version), the Rust
toolchain, and per-OS native build tools for the two napi addons
(`@weftcut/core`, `@weftcut/native-decode`). Electron bundles its own Chromium;
there is no webview runtime to install.

`rust-toolchain.toml` pins Rust 1.98.1 with the `wasm32-unknown-unknown`
target (`npm run build:wasm`); `rustup` installs both on the first build.

```sh
npm install         # JS dependencies only; does not build native code
npm run bootstrap   # Electron binary, both ffmpeg sets, both napi addons
npm run dev         # eval wasm, then electron-vite dev
```

`bootstrap` fetches the version-pinned GPL ffmpeg/ffprobe sidecar into
`resources/ffmpeg/<os>/` and the LGPL decode libraries into
`resources/ffmpeg-lgpl/<os>/` (built from source on macOS), then builds both
addons. A fresh clone does not start without it. Re-run it after changing
Rust under `native/`; cargo builds incrementally.

## Windows 11

1. Rust (MSVC): `winget install -e --id Rustlang.Rustup`, then
   `rustup default stable-x86_64-pc-windows-msvc` in a new shell.
2. Visual Studio 2022 Build Tools (MSVC linker + Windows SDK, ~6 GB):
   ```powershell
   winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
     --override "--passive --add Microsoft.VisualStudio.Workload.VCTools `
                 --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
   ```
3. LLVM for the decode addon's bindgen: `winget install -e --id LLVM.LLVM`
   (expected at `C:\Program Files\LLVM\bin` unless `LIBCLANG_PATH` is set).
4. Node: `winget install -e --id OpenJS.NodeJS.LTS`.

## macOS

macOS 13 or newer, Apple Silicon (the only shipped Mac build).

1. Xcode Command Line Tools: `xcode-select --install` (also provides libclang).
2. Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
3. Node: `brew install node`.

## Linux

1. Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
2. Build tools (Debian/Ubuntu):
   `sudo apt install build-essential curl file libclang-dev`.
3. Node 24+ via your distro or nvm.

On x64 both addons link against napi-rs's glibc 2.17 cross toolchain, so a
local build loads wherever a release does ([ADR 0143](adr/0143-linux-addons-link-against-an-old-glibc.md)).
The first build downloads it into `~/.napi-rs/cross-toolchain/`; each build
checks the addon with `objdump` against the glibc floor.

If the cross linker fails on a newer host (`unknown type [0x13] section
.relr.dyn`), build with the host toolchain for local use only:

```sh
WEFTCUT_NATIVE_BUILD=1 npm run bootstrap
```

Only the exact value `1` on Linux x64 enables it: no `--use-napi-cross`, no
injected cross compilers, no per-addon glibc check. The result needs the host's
glibc and is not a release artifact; packaging still enforces the floor.
Re-run `npm run bootstrap` without the variable to return to portable addons.

## ffmpeg at runtime

Main prepends the bundled sidecar directory to `PATH`; an `ffmpeg` sitting next
to the Electron executable is refused while another is reachable
(`native/src/ffmpeg/mod.rs`). With none reachable, Windows and macOS fall back
to `ffmpeg-sidecar`'s `auto_download`, which uses `ureq` and fails behind a
SOCKS proxy (`ALL_PROXY=socks5h://...`): install ffmpeg (`winget install -e --id
Gyan.FFmpeg`, `brew install ffmpeg`) or clear the proxy variables. Linux never
auto-downloads; run `npm run ffmpeg:fetch --workspace apps/desktop` or install
the distro package. Model downloads go through Electron's network stack and do
honor system proxies.

## Packaging and icons

```sh
npm run package     # both addons (release), electron-vite build, electron-builder
```

Output lands in `apps/desktop/release/`: NSIS on Windows, AppImage + deb on
Linux, dmg on macOS. Release flow: [releases.md](releases.md).

The brand icon is `apps/desktop/src/renderer/public/icons/icon.svg` (also the
favicon and start-screen mark). electron-builder needs a raster, so
`apps/desktop/build/icon.png` (1024x1024) is committed, generated with
`npm run gen:icons --workspace apps/desktop` (rasterized by Electron's own
canvas). Re-run and commit after changing the SVG.
