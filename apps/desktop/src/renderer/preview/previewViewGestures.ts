// The preview's view gestures, bound to the surface that holds the canvas AND
// its overlays: wheel or trackpad pinch to zoom about the pointer,
// middle-button drag to pan.
// Both are tool-independent on purpose — Resolve and Premiere zoom and pan
// their viewer without arming anything, and the Hand tool exists there (and
// here) as the path for a pointer with no middle button, not as the way in.
// ADR 0072.
//
// Listeners go on the SURFACE (`.preview-video`), never on the Pixi host: the
// gizmo, Text and Hand overlays are SIBLINGS of that host, so a wheel over a
// gizmo handle would never reach a listener attached to the host. The two
// share a box, so either is the same centre to measure against.
//
// Geometry is measured, never read back from the store: the canvas's own box
// is the clamped truth (`fittedCanvasBox` bounds the pan at paint), so a
// gesture that starts from that rect cannot fight a stored overshoot.
import { useEffect } from "react";

import {
  clampPreviewPan,
  panAfterZoom,
  previewScale,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  PREVIEW_ZOOM_STEPS,
  setPreviewView,
  usePreviewViewStore,
  type Pan,
} from "../state/previewViewStore";

/// Scale factor per pixel of wheel travel, exponential so one notch is the
/// same RATIO at every magnification. Chromium reports ~100 px per mouse
/// notch, making that ~16 %; a trackpad's two-finger scroll reports smaller
/// deltas and moves proportionally less, which is what lets one constant serve
/// the wheel and scrolling both. A pinch is not one of them — see below.
const WHEEL_ZOOM_PER_PIXEL = 0.0015;
/// `deltaMode` 1 is lines, not pixels. Chromium reports it for only a few
/// device/driver combinations — but a 3-line notch read as 3 px would make the
/// wheel look broken on exactly those.
const WHEEL_LINE_PX = 16;
/// A trackpad PINCH arrives as a wheel event with `ctrlKey` set: outside Safari
/// there is no separate gesture event, and the pinch is synthesized onto the
/// wheel. Its deltas are an order of magnitude smaller than a notch's, so it
/// needs its own constant or a spread would barely move the picture. Holding
/// Ctrl on a real wheel lands here too — the conventional zoom chord anyway,
/// and the per-event ceiling below keeps its 100 px notch in proportion.
const PINCH_ZOOM_PER_PIXEL = 0.01;
/// The most ONE event may scale by, either way. A pinch frame never approaches
/// it; a mouse notch read under the pinch constant, or a driver that batches a
/// whole sweep into one delta, would cross half the range without it.
const MAX_STEP_RATIO = 1.5;

/// A pan in flight. Holds the extents measured at pointer-down: the picture
/// cannot resize mid-drag without the scale changing, and a scale change voids
/// the drag outright.
export interface PreviewPanDrag {
  pointerId: number;
  originX: number;
  originY: number;
  panX: number;
  panY: number;
  canvasWidth: number;
  canvasHeight: number;
  hostWidth: number;
  hostHeight: number;
  scale: number;
}

/// Where the picture's centre sits relative to the surface's, in CSS pixels —
/// the quantity the store calls `pan`, but AS PAINTED.
function paintedPan(surface: DOMRect, canvas: DOMRect): Pan {
  return {
    x: canvas.left + canvas.width / 2 - surface.left - surface.width / 2,
    y: canvas.top + canvas.height / 2 - surface.top - surface.height / 2,
  };
}

export function beginPreviewPan(
  surface: HTMLElement,
  canvas: Element | null | undefined,
  event: { clientX: number; clientY: number; pointerId: number },
): PreviewPanDrag | null {
  if (!canvas) return null;
  const host = surface.getBoundingClientRect();
  const frame = canvas.getBoundingClientRect();
  if (!(host.width > 0 && host.height > 0 && frame.width > 0 && frame.height > 0)) return null;
  const pan = paintedPan(host, frame);
  return {
    pointerId: event.pointerId,
    originX: event.clientX,
    originY: event.clientY,
    panX: pan.x,
    panY: pan.y,
    canvasWidth: frame.width,
    canvasHeight: frame.height,
    hostWidth: host.width,
    hostHeight: host.height,
    scale: previewScale(),
  };
}

/// Feeds one pointer position into a live drag. False once the drag is void —
/// the scale moved under it — so the caller releases capture instead of
/// panning against extents that no longer describe the picture.
export function movePreviewPan(
  drag: PreviewPanDrag,
  clientX: number,
  clientY: number,
): boolean {
  if (previewScale() !== drag.scale) return false;
  setPreviewView(usePreviewViewStore.getState().zoom, {
    x: clampPreviewPan(drag.panX + clientX - drag.originX, drag.canvasWidth, drag.hostWidth),
    y: clampPreviewPan(drag.panY + clientY - drag.originY, drag.canvasHeight, drag.hostHeight),
  });
  return true;
}

/// Wheel + middle-button for as long as the surface is mounted. Takes the
/// ELEMENT rather than a ref: the surface mounts after the empty-state and
/// loading paths, and a ref object's stable identity would never re-run this.
export function usePreviewViewGestures(surface: HTMLElement | null): void {
  useEffect(() => {
    if (!surface) return;
    const canvasOf = (): Element | null => surface.querySelector("canvas");

    const onWheel = (event: WheelEvent) => {
      const canvas = canvasOf();
      if (!canvas) return;
      // Unconditional: this also takes Chromium's own Ctrl+wheel page zoom out
      // of play, which would otherwise scale the whole application.
      event.preventDefault();
      const host = surface.getBoundingClientRect();
      const frame = canvas.getBoundingClientRect();
      if (!(host.width > 0 && host.height > 0 && frame.width > 0 && frame.height > 0)) return;
      const from = previewScale();
      // A pinch is always reported in pixels, so the `deltaMode` conversion is
      // the scrolling path's alone.
      const pinch = event.ctrlKey;
      const travel = pinch
        ? event.deltaY
        : event.deltaY *
          (event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? host.height : 1);
      const step = Math.exp(-travel * (pinch ? PINCH_ZOOM_PER_PIXEL : WHEEL_ZOOM_PER_PIXEL));
      const rolled = Math.min(
        PREVIEW_ZOOM_MAX,
        Math.max(
          PREVIEW_ZOOM_MIN,
          from * Math.min(MAX_STEP_RATIO, Math.max(1 / MAX_STEP_RATIO, step)),
        ),
      );
      // Land ON a labelled rung when the roll passes within a percent of one:
      // the readout is a menu of those rungs, and "100 %" reading 99 % would be
      // both an odd number to look at and a second entry in the list.
      const to = PREVIEW_ZOOM_STEPS.find((rung) => Math.abs(rolled - rung) < rung / 100) ?? rolled;
      if (to === from) return;
      const anchor = {
        x: event.clientX - (host.left + host.width / 2),
        y: event.clientY - (host.top + host.height / 2),
      };
      const next = panAfterZoom(paintedPan(host, frame), from, to, anchor);
      const ratio = to / from;
      setPreviewView(to, {
        x: clampPreviewPan(next.x, frame.width * ratio, host.width),
        y: clampPreviewPan(next.y, frame.height * ratio, host.height),
      });
    };

    let drag: PreviewPanDrag | null = null;
    const end = () => {
      if (!drag) return;
      if (surface.hasPointerCapture(drag.pointerId)) {
        surface.releasePointerCapture(drag.pointerId);
      }
      drag = null;
      delete surface.dataset.panning;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 1 || drag) return;
      const started = beginPreviewPan(surface, canvasOf(), event);
      if (!started) return;
      event.preventDefault();
      drag = started;
      surface.setPointerCapture(event.pointerId);
      surface.dataset.panning = "true";
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!movePreviewPan(drag, event.clientX, event.clientY)) end();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) end();
    };
    // Windows Chromium opens its autoscroll anchor on the MOUSE event, which
    // `pointerdown.preventDefault()` does not suppress; the page would then
    // drift under a compass cursor for the rest of the gesture.
    const onMiddleMouse = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };

    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("mousedown", onMiddleMouse);
    surface.addEventListener("auxclick", onMiddleMouse);
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerUp);
    surface.addEventListener("lostpointercapture", onPointerUp);
    return () => {
      end();
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("mousedown", onMiddleMouse);
      surface.removeEventListener("auxclick", onMiddleMouse);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
      surface.removeEventListener("lostpointercapture", onPointerUp);
    };
  }, [surface]);
}
