// apps/desktop/src/shared/newProject.ts
//
// What a new project may be called and what canvas it may start on — the New
// Project dialog's rules, here so MCP's `create_project` applies the very same
// ones. Pure: callers own the copy (the dialog translates the keys; the MCP
// surface renders its own English).

/// Reserved file/folder names that are illegal on Windows regardless of
/// extension. We block the full set so projects stay portable. NUL and
/// CON show up in real systems; the LPT/COM band is rarer but cheap to
/// guard against.
const RESERVED_NAMES = new Set<string>([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const INVALID_CHARS = /[\\/:*?"<>|]/;

/// Validate a project name for filesystem compatibility. Returns either
/// an i18n key for the failure mode, or `null` when valid. Checks the
/// union of Windows + POSIX rules so projects round-trip across OSes
/// without surprises.
export function validateProjectName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "new_project.validation_empty";
  if (trimmed !== raw) return "new_project.validation_whitespace";
  if (INVALID_CHARS.test(trimmed)) return "new_project.validation_invalid_chars";
  if (trimmed.endsWith(".")) return "new_project.validation_trailing_dot";
  // Windows reserved-names check is case-insensitive and ignores any
  // extension suffix — `con.txt` is also reserved. We compare on the
  // pre-dot prefix uppercased.
  const stem = trimmed.split(".")[0]!.toUpperCase();
  if (RESERVED_NAMES.has(stem)) return "new_project.validation_reserved";
  return null;
}

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
export const DEFAULT_CANVAS: { width: number; height: number; fpsNum: number; fpsDen: number } = {
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
