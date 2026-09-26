import type { TFunction } from "i18next";

import type { FpsOption } from "../../shared/newProject";
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

/// The authoring rules themselves — rate ladder, default, bounds, size check —
/// live in `shared/newProject.ts`, where MCP's `create_project` reads them too.
export {
  CANVAS_MAX,
  CANVAS_MIN,
  DEFAULT_CANVAS,
  FPS_OPTIONS,
  canvasSizeError,
  type FpsOption,
} from "../../shared/newProject";

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
