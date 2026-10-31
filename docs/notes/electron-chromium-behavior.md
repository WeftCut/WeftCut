# Electron/Chromium engine behavior — verified verdicts

First measured on Electron 42.4.1 / Chromium 148 (Windows 11, RTX 3050) with a
bare probe harness. Re-verified on Electron 44.1.1 / Chromium 152 (2026-09,
Linux x64 NVIDIA + Intel VAAPI, and Windows 11 RTX 3050) through the app's own
gates, except where an entry says otherwise. Windows D3D11 shared textures
(`importSharedTexture` with keyed-mutex slots) and recovery after
`chrome://gpucrash` passed on 44. Re-verify on each Chromium major bump.

## A canceled `pointerdown` cancels the focus move

Focus moves in `mousedown`'s default action, and `preventDefault()` on
`pointerdown` suppresses the compatibility `mousedown`. A gesture handler that
cancels `pointerdown` (to stop native drag/selection) therefore leaves focus
where it was. Focus release cannot be left to the browser; the only phase ahead
of every gesture handler is capture at `window` (React attaches lower). Premise
of ADR 0041; gated by `e2e/electron/focus-regions.spec.ts`.

## Pointer Lock works

`requestPointerLock()` engages on a visible, focused window (a hidden window
always errors). Drag-to-scrub on numeric fields is possible; typing + steppers
remain the fallback. Not re-probed on 44.

## Inline foreignObject raster does not taint the canvas

An inline `<foreignObject>` SVG drawn via `<img>` to a canvas reads back
(`getImageData`, `toDataURL`). Only the inline case was probed: an embedded
external resource or web font is the classic taint trigger and is unverified.
Not re-probed on 44.

## WebCodecs hardware hints are requirements, not preferences

- `VideoEncoder` `prefer-hardware` rejects a codec with no hardware encoder
  instead of falling back (AV1 on RTX 3050: `isConfigSupported` false, encode
  "Encoder creation error"; hint omitted → software libaom, 71 ms/frame at
  720p). Omit the hint except for H.264. Chromium has no software HEVC
  encoder; HEVC needs ffmpeg.
- On Linux/NVIDIA (Chromium 152) `VideoDecoder.configure` with
  `prefer-hardware` throws `OperationError: Unsupported configuration` (on 148
  it produced black BGRA frames). `prefer-software` works; Linux has no
  WebCodecs hardware decode (`preferSoftware`, `hwExportDecodeAllowed`).
- `isConfigSupported` is wrong in both directions (negative under
  `prefer-hardware`, positive for some decodes such as Hi10P). Confirm with a
  real `encode()`/`decode()` plus `flush()`.

## Buffer-defined `VideoFrame` conversion ignores `colorSpace` (always BT.601)

A `VideoFrame` built from an ArrayBuffer (`new VideoFrame(data, { format:
"NV12", colorSpace })`) converts with BT.601 in `drawImage` /
`createImageBitmap` whatever the stamped space; decoder-produced frames honor
their tags. Found by the saturated-chart gate (chart SSIM 0.616 vs 0.892;
natural content barely moved, so natural-clip gates are blind to it). Never
hand a buffer-defined YUV frame to the browser for conversion: native-decode
planes convert in owned shaders (`Nv12Ingest`, `TenBitIngest`,
`coefForMatrix`), ADR 0032. Same family: `VideoEncoder` ignores
`VideoFrame.colorSpace`; `copyExternalImageToTexture` converts as
BT.709/limited regardless of tags (ADR 0014).

## EyeDropper samples screen-wide but its widget is window-hosted

`new EyeDropper().open()` returns correct colors from any window, but the
magnifier clips at the app window edge and the pick click activates the
foreign window (electron#27980, #44916, #44917). WeftCut uses
`main/screenPick.ts` instead: freeze each display with desktopCapturer, then
show overlay windows that own magnifier and input. Fractional DPI: use actual
capture dimensions, request each display separately (a larger thumbnail can
upscale), and commit from the `PointerEvent` position (the compatibility click
truncated coordinates by a pixel). Probe: `poc/colorpick/FINDINGS.md`.

## Hidden windows can withhold animation frames before their first show

Windows / Electron 44.1.1: an overlay reporting `visibilityState: visible`,
with `backgroundThrottling: false`, ran no `requestAnimationFrame` callbacks
before its first show. Main waited for renderer `ready` before
`showInactive()` while the renderer awaited a frame before sending `ready`.
Rule: a hidden window's init handshake must not depend on frames or
visibility; `ready` follows decode + handler install
(`renderer/colorpick/desktopOverlay.test.ts`).

## Pixi WebGPU `extract.pixels` cannot read an in-flight filter input

It copies through a WebGPU canvas and a 2D canvas on a separate command
encoder. Effect-input picking (`EffectInputCapture`) queues
`copyTextureToBuffer` on the render encoder while the pooled input is still
owned and maps the staging buffer after rendering; WebGL reads back and
restores the framebuffer.

## A WebGPU device that dies out of order stalls the renderer (Chromium 152)

Pixi's `GpuDeviceSystem.destroy()` drops the `GPUDevice` without destroying it
(its WebGL twin calls `loseContext()`). On 152, when such a device is garbage
collected while the next Application's first WebGPU work is in flight, the
renderer main thread blocks 30–45 s in `gpu.mojom.CommandBufferClient`, all
processes idle. Windows, d3d11va lane live, 8 Preview close/reopen rounds x 3
runs:

| device lifetime on Application destroy | result |
| --- | --- |
| left to GC (Pixi default) | frozen in round 1–2, every run |
| `device.destroy()` before Pixi's teardown | frozen in round 1, every run |
| `device.destroy()` right after Pixi's teardown | clean |
| held forever, or one device shared | clean |

Order matters: release swap chain and textures on a live device, then destroy
it, before the next Application exists (`render/webgpuDevice.ts`, used by the
Preview host and the export worker). Clean on Electron 42 and 43.

## macOS menu accelerators do not preempt the renderer

Electron 42.4.1, macOS (Apple silicon), 2026-07-30; a real `Cmd+C` through
AppKit (`osascript ... keystroke`). `webContents.sendInputEvent` injects past
AppKit and cannot probe this.

| application menu | native copy | renderer saw keydown |
| --- | --- | --- |
| `[appMenu, editMenu]` roles, default accelerators | yes | yes |
| same, renderer calls `preventDefault()` | **no** | yes |
| Edit roles with `accelerator: ''` | no | yes |
| Edit roles with `registerAccelerator: false` | yes | yes |
| `[appMenu]` only | no | yes |
| `setApplicationMenu(null)` | yes | yes |

Custom items behave like roles, and `preventDefault()` also stops a destructive
role (`close`, Cmd+W). Rules:

- The renderer is upstream of the menu: `useShortcuts` owns a chord by calling
  `preventDefault()`; a full menu with real accelerators can coexist, and a
  focused text input simply is not prevented.
- Never strip an accelerator off a role: `accelerator: ''` kills the role,
  `registerAccelerator: false` is ignored on macOS.
- Electron's default menu ships reload, DevTools, Close Window and DOM undo in
  production; `role: 'viewMenu'` re-adds reload + DevTools. `role: 'appMenu'`
  has no Settings slot (`Cmd+,` is a custom item).
- No menu gives native Cmd+C but a menu without a copy role does not; treat
  that as an implementation detail and ship the standard Edit menu.

### Manual check: the renderer still owns the shared chords

Not a CI gate (injected keys bypass AppKit; `osascript` needs Accessibility).
Run on macOS after touching the menu template, `useShortcuts` or the Electron
major; `e2e/electron/menu.spec.ts` covers the rest.

1. `Cmd+Z` in the timeline reverts an edit; in a text field it undoes typing
   and leaves project history alone.
2. `Cmd+W` saves and closes to the start screen; the window stays open.
3. `Cmd+C` / `Cmd+V`: native clipboard in a text field, app copy/paste in the
   timeline.
4. `Cmd+,` opens Settings on the start screen and in the editor.

## An offscreen window is a full citizen of the window list

`webPreferences: { offscreen: true }` selects a paint target, not a lifecycle
class: `getAllWindows()` includes it and closing the visible window does not
emit `window-all-closed`. With quit driven by `window-all-closed`, the Motif
capture host kept the process alive with no window. Quit follows the
user-facing window count (`main/windows.ts`), gated by
`e2e/electron/app-quit.spec.ts`. Declare an internal window in the same tick as
its constructor, before the first `await`.

## Closing the last window quits, macOS included

WeftCut is a single-window app (no File > New Window), and a windowless process
would hold decode sessions, GPU textures and ffmpeg children with nothing to
close; the MCP stdio shim already serves agents with the app closed. So
`quitIfLastUserWindowClosed` has no platform branch. Restoring the quick-start
`process.platform !== 'darwin'` guard fails `app-quit.spec.ts` on macOS and
would bring back an `activate` handler that can resurrect the window during the
`before-quit` flush.

## macOS offscreen bitmap host drops the first commit when window and emulation sizes differ

GitHub macOS runner (3 cores, GPU compositing, no physical GPU), 2026-10-26/27.
The PNG capture host (every Mac) left its window at 800x600 while emulating
1920x1080 with `Emulation.setDeviceMetricsOverride`. About 7% of
first-after-navigation captures were fully transparent (never stale or
partial); Windows and Linux never missed. On a blank, paint events after
`__motifRender`, `capturePage`, a second readback, a 100 ms wait,
`invalidate` and `stopPainting`/`startPainting` were all blank too;
`settleRafs` 1 vs 2 and a discarded first readback changed nothing. Only
re-rendering recovered (14/14). Sizing the window to the capture with
`setContentSize` removed every blank (384/384 captures). A verify-and-re-render
fallback also passed but costs a decode per surface and was rejected. The
emulation override stays: it pins `deviceScaleFactor` to 1. Not reproduced on a
Mac outside CI. Gated by `e2e/electron/motif-png-capture.spec.ts` and the
capture-host fake in `main/motif/capture.test.ts`.

## Platform facts from the 2026-10 full verification runs

- Playwright's Electron launcher forces `--password-store=basic`, so
  `safeStorage` reports no keyring on Linux even with Secret Service running;
  keyring specs skip there.
- `overflow: hidden` still permits programmatic scrolling (`scrollIntoView`,
  focus): revealing content panned the whole dock workspace. Non-scrolling
  shells use `overflow: clip`.
- macOS screenshots carry display-profile (Display P3) bytes: a fixed sRGB
  oracle color misses (outline painted 78,129,238 vs expected 59,130,246).
  Calibrate screenshot oracles from painted swatches of the same surface.
- macOS `/var` is a symlink to `/private/var`: compare `realpath`ed roots
  against paths resolved through their nearest existing ancestor, not
  lexically.

## Not re-probed (known Blink behavior)

Hi10P software-decodes but needs `flush()`; a lone IDR frame parks in the
reorder buffer until `flush()`; held `VideoFrame`s pin the ~13-slot hardware
decoder pool (ADR 0004).
