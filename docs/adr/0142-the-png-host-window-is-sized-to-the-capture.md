---
status: accepted
---

# The PNG host window is sized to the capture

Date: 2026-10-27

## Context

The PNG capture backend (`WEFTCUT_MOTIF_CAPTURE=png`, and every machine
without shared-texture OSR, which is every Mac) renders a Motif in one
offscreen bitmap host, navigates it between Motifs, emulates the capture
size with `Emulation.setDeviceMetricsOverride`, and reads a frame back with
`Page.captureScreenshot`. Unlike the shared-texture host, it never set its
window to the capture size: the window stayed at Electron's 800×600 default
while the page was emulated at 1920×1080. On the macOS CI runner a few of
the 48 captures of `motif-png-capture.spec.ts` came back fully transparent,
a different few on every attempt; Windows and Linux never missed. ADR 0138
left this open as "a separate question about that readback's timing".

Scoped macOS dispatches on 2026-10-26/27 (two workers, `--repeat-each=4`,
eight attempts per run) established, in order:

- Every miss is an empty frame, never a stale or partial one: the solid
  canvas encodes its frame index in a colour channel, and every missed
  frame was RGBA 0,0,0,0 everywhere, about 7% of captures (runs
  40326021777, 40326026044).
- `settleRafs` 1 and 2 behave the same; an ADR 0138-style discarded
  readback before the real one changes nothing (run 40327667154).
- With the host instrumented (run 40330373527): on a blank, the paint
  events after `__motifRender` were themselves blank, so were `capturePage`,
  a second readback, a 100 ms wait, `invalidate` and
  `stopPainting`/`startPainting`; only re-running `__motifRender` and
  reading back recovered it, 14 of 14 times. So the renderer's first commit
  for the new document carried no content, and nothing committed again
  until the page drew.
- Sizing the host window to the capture with `setContentSize`, exactly as
  the shared-texture host does, removed every blank: 4 of 4 attempts whole
  with the override still re-applied after each navigation (run
  40351227892), and again with it applied once (run 40348372590), 384
  captures in all. Whether the first commit is dropped for its size or
  never produced at that size is not established; the disagreement between
  the window and the emulation is the condition, and removing it is enough.

## Decision

- **Both capture hosts size their window to the capture.** The PNG host
  calls `setContentSize(width, height)` whenever the capture size changes,
  before the emulation override, which stays: it is what pins
  `deviceScaleFactor` to 1 for the screenshot.
- **The e2e runs on macOS again**, with the frame index encoded in the
  solid canvas, the sampled RGBA of any miss in the failure, and a
  no-navigation phase so a blank that is not tied to navigation would still
  be caught.

## Consequences

- No new work per frame; one window resize per capture-size change, which
  the shared-texture host already paid.
- The capture host fake reads back blank while its window and emulated
  size disagree, so a regression resolves `BLANK` in the unit tests.
- A verify-and-re-render alternative (decode the first readback of each
  surface, re-render once when transparent) also passed the same dispatch
  (run 40332631643) but treats the symptom and costs a decode per surface;
  it was replaced by this change before merge.
- Why a mismatched window loses the first commit on macOS only is not
  explained; it is observed on the three-core GitHub runner (GPU compositing
  on, no physical GPU) and has not been reproduced on a Mac outside CI. If
  it reaches production Macs, the symptom before this change was an empty
  sprite on the first capture after switching Motifs.

## Validation

Scoped macOS dispatch of `motif-png-capture.spec.ts` with `--repeat-each=4`
on the fix branch, after the same dispatch was red on eight of eight
attempts on every branch without the resize; unit tests pin the window
following the capture size across a new document and a new size, and the
blank readback of a window left behind.
