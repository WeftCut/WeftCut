# Electron 43 vs 44 upgrade assessment

> Status: implemented — the bump landed on branch `chore/electron-44`; see
> "Implementation record" at the end for what was verified where
>
> Last reviewed: 2026-09-03
>
> Baseline before the bump: Electron `42.11.1`
>
> Recommended release target: Electron `44.1.1`

## Decision

Upgrade WeftCut directly to **Electron `44.1.1`** as the intended release
target. Do not spend a full release-qualification cycle on 43 first. Keep
**Electron `43.5.1` as a diagnostic A/B build**, or use it as a short-lived
fallback only when an urgent release cannot wait for the Electron 44 gates
below.

This recommendation is conditional on all of the following:

1. the product drops macOS 12 and does not promise Windows `ia32` or Linux
   `armv7l` artifacts;
2. the locked native-module metadata is refreshed to recognize Electron 44 /
   module ABI 149, or the package gate proves that no ABI-based rebuild path is
   entered;
3. the three-platform package and runtime matrix passes, with special attention
   to WebGPU, WebCodecs, Windows D3D11 shared textures, and frameless windows.

If any condition is unacceptable, target `43.5.1` temporarily instead.

## Why 44 is the better release target

Before the bump the project pinned `42.11.1` in
[`apps/desktop/package.json`](../../apps/desktop/package.json). As of this
review, Electron identifies `44.1.1` as Latest Stable; its embedded versions are
Chromium 152.0.7977.65, Node 24.19.0, and V8 15.2.124.18. Electron `43.5.1`
contains Chromium 150.0.7871.250, Node 24.19.0, and V8 15.0.245.31.
([44.1.1 release](https://releases.electronjs.org/release/v44.1.1),
[43.5.1 release](https://releases.electronjs.org/release/v43.5.1))

Electron 43 reaches end of life on 2027-01-05; Electron 44 reaches end of life
on 2027-03-02. Electron supports only the latest three stable majors, gives the
latest stable all fixes from `main`, gives the preceding line the vast majority
as time permits, and gives the oldest supported line security fixes only.
([release schedule](https://releases.electronjs.org/schedule),
[support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy))

The full WeftCut qualification cost is driven by the browser/GPU/native surface,
not the one-line package change. Shipping 43 and then moving to 44 would require
repeating the engine-major probes that this repository explicitly says must be
reverified after an Electron/Chromium bump.
([lab-note policy](README.md))

Therefore 43's maturity advantage is useful for diagnosis, but its shorter
remaining support window does not justify making it the normal release target.

## Compatibility assessment

| Change or risk | WeftCut applicability | Required response |
| --- | --- | --- |
| Electron 44 no longer supports macOS 12; macOS 13 is the minimum. | The project produces a DMG, but does not currently state a minimum supported macOS version in [`electron-builder.yml`](../../apps/desktop/electron-builder.yml). | Make macOS 13+ an explicit product decision before merging the bump. ([Electron 44 release notes](https://www.electronjs.org/blog/electron-44-0#removed-macos-12-support)) |
| Electron 44 publishes only 64-bit binaries: Windows `ia32` and Linux `armv7l` were removed. | The checked-in builder configuration has NSIS, AppImage, DEB, and DMG targets but no explicit `ia32` or `armv7l` target. | Confirm the release promise is x64/arm64 only. Electron-builder also rejects these 32-bit targets on Electron 44+. ([Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#removed-32-bit-support), [electron-builder platform docs](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/multi-platform-build.md#build-32-bit-from-a-64-bit-machine)) |
| Electron 44 reworked clipboard APIs and removed Electron's renderer `clipboard` module. | WeftCut writes through `navigator.clipboard`, for example in [`LogConsole.tsx`](../../apps/desktop/src/renderer/logs/LogConsole.tsx) and [`AgentSection.tsx`](../../apps/desktop/src/renderer/settings/AgentSection.tsx), so the documented migration is already the implementation in use. | Clipboard smoke test only; no source migration is indicated. ([Electron clipboard migration](https://www.electronjs.org/docs/latest/breaking-changes#changed-clipboard-api)) |
| Electron 44 statically links ANGLE and no longer ships separate `libEGL`/`libGLESv2` libraries. Electron warns that loading ANGLE in every process can expose regressions in unusual configurations. | No replacement of those libraries was found, but preview and export depend heavily on WebGPU/WebCodecs, so renderer behavior is a high-risk empirical surface. | Run GPU preview/export and software-fallback coverage on all supported OS/GPU lanes. ([Electron 44 release notes](https://www.electronjs.org/blog/electron-44-0#changed-angle-is-now-statically-linked)) |
| Electron 43 enables rounded corners for frameless Linux windows by default. | WeftCut uses `frame: false` on non-macOS windows and custom hit regions in [`windowConfig.ts`](../../apps/desktop/src/main/windowConfig.ts) and [`index.ts`](../../apps/desktop/src/main/index.ts). Electron 44 inherits this behavior. | Recheck Linux window geometry, resize edges, title-bar drag regions, and screenshots; set `roundedCorners: false` only if the new default is undesirable. ([Electron 43 release notes](https://www.electronjs.org/blog/electron-43-0#changed-rounded-corners-for-frameless-windows-on-linux)) |
| Electron 43 defaults `dialog.showOpenDialog` / `showSaveDialog` to the Downloads folder when no `defaultPath` is given. | The two data-folder pickers in [`index.ts`](../../apps/desktop/src/main/index.ts) (`pickDirectory` and `dataRoot:pickAndMigrate`) pass no `defaultPath`; the media/export dialogs already forward one. | Accepted as-is: a data-folder picker opening in Downloads is a cosmetic change, and the previous starting directory was already platform-dependent. ([Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#behavior-changed-dialog-methods-default-to-downloads-directory)) |
| `sharedTexture` remains experimental and therefore can change or be removed more frequently than stable APIs. | WeftCut imports it in main and preload and uses persistent Windows D3D11 shared textures in [`previewGpu.ts`](../../apps/desktop/src/main/previewGpu.ts). | Treat the Windows texture handoff as a release blocker, including GPU-context-loss and close/reopen stress. ([sharedTexture API](https://www.electronjs.org/docs/latest/api/shared-texture), [experimental API policy](https://www.electronjs.org/docs/latest/experimental)) |
| Electron 44 tightened `net.request` frame-destination validation. | The project uses `net.fetch`, including its custom motif scheme and content download paths; no `net.request` use was found. | Exercise existing protocol/download tests, but no documented migration is indicated. ([Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#behavior-changed-netrequest-now-rejects-frame-destination-requests-without-navigate-mode)) |
| `ELECTRON_RUN_AS_NODE` is ignored only when the `runAsNode` fuse is disabled. | The MCP shim deliberately launches the Electron binary with `ELECTRON_RUN_AS_NODE=1` in [`paths.ts`](../../apps/desktop/src/cli/paths.ts) and [`shimInstall.ts`](../../apps/desktop/src/main/mcp/shimInstall.ts). | Keep the fuse enabled and smoke-test the installed shim from packaged artifacts. ([Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode), [environment variable reference](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)) |
| Node-API is ABI-stable across Node versions; Node-API version 6 is supported by later Node versions. | Both Rust addons build with napi-rs `napi6` and dynamic symbols in [`native/Cargo.toml`](../../apps/desktop/native/Cargo.toml) and [`native/decode/Cargo.toml`](../../apps/desktop/native/decode/Cargo.toml). This removes a source-level Node 24 blocker, but it does not validate linked FFmpeg/D3D libraries or packaging. | Rebuild and load both addons on each target OS; run decode/export and package-install tests. ([Node-API compatibility](https://nodejs.org/api/n-api.html#node-api-version-matrix), [napi-rs compatibility](https://napi.rs/docs/more/support-compatibility)) |

No project use was found for the other conspicuous 43/44 removals reviewed:
Electron's `nativeImage` color-profile behavior, Linux `showHiddenFiles`, old
login-item attributes, `select-client-certificate`, Unity integration, or
swappable ANGLE libraries. This is a repository search result, not a guarantee
that transitive dependencies do not use them.
([Electron 43 notes](https://www.electronjs.org/blog/electron-43-0),
[Electron 44 notes](https://www.electronjs.org/blog/electron-44-0),
[canonical breaking-change list](https://www.electronjs.org/docs/latest/breaking-changes))

## Build-tool preflight (verified)

Electron-builder's native-module rebuild is enabled by default and runs
`@electron/rebuild`, whose lazy ABI getter delegates to `node-abi` when it
actually rebuilds a `binding.gyp` module.
([electron-builder configuration source](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/configuration.ts#L801-L816),
[@electron/rebuild source](https://github.com/electron/rebuild/blob/main/src/rebuild.ts#L465-L469))

An earlier draft of this note found the lockfile on `node-abi@4.31.0`, whose
registry stopped at Electron 43 (`getAbi("44.1.1", "electron")` threw). That
is no longer the case: the lockfile now resolves `@electron/rebuild@4.2.0` and
`node-abi@4.35.0`, and the installed `abi_registry.json` maps Electron 44 to
module ABI 149 (Electron 43 to 148, Electron 42 to 146), matching the upstream
registry.
([Node ABI registry](https://github.com/nodejs/node/blob/main/doc/abi_version_registry.json),
[node-abi registry](https://github.com/electron/node-abi/blob/main/abi_registry.json))

The ABI path is also never entered for this project: neither checked-in
napi-rs addon nor any package in the installed dependency tree contains a
`binding.gyp`, and every prebuilt `.node` under `node_modules/` is a Node-API
build-tool binary (lightningcss, tailwind oxide, rolldown, napi-rs tar/lzma)
that runs under the toolchain Node, never inside Electron. Both project addons
are built separately by `napi:build` / `napi:build:decode` (Node-API 6 with
dynamic symbols) and copied explicitly by the builder.

Two toolchain facts to keep in mind when touching these pins again:

- `electron-builder`'s `latest` dist-tag lags the pinned `26.16.0` (it points
  at `26.15.3`); install by exact version, never `@latest`.
- `electron-vite@6.0.0-beta.1` maps Electron majors to esbuild targets only up
  to 41 and falls back to `node24.14` / `chrome146` for anything newer. Both
  are below Electron 44's Node 24.19 / Chromium 152, so the fallback is safe,
  and the renderer sets its own `target: 'chrome120'` regardless.

## Qualification gates

1. **Product gate:** record macOS 13+ and 64-bit-only support.
2. **Toolchain gate:** confirm the Electron 44 ABI metadata is present (it is:
   `node-abi@4.35.0`) and that no ABI lookup is entered (no `binding.gyp`),
   then ensure both N-API addons load.
3. **Static gate:** typecheck, unit/script tests, Electron build, and packaged
   artifacts succeed on Windows, Linux, and macOS.
4. **GPU/media gate:** verify WebGPU preview and export, WebCodecs encode/decode,
   software fallback, ten-bit/NV12 paths, Windows persistent D3D11 shared
   textures, context loss, and representative real media.
5. **Desktop integration gate:** verify frameless window drag/resize/caption
   controls, offscreen motif capture, `net.fetch` custom protocol/downloads,
   `navigator.clipboard`, MCP `ELECTRON_RUN_AS_NODE`, launch, install, and
   uninstall from real artifacts.
6. **Engine-note gate:** rerun the probes referenced by
   [`docs/notes/README.md`](README.md), because their measured conclusions are
   explicitly invalidated by an Electron/Chromium major bump.

## Use 43 as an A/B diagnostic, not a second destination

If `44.1.1` fails a browser/GPU/runtime test, build `43.5.1` with the same app
revision and test fixture:

- if 42 passes and both 43 and 44 fail, investigate the 42-to-43 / Chromium
  148-to-150 transition or an assumption exposed by both newer engines;
- if 42 and 43 pass but 44 fails, concentrate on Electron 44, Chromium 152,
  the ANGLE linkage change, and the 44 breaking-change list;
- if only packaged 44 fails before startup, inspect the ABI/build-tool path
  before attributing the failure to application code.

This isolates the regression boundary without making 43 a separately
qualified release. If 44 qualification cannot finish before an urgent release,
`43.5.1` is the safer temporary target because it avoids 44's new platform
floors and ANGLE transition, but it still requires the full 43 compatibility
matrix and must be replaced before its 2027-01-05 end of life.
([43 release](https://releases.electronjs.org/release/v43.5.1),
[release schedule](https://releases.electronjs.org/schedule))

## Implementation record

The bump is one line in `apps/desktop/package.json` plus the lockfile. Nothing
else in the source needed a migration; the accompanying changes are:

- `scripts/install-electron.mjs` now compares `dist/version` with the pinned
  version and replaces `dist/` on mismatch. It used to skip on mere existence,
  which would have run every local e2e against the previous binary after an
  incremental `npm install`.
- `base.css` gives the self-drawn 1px window edge an 8px radius, matching the
  frameless-window mask Chromium applies on Linux (Electron 43+) and Windows 11.
  The Electron default (`roundedCorners: true`) is kept.
- `electron-builder.yml` declares `mac.minimumSystemVersion: "13.0"`;
  `docs/setup.md` records the macOS 13+ / 64-bit-only floor.
- Two new e2e gates: `window-chrome-frameless.spec.ts` (drag region, no-drag
  buttons, edge radius, maximize/restore round trip) and `clipboard.spec.ts`
  (`navigator.clipboard` write → OS clipboard → read-back).
- CI caches the Electron release zip through `electron_config_cache`, keyed on
  the pinned version.

### Verified on Linux (this machine: NVIDIA + Intel iHD VAAPI, X11), 2026-09-03

| Layer | Result |
| --- | --- |
| `npm run typecheck` | green; the experimental `sharedTexture` types (`SharedTextureImported`, `importSharedTexture`, `setSharedTextureReceiver`) are unchanged in 44's `electron.d.ts` |
| `npm test` (Vitest) | 6673 passed, 2 skipped |
| `npm run test:scripts` | 58 passed, 1 skipped |
| new e2e specs | 4 passed (frameless chrome ×3, clipboard ×1) |
| `npm run e2e` (default tier) | 208 passed, 0 failed, 22 skipped — every skip is a platform lane this machine cannot run (d3d11va, videotoolbox, macOS chrome/menu), the off-CI `preview-gpu-order` set, the 4K ProRes ratchet fixture, or the keyring-dependent `safeStorage` specs |
| hardware lanes | nvdec + vaapi: 8/8 saturated-chart colour gates (worst patch error 1–2, tolerance 8), 2/2 H.264 conformance |
| `effects-f16-parity` (WebGPU via Vulkan) | GATE PASSED on the real adapter (nvidia / ampere) |
| `import-probe` | hardware `VideoDecoder` config now rejected (`Unsupported configuration`) in main and worker; software I420 lit through all four import paths. On 42 the hardware config was accepted and read black. `preferSoftware` stays; see `electron-chromium-behavior.md` |
| `electron-builder --publish never` | AppImage + deb built; all three `afterPack` licensing gates held |
| packaged AppImage | launches, initializes the data root and copies the MCP shim to `<userData>/cli/`; `ELECTRON_RUN_AS_NODE=1 <AppImage binary> resources/cli/weftcut-mcp.cjs info` works, so the `runAsNode` fuse is still on |

The 44 AppImage no longer carries `libEGL.so` / `libGLESv2.so` (ANGLE is
statically linked); `libvk_swiftshader.so` and `libvulkan.so.1` still ship.

### Verified on Windows (RTX 3050 + Intel UHD 730, display on the RTX 3050)

| Layer | Result |
| --- | --- |
| `npm run typecheck` / Vitest / `test:scripts` | green; 6677 passed; 59 passed |
| `npm run e2e` (decode gates on, `--workers=4 --retries=1`) | 216 passed, 0 failed, 0 flaky, 10 skipped — every skip a macOS chrome/menu spec or a videotoolbox/vaapi/nvdec lane |
| Windows persistent D3D11 shared textures | `preview-gpu-order` 8/8, `preview-hw-color` d3d11va 4/4, `preview-hw-conformance` d3d11va, `poc/shared-texture` full matrix including the RGBA byte-exact probe |
| context loss / reopen stress | GPU-process crash under a live d3d11va session → close + reopen recovers the hardware lane; 8-round Preview close→reopen with a live session clean ×3 — after the device-teardown fix below |
| `effects-f16-parity` (WebGPU on D3D12) | GATE PASSED on the real device |
| `playback-perf` / `decode-bench`, 44 vs 42 in one sitting | no regression: h264-1080 hardware route at 1/3/5 tracks all SMOOTH, tick p99 ≤ 0.9 ms on both; WebCodecs decode hevc 871 vs 886 fps, h264 538 vs 551 |
| 4K ProRes memory ratchet | passes |
| `electron-builder --publish never` | NSIS built; both `afterPack` licensing gates held; both `.node` addons in `app.asar.unpacked`; the packaged app launches, copies the MCP shim to `<userData>/cli/`, and the shim's `info` runs under `ELECTRON_RUN_AS_NODE=1` |
| Windows 11 corner mask | matches the 8px inset edge on a real-screen capture |

**Found and fixed on Windows: Chromium 152 stalls the renderer when a WebGPU
device dies out of order.** Pixi never destroys the device it created, so every
closed Preview and every finished export left a live `GPUDevice` to the garbage
collector. On Chromium 148 that is harmless; on 152 the renderer main thread blocks
for 30–45 s when such a device dies while the next Application's first WebGPU work
is in flight — Preview close→reopen with a live d3d11va session froze
deterministically, and export start under four concurrent app instances wedged six
to seven of 39 export tests per leg. ADR 0059 destroys the device right after
Pixi's own teardown, in the Preview host and the export worker; the reopen probe
then runs 8/8 ×3, the export set 39/39 ×2, and the full suite needs no retry. The
engine fact is recorded in `electron-chromium-behavior.md`.

### Still verified only on Electron 42

- macOS: the manual menu-accelerator check in `electron-chromium-behavior.md`,
  and every gate the hosted macOS runner skips — the videotoolbox lanes, the
  traffic-light chrome and the application-menu specs — plus installing and
  launching the dmg. They need a real Mac.
- Lab-note entries without a gate: Pointer Lock, inline foreignObject taint, the
  EyeDropper widget (Windows).
