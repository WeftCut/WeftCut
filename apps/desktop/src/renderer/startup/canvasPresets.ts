import type { TFunction } from "i18next";

import type { CanvasPreset } from "../ipc";
import { STANDARD_HEIGHTS } from "../render/exportSettings";

/// The canvas vocabulary — size ladder, rate ladder, bounds, labels — shared by
/// the two surfaces that author a composition's canvas: the New Project dialog
/// (`startup/StartupScreen.tsx`) and Settings › Canvas (`settings/SettingsPanel.tsx`).
///
/// One module rather than two lists that "should" agree: a rate or size offered
/// at creation but not afterwards (or the reverse) is a trap, because the rate is
/// effectively a one-way choice — `set_composition { fps }` locks once the
/// timeline holds a layer (spec R2-D1).

/// 16:9 resolution presets, largest first — the same ladder export offers as
/// downscale targets (`STANDARD_HEIGHTS`), widened to full dimensions here.
/// Every width lands even (480 -> 854, not 853) because an odd dimension would be
/// silently shaved by the encoder's `makeEven` at export time.
export const RESOLUTION_PRESETS: ReadonlyArray<{ width: number; height: number }> =
  STANDARD_HEIGHTS.map((height) => {
    const w = Math.round((height * 16) / 9);
    return { width: w % 2 === 0 ? w : w + 1, height };
  });

/// The complete set of authorable rates — this list IS the rate picker on both
/// surfaces, and there is no custom-rate entry.
///
/// That is why the list must cover every standard rate, export's `STANDARD_FPS`
/// (`exportSettings.ts`) included: an incomplete list plus an irreversible choice
/// is a trap — a PAL or 24p shooter would have to edit on a 30 fps timeline and
/// rate-convert on export, which is exactly the judder case.
///
/// No custom entry is also what keeps `formatTimecode`'s frame field two digits:
/// the ceiling here is 60 fps (R2-D5). Fractional rates carry the exact rational —
/// 30000/1001 is not 29.97 to ffmpeg — and the label rounds for reading only.
///
/// `noteKey` indexes `canvas.fps_note.*` in the locales. It is the only part of a
/// rate that needs translating, and it earns its place at creation time: "25" does
/// not say PAL to someone who has not shot PAL, and by the time they find out the
/// rate is locked.
export interface FpsOption {
  num: number;
  den: number;
  noteKey?: string;
}
export const FPS_OPTIONS: ReadonlyArray<FpsOption> = [
  { num: 30, den: 1 },
  { num: 60, den: 1 },
  { num: 24, den: 1, noteKey: "film" },
  { num: 25, den: 1, noteKey: "pal" },
  { num: 50, den: 1, noteKey: "pal" },
  // The NTSC family, grouped last: 23.976 / 29.97 / 59.94 are all n/1001.
  { num: 24000, den: 1001, noteKey: "ntsc_film" },
  { num: 30000, den: 1001, noteKey: "ntsc" },
  { num: 60000, den: 1001, noteKey: "ntsc" },
];

/// What a new project opens on: 1080p60.
///
/// 1080p rather than the top of the size ladder because 4K costs real memory on
/// every preview frame, and a size is cheap to change later anyway.
///
/// 60 because the RATE is the half that gets expensive to change — it locks once
/// the timeline holds a layer — so the default leans to the rate that keeps the
/// most options open: a 60 fps timeline carries 30 fps footage intact, while a
/// 30 fps timeline throws away half of what a phone or a screen recorder hands it.
///
/// Both halves stay editable in Settings until the timeline takes its first layer.
export const DEFAULT_CANVAS: CanvasPreset = {
  width: 1920,
  height: 1080,
  fpsNum: 60,
  fpsDen: 1,
};

/// Canvas bounds. Even because yuv420 encoders need it; 8K as the ceiling
/// because canvas size drives the transition RT pool and every sprite's texture
/// allocation, and 16 as a floor so a half-typed "1" can't land as a 1x1 canvas.
export const CANVAS_MIN = 16;
export const CANVAS_MAX = 7680;
const CANVAS_MAX_PIXELS = 7680 * 4320;

/// Pure size validator, shared so the two dialogs can't drift into disagreeing
/// about what is a legal canvas. Returns an i18n key + params rather than a
/// string: the caller owns `t`, and the message must read identically wherever
/// a size is typed.
export function canvasSizeError(
  width: number,
  height: number,
): { key: string; params?: Record<string, number> } | null {
  for (const v of [width, height]) {
    if (v < CANVAS_MIN || v > CANVAS_MAX) {
      return { key: "canvas.size_range", params: { min: CANVAS_MIN, max: CANVAS_MAX } };
    }
    // A fractional value belongs to the even/whole rule, not the range one —
    // "1920.5 must be between 16 and 7680" reads as a lie.
    if (!Number.isInteger(v) || v % 2 !== 0) return { key: "canvas.size_odd" };
  }
  if (width * height > CANVAS_MAX_PIXELS) return { key: "canvas.size_too_many_pixels" };
  return null;
}

/// Rounded for reading only — the exact rational is what travels over the wire
/// (30000/1001 is not 29.97 to ffmpeg). Trailing zeros trimmed: 29.970 -> 29.97.
export function formatFps(num: number, den: number): string {
  if (den === 1) return String(num);
  return (num / den).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/// The one rate label. `t` is a parameter rather than an import so this module
/// stays pure (and so a test can read the same label in either locale).
export function fpsLabel(f: FpsOption, t: TFunction): string {
  const rate = `${formatFps(f.num, f.den)} fps`;
  return f.noteKey ? `${rate} (${t(`canvas.fps_note.${f.noteKey}`)})` : rate;
}

/// The one size label. Dimensions, not a nickname: "1920 x 1080" is what the
/// custom fields below it read out, so the two never disagree.
export function resolutionLabel(p: { width: number; height: number }): string {
  return `${p.width} × ${p.height}`;
}
