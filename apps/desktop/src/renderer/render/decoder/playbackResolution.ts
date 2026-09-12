// The one place the user-facing Playback Resolution preference becomes a
// number, and the one place the preview's on-screen box joins it. The settings
// file, the UI and the i18n keys speak in fractions (`full` | `half` |
// `quarter`); the two halves of the setting each want a different shape of the
// same number — the native ship stage takes a divisor
// (`FfmpegSourceInit.playbackScaleDiv` → `SwTransport` → `preview_sw_open`'s
// `scale_div` → Rust `OutScale`), Pixi's renderer takes the smaller of its
// reciprocal and how much of the composition the preview panel can show at
// all (`fitScale`). See docs/render.md §Preview canvas, ADR 0071.
import type { PlaybackResolution } from "../../../shared/app-settings";
import {
  clampPreviewPan,
  resolvePreviewZoom,
  type Pan,
  type PreviewZoom,
} from "../../state/previewViewStore";

/// Divisor applied to BOTH axes of the shipped frame. Native owns the rest of
/// the dimension math (even rounding, the 320 px long-edge floor); 1 is
/// byte-identical to no downscale at all.
export type PlaybackScaleDiv = 1 | 2 | 4;

/// Full ⇒ 1, Half ⇒ 2, Quarter ⇒ 4. Anything else — an absent field on an
/// older settings file, or a hand-edited value — resolves to full resolution,
/// the same direction `app-settings.ts`'s per-field defaulting takes.
export function playbackScaleDiv(
  resolution: PlaybackResolution | undefined,
): PlaybackScaleDiv {
  switch (resolution) {
    case "half":
      return 2;
    case "quarter":
      return 4;
    default:
      return 1;
  }
}

/// The knob's factor in the fraction handed to Pixi's `renderer.resolution`
/// (`previewRenderResolution`), which scales ONLY the canvas backing store —
/// every sprite transform, render texture and `containMap` stay in composition
/// coordinates. 1 is byte-identical to no throttle at all.
export type PlaybackRenderResolution = 1 | 0.5 | 0.25;

/// The reciprocal of `playbackScaleDiv`, spelled out rather than computed so
/// the return type stays the literal union. Routed through the divisor so the
/// two halves of the setting can never disagree about what "half" means.
export function playbackRenderResolution(
  resolution: PlaybackResolution | undefined,
): PlaybackRenderResolution {
  switch (playbackScaleDiv(resolution)) {
    case 2:
      return 0.5;
    case 4:
      return 0.25;
    default:
      return 1;
  }
}

/// A box in device pixels — the unit a backing store is allocated in and the
/// unit the compositor blits in.
export interface DeviceBox {
  width: number;
  height: number;
}

/// The space the preview host offers, in device pixels, and where its box
/// sits on the device grid — fractional, since CSS layout lands anywhere.
export interface HostBox {
  available: DeviceBox;
  origin: { x: number; y: number };
}

/// The room a CSS box offers, in whole device pixels — floored, never rounded.
/// A buffer one pixel taller than the fractional box it has to fit would be
/// clamped back to the box by the canvas's `max-height: 100%` and blitted
/// through a fraction-of-a-pixel squeeze, the very resample this arrangement
/// exists to avoid; Chromium's own `devicePixelContentBoxSize` snaps and can
/// round up, so it is not used for the room. The epsilon keeps an exact product
/// that floating point lands a hair under its integer (630 × 1.1) from losing
/// a pixel.
export function roomFrom(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): DeviceBox {
  return {
    width: Math.floor(cssWidth * devicePixelRatio + 1e-6),
    height: Math.floor(cssHeight * devicePixelRatio + 1e-6),
  };
}

/// The fraction of the composition's pixels the panel can show: the limiting
/// axis of the space the host offers, so a buffer drawn at this scale exceeds
/// that space on neither axis.
///
/// UNCAPPED — above 1 it says how far Fit magnifies, which CSS's contain-fit
/// performs rather than the buffer. The readout and the wheel need that
/// number: capped, Fit would read as 100 % on any panel larger than the
/// composition and the first wheel notch would jump. The cap belongs to the
/// raster instead (`previewRenderResolution`), where it stops the preview
/// showing detail the export cannot have.
///
/// An unknown or empty space — the host before its first layout, a hidden dock
/// tab — is 1: exactly the pre-fit path, byte-identical, which together with
/// the cap keeps every gate whose panel outgrows its composition out of the
/// blast radius.
///
/// LANDMINE: below 1 the renderer's LOGICAL size drifts off the composition by
/// up to half a backing pixel per axis (`TextureSource.resize` redefines it as
/// `pixels / resolution`), invisibly on screen but not in a number. Nothing may
/// read `app.screen` or `renderer.width/height` as the composition size; the
/// composition is the composition.
export function fitScale(
  composition: { width: number; height: number },
  available: DeviceBox | null,
): number {
  if (!available) return 1;
  const cw = composition.width, ch = composition.height;
  const aw = available.width, ah = available.height;
  if (!(cw > 0 && ch > 0 && aw > 0 && ah > 0)) return 1;
  return Math.min(aw / cw, ah / ch);
}

/// What the preview hands `renderer.resize` as its resolution: the smaller of
/// the fit and the knob. Pixels above the fit are never displayed (the box is
/// the fit's size), so a knob that only trimmed those would trim nothing
/// visible and save next to nothing — the buffer is already the panel's size,
/// and the knob's real saving, the decode divisor, applies regardless. Below
/// the fit the knob shrinks what IS displayed, which is where cutting raster
/// work costs sharpness and is worth the trade: a large panel at 1/2 renders
/// 960×540 instead of 1920×1080, as it always did. Premiere's program monitor
/// behaves the same way — 1/2 looks like Full until the monitor is big enough
/// to show the difference.
export function previewRenderResolution(
  setting: PlaybackResolution | undefined,
  composition: { width: number; height: number },
  available: DeviceBox | null,
  zoom: PreviewZoom = "fit",
): number {
  return Math.min(
    1,
    resolvePreviewZoom(zoom, fitScale(composition, available)),
    playbackRenderResolution(setting),
  );
}

/// The buffer Pixi allocates for a resolution: `round(composition × r)` per
/// axis (`TextureSource.resize`). Spelled out so the canvas box below agrees
/// with Pixi about the rounding, and so a test can hold both to it.
export function bufferFor(
  composition: { width: number; height: number },
  resolution: number,
): DeviceBox {
  return {
    width: Math.round(composition.width * resolution),
    height: Math.round(composition.height * resolution),
  };
}

/// The canvas element's box for a fit below 1, in CSS pixels relative to the
/// host: the size of the buffer the fit allocates (the Full buffer), centred in
/// the host and snapped to whole device pixels.
///
/// Two conditions make the compositor's blit a copy rather than a resample —
/// the box must cover exactly as many device pixels as the buffer has, and its
/// origin must sit on the device grid — and CSS can guarantee neither: a
/// contain-fit box lands on a fractional device size, and flex centring lands
/// on a fractional origin. Either one resamples every glyph by up to half a
/// pixel, which on text is the difference between a stem and a smear. So below
/// 1 the box is written from the fit, not the other way round; the fit is
/// therefore computed from the HOST's space, never from the canvas's own box.
/// A knob below the fit draws a smaller buffer into this same box and the
/// browser upscales it — the pre-fit look of 1/4 on a small panel.
///
/// At the default Fit view, null above source density lets CSS contain-fit
/// own the box. Any explicit zoom writes its box, including above source
/// density; `buffer` then describes the picture's pixel extent on screen,
/// while the raster behind it stays capped by `previewRenderResolution`.
export function fittedCanvasBox(input: {
  composition: { width: number; height: number };
  available: DeviceBox;
  hostOrigin: { x: number; y: number };
  devicePixelRatio: number;
  view?: { zoom: PreviewZoom; pan: Pan };
}): {
  buffer: DeviceBox;
  css: { left: number; top: number; width: number; height: number };
} | null {
  const zoom = input.view?.zoom ?? "fit";
  const pan = input.view?.pan ?? { x: 0, y: 0 };
  const scale = resolvePreviewZoom(zoom, fitScale(input.composition, input.available));
  // Preserve CSS's existing Fit path for a panel larger than the composition.
  if (zoom === "fit" && scale >= 1 && pan.x === 0 && pan.y === 0) return null;
  const buffer = bufferFor(input.composition, scale);
  const dpr = input.devicePixelRatio;
  const { x: ox, y: oy } = input.hostOrigin;
  // Centre in device pixels, round to the grid in ABSOLUTE device coordinates
  // (the host's own origin is fractional), then express relative to the host.
  const dx = clampPreviewPan(pan.x * dpr, buffer.width, input.available.width);
  const dy = clampPreviewPan(pan.y * dpr, buffer.height, input.available.height);
  const left = Math.round(ox + (input.available.width - buffer.width) / 2 + dx) - ox;
  const top = Math.round(oy + (input.available.height - buffer.height) / 2 + dy) - oy;
  return {
    buffer,
    css: {
      left: left / dpr,
      top: top / dpr,
      width: buffer.width / dpr,
      height: buffer.height / dpr,
    },
  };
}
