---
status: accepted
---

# The preview viewport is a gesture, not a mode, and its zoom is a percentage of the source

The preview zooms on the wheel, anchored under the pointer, and pans on the
middle mouse button — both under whatever tool is armed, with nothing to enter
and nothing to leave. The zoom is device pixels per composition pixel, shown as
a percentage in a menu whose other entry is `Fit`; `Fit` is a mode that
re-fits, not a captured number. The Hand tool stays, as the path for a pointer
with no middle button.

## Context

The first cut of preview zoom made the multiplier relative to Fit (`1× = Fit`,
stepped 0.25× … 4×), put Zoom in / Fit / Zoom out in the Quick Actions strip,
and made the Hand tool (`H`) the only way to pan. Using it read as an
errand: arm a tool, drag, remember to leave it — and the readout could not
answer the one question a zoom readout exists to answer, because `1×` meant
"whatever this panel happens to show" rather than "the frame's own pixels".

The reference applications agree, and none of them has a zoom mode:

- **Premiere Pro** — a percentage menu (Fit, 25 %, 50 %, 100 %, 200 %, 400 %);
  the wheel zooms continuously, anchored on the cursor since Build 44, with
  `Alt` re-anchoring to the monitor centre; panning is the middle button, the
  Hand tool (`H`), or optional scroll bars.
- **DaVinci Resolve** — the wheel zooms the viewer, the middle button pans it
  ("like the hand tool in Photoshop"), `Z` returns to a normal view. The one
  place a modifier appears is the scopes, where the wheel already means
  something else.
- **Final Cut Pro** — a Zoom pop-up with `Fit` and percentages, `Cmd +/−`,
  `Shift+Z` to fit; past Fit a navigation box appears to drag, with the Hand
  tool (`H`) as the alternative.

The pattern behind the exception is the rule we adopted: a modifier is spent
only where the wheel already carries another meaning. Over the preview surface
it carries none.

`Space`-to-pan, the Photoshop/After Effects reflex, is not available in an NLE
and does not appear in any of the three: `Space` is play.

## Decision

1. **Zoom is a scale in device pixels per composition pixel.** 100 % is one
   composition pixel per device pixel — the "am I looking at real detail?"
   reading — and is independent of the panel's size. The labelled stops are
   25 %, 50 %, 75 %, 100 %, 150 %, 200 %, 300 %, 400 %.
2. **`Fit` is a mode.** `previewViewStore` holds `zoom: number | "fit"`, and
   the renderer publishes the resolved fit back into that store, since it alone
   knows the host's device-pixel box (ADR 0071). A resized panel therefore
   re-fits, where a number captured at fit time would have frozen.
3. **The wheel zooms, anchored on the pointer**, continuously, clamped to
   5 %–800 %, and snapping onto a labelled stop when it rolls within a percent
   of one. The listener sits on the preview SURFACE, not on the Pixi host: the
   gizmo, Text and Hand overlays are siblings of that host.
4. **A trackpad pinch zooms too**, on the same anchor. Chromium synthesizes a
   pinch onto the wheel with `ctrlKey` set rather than emitting a gesture
   event, so it is the same handler with its own constant — pinch deltas are
   an order of magnitude smaller than a notch's — and a per-event ceiling that
   keeps a real Ctrl+wheel in proportion. Two-finger scrolling keeps zooming as
   the wheel does, which leaves a trackpad without a pan GESTURE; the Hand tool
   is that pointer's pan, exactly as it is in Premiere.
5. **The middle button pans**, under every tool. Chromium's autoscroll is
   suppressed on the mouse event, not the pointer event, which is the only
   place that suppression works.
6. **The Hand tool stays** and shares one pan implementation with the middle
   button — same clamp, same abort when the scale moves under a live drag.
   It covers the pointer that has no middle button.
7. **The readout is the control.** The preview toolbar shows `Fit` or the
   percentage, and clicking it offers the stops. It is a radio MENU, not a
   select: the wheel lands between stops, and a select renders its trigger from
   its own items — carrying the live value as an extra item made that item
   vanish the moment a notch snapped back onto a stop, at which point Base UI
   fell back to the first entry and threw the view to Fit mid-gesture.
8. **One key, `Z`**, returns to Fit and recentres. It is also View › Fit
   preview to window; the two stepping commands stay out of that menu, where
   walking a scale one row at a time reads as an errand. Zoom in / out stay keyless
   commands for the search palette and for agents. `Mod +/−` is unavailable
   (`hardenWindow` consumes it to kill Chromium's page zoom), and `=` / `−`
   keep meaning the timeline everywhere rather than following panel focus.

The Quick Actions strip loses its three zoom buttons: the gesture is the wheel
and the readout is the menu, so the strip slots were spending three buttons on
a value that now names itself.

## Consequences

- `previewRenderResolution` collapses to `min(1, scale, knob)` — the fit no
  longer has to be multiplied in, because the zoom IS the scale it used to
  produce. The Fit view resolves to `fit` on its way through.
- A zoom above 100 % raises the canvas box past the host and past the
  composition; the raster behind it stays capped at the composition, so the
  browser upscales exactly as a monitor does past 100 %.
- Pan is clamped per axis at the picture's edges, by the gesture layer while
  dragging and by `fittedCanvasBox` at paint. A stored overshoot can survive a
  panel shrink and is re-clamped for display rather than discarded.
- Zoom and pan remain session view state: no clip, history entry, export
  geometry or decode divisor reads them.
- A trackpad has no pan gesture: two-finger scroll is spent on zoom. Should
  that prove wrong, the fix is a device heuristic in one handler — plain
  scroll pans, pinch zooms, as Final Cut does — and not a mode.
