---
status: accepted
---

# A WebGPU device dies with its Application

## Context

Two places create a Pixi `Application` on WebGPU and later destroy it: the
Preview Panel host (`PixiPreview.tsx`, one Application per mount, destroyed by
`@pixi/react` when the panel closes) and the export worker (`exportWorker.ts`,
one Application per export, destroyed in `cleanup()` before the Worker is
terminated).

Pixi's WebGPU teardown does not destroy the device. `GpuDeviceSystem.destroy()`
drops its reference to `{ adapter, device }` and nothing more — unlike the WebGL
path, whose `GlContextSystem.destroy()` calls `WEBGL_lose_context.loseContext()`.
So every destroyed WebGPU Application leaves a live `GPUDevice` for the garbage
collector, and Dawn tears the device (and the GPU-process shared-image pools
behind it) down whenever V8 gets to it.

On Electron 44 (Chromium 152) that timing is fatal. The collector reaches the old
device while the next Application's first WebGPU work is in flight, and the
renderer main thread blocks for 30–45 s inside `gpu.mojom.CommandBufferClient`
handling, every process idle. Two user-visible faces: closing and reopening the
Preview Panel with a live d3d11va shared-texture session freezes the app; starting
an export while other exports and the preview are busy wedges the renderer.
Electron 42 (Chromium 148) tolerates the same lifecycle.

Varying the device's lifetime, and nothing else, on the reopen gate
(`preview-reopen-stress.spec.ts`, 8 close→reopen rounds, three runs each):

| device lifetime on Application destroy | result |
| --- | --- |
| left to the garbage collector (Pixi default) | renderer frozen in round 1–2, every run |
| held forever, never torn down | 8/8 clean, every run |
| `device.destroy()` right after Pixi's destroy | 8/8 clean, every run |
| `device.destroy()` before Pixi's destroy (in the host's own cleanup) | renderer frozen in round 1, every run |
| one device shared by every Application | 8/8 clean, every run |

Destroying the device explicitly, after Pixi's teardown, in both the preview host
and the export worker also takes the eight export-driving specs under four
concurrent app instances from six wedged tests per leg to zero; with the preview
destroying its device before Pixi's teardown the wedges come back (four to seven
per leg). What matters is an orderly death: Pixi releases the canvas swap chain
and its textures on a live device, then the device goes — deterministically,
before the next Application exists.

## Decision

1. **Whoever destroys a Pixi Application destroys its WebGPU device, right
   after Pixi's own teardown.** The export worker reads the device, destroys the
   Application, then destroys the device. The Preview host does not own the
   destroy call — `@pixi/react` runs `Application.destroy()` asynchronously
   after the component's cleanup — so it hooks the stage's `destroyed` event,
   which Pixi emits inside that synchronous call between destroying the stage
   and destroying the renderer, and destroys the device in a microtask, i.e.
   after the renderer half. `webgpuDeviceOf(renderer)` is the shared accessor;
   it answers null for a WebGL renderer and for a renderer that never
   initialized, so the rule costs nothing on the paths that have no device.

2. **After, never before.** Destroying the device in the host's cleanup, ahead of
   Pixi's teardown, is measured to freeze exactly like the leak. The
   specification makes operations on a destroyed device no-ops, but Chromium 152
   still stalls when the canvas swap chain and textures of a dead device are
   released later; the rule is therefore about order, not merely about calling
   `destroy()`.

3. **The device is not shared, pooled or kept alive.** A device per Application
   keeps the ownership the code already states ("the device goes with the
   Application"): the slot-fence backend is registered from the Application's
   init and cleared on its teardown, and GPU-process-crash recovery stays the
   user-level close-and-reopen, which gets a fresh device for free.

4. **The preview stays on WebGPU.** Switching the preview to WebGL would also
   avoid the stall (Pixi loses the GL context deterministically) but loses the
   WebGPU-only paths — the WebGPU slot fence and the float16 effects parity.

## Considered options

- **Wait for upstream.** Chromium should not be able to deadlock on a device's
  asynchronous destruction, and Pixi should destroy a device it created. Both
  are worth filing; neither is needed to ship, and the leak is ours to end in
  any case.
- **Hold every old device forever.** Proves the mechanism, leaks a device per
  Preview open.
- **One app-lifetime device passed to every Application** (Pixi's `gpu` init
  option). Clean on the probe, but it needs device-lost handling to re-create
  the device after a GPU-process crash, and it moves ownership out of the
  Application for no gain over destroying on time.
- **Reorder the shared-texture import release against Pixi's destroy.** The
  release order was never the variable; the device lifetime was.

## Consequences

- The preview's hook rides a public Pixi event (`Container` emits `destroyed`)
  and the documented order of `Application.destroy()`; if either changes,
  `preview-reopen-stress.spec.ts` is the gate that notices.
- Pending slot-fence probes hold the old device through `onSubmittedWorkDone`;
  a rejected or resolved promise both settle as signalled, so a destroyed device
  cannot strand a slot.
- A Preview closed before its Application finished initializing is destroyed by
  `@pixi/react`'s deferred unmount queue at the next mount's init; the hook is
  registered from `onInit`, which still fires for that Application, so its
  device follows the same rule — but at the next mount, not at close. Accepted:
  the window is the first few hundred milliseconds of a mount.
- Removing either `destroy()` call reintroduces the Electron 44 freeze. Two
  committed gates guard it, and BOTH need real hardware — neither runs on the
  hosted CI runners: `preview-reopen-stress.spec.ts` (this ADR's direct gate,
  the reopen + GPU-crash checks; d3d11va on Windows, videotoolbox on macOS,
  nvdec/vaapi on Linux) and the export-conformance specs. Both are
  `WEFTCUT_DECODE_E2E`-gated and self-skip where the lane is absent, so the
  hosted CI legs skip them; run them on a shared-texture-capable Windows box or a
  videotoolbox Mac. The export path's Face 2 freeze additionally needs the export
  specs run at multiple workers — CI runs them at one and never exercises it — so
  the four-worker local run on a real-GPU host is what catches that half.
