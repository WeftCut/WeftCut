// The one place the user-facing Playback Resolution preference becomes a
// number, and the one place the preview's on-screen box joins it. The settings
// file, the UI and the i18n keys speak in fractions (`full` | `half` |
// `quarter`); the two halves of the setting each want a different shape of the
// same number — the native ship stage takes a divisor
// (`FfmpegSourceInit.playbackScaleDiv` → `SwTransport` → `preview_sw_open`'s
// `scale_div` → Rust `OutScale`), Pixi's renderer takes the smaller of its
// reciprocal and how much of the composition the preview panel can show at
// all (`displayFit`). See docs/render.md §Preview canvas, ADR 0071.
import type { PlaybackResolution } from "../../../shared/app-settings";

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
/// axis of the space the host offers, so the buffer exceeds that space on
/// neither axis.
///
/// Capped at 1: the preview must not show detail the export cannot have, so a
/// 720p composition in a wide panel is drawn at 720p and upscaled, as every NLE
/// program monitor is above 100 %. An unknown or empty space — the host before
/// its first layout, a hidden dock tab — is 1 as well: exactly the pre-fit
/// path, byte-identical, which together with the cap keeps every gate whose
/// panel outgrows its composition out of the blast radius.
///
/// LANDMINE: below 1 the renderer's LOGICAL size drifts off the composition by
/// up to half a backing pixel per axis (`TextureSource.resize` redefines it as
/// `pixels / resolution`), invisibly on screen but not in a number. Nothing may
/// read `app.screen` or `renderer.width/height` as the composition size; the
/// composition is the composition.
export function displayFit(
  composition: { width: number; height: number },
  available: DeviceBox | null,
): number {
  if (!available) return 1;
  const cw = composition.width, ch = composition.height;
  const aw = available.width, ah = available.height;
  if (!(cw > 0 && ch > 0 && aw > 0 && ah > 0)) return 1;
  return Math.min(1, aw / cw, ah / ch);
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
): number {
  return Math.min(displayFit(composition, available), playbackRenderResolution(setting));
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
/// Null at a fit of 1: the buffer is then the composition, CSS's contain-fit
/// owns the box, and the browser upscales as it always did.
export function fittedCanvasBox(input: {
  composition: { width: number; height: number };
  available: DeviceBox;
  hostOrigin: { x: number; y: number };
  devicePixelRatio: number;
}): {
  buffer: DeviceBox;
  css: { left: number; top: number; width: number; height: number };
} | null {
  const fit = displayFit(input.composition, input.available);
  if (fit >= 1) return null;
  const buffer = bufferFor(input.composition, fit);
  const dpr = input.devicePixelRatio;
  const { x: ox, y: oy } = input.hostOrigin;
  // Centre in device pixels, round to the grid in ABSOLUTE device coordinates
  // (the host's own origin is fractional), then express relative to the host.
  const left = Math.round(ox + (input.available.width - buffer.width) / 2) - ox;
  const top = Math.round(oy + (input.available.height - buffer.height) / 2) - oy;
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
