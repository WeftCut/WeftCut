// Every rate the app offers must be a rate the whole grid actually works at —
// which matters more than usual because `set_composition { fps }` locks once the
// timeline holds a layer (spec R2-D1), so the choice is effectively IRREVERSIBLE.
// A rate the ruler or the actor mishandled would be a trap.
//
// The ACTOR half of that claim (a first layer comes out canonical, and the rate is
// locked afterwards) lives in `main/state/__tests__/pbt/grid-invariant.test.ts`:
// `tsconfig.web.json` does not include `src/main`, so a renderer test cannot reach
// the actor, while main's project does include renderer files.
import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX,
  CANVAS_MIN,
  DEFAULT_CANVAS,
  FPS_OPTIONS,
  RESOLUTION_PRESETS,
  canvasSizeError,
  formatFps,
} from "./canvasPresets";
import { STANDARD_HEIGHTS } from "../render/exportSettings";
import { formatTimecode, parseTimecode, timeUsAtFrame } from "../frames";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";

const RATES = FPS_OPTIONS.map(({ num, den }) => [`${num}/${den}`, num, den] as const);

describe("frame rates", () => {
  it("covers the spec's rate matrix and stays under the two-digit frame-field ceiling", () => {
    const offered = new Set(RATES.map(([key]) => key));
    // spec § Gates and test assets.
    for (const r of ["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1"]) {
      expect(offered, `rate matrix entry ${r} must be authorable`).toContain(r);
    }
    // R2-D5: no custom-rate entry, so 60 fps is the ceiling and `formatTimecode`'s
    // two-digit frame field stays correct. A >99 fps preset would silently truncate.
    for (const [key, num, den] of RATES) {
      expect(num / den, `${key} must not exceed 99 fps`).toBeLessThanOrEqual(60);
    }
  });

  it("offers each rate once — the two pickers render this list verbatim", () => {
    expect(new Set(RATES.map(([key]) => key)).size).toBe(FPS_OPTIONS.length);
  });

  it("rounds the label without touching the rational the wire carries", () => {
    expect(formatFps(30, 1)).toBe("30");
    expect(formatFps(30_000, 1001)).toBe("29.97");
    expect(formatFps(24_000, 1001)).toBe("23.976");
  });

  it("has a note in every locale for every noteKey, and no orphans", () => {
    const used = new Set(FPS_OPTIONS.flatMap((f) => (f.noteKey ? [f.noteKey] : [])));
    for (const key of used) {
      expect(en.canvas.fps_note, `en-US note for ${key}`).toHaveProperty(key);
      expect(zh.canvas.fps_note, `zh-CN note for ${key}`).toHaveProperty(key);
    }
    // A renamed key would otherwise leave dead strings behind in both locales.
    for (const k of Object.keys(en.canvas.fps_note)) expect(used).toContain(k);
    for (const k of Object.keys(zh.canvas.fps_note)) expect(used).toContain(k);
  });

  it.each(RATES)("%s: ruler labels read the expected SMPTE frame numbers", (_key, num, den) => {
    const framesPerSec = Math.round(num / den);
    // Frame i's label must count i modulo the ROUNDED rate — that is what NDF means
    // — and the seconds field must advance exactly every `framesPerSec` frames.
    for (const i of [0, 1, framesPerSec - 1, framesPerSec, framesPerSec + 1, framesPerSec * 61 + 7]) {
      const us = timeUsAtFrame(i, num, den);
      const totalSec = Math.floor(i / framesPerSec);
      const pad = (n: number) => n.toString().padStart(2, "0");
      const expected =
        `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:` +
        `${pad(totalSec % 60)}:${pad(i % framesPerSec)}`;
      expect(formatTimecode(us, num, den)).toBe(expected);
      // The label round-trips back to the same canonical µs, so typing a ruler
      // reading into a timecode field lands on the frame it named.
      expect(parseTimecode(expected, num, den)).toBe(us);
    }
  });
});

describe("resolution ladder", () => {
  it("is export's downscale ladder widened to 16:9, largest first", () => {
    expect(RESOLUTION_PRESETS.map((p) => p.height)).toEqual([...STANDARD_HEIGHTS]);
  });

  /// An odd width would be silently shaved by the encoder's `makeEven` at export
  /// time — the project would render one pixel narrower than it was authored.
  it("offers no dimension an encoder would have to shave", () => {
    for (const p of RESOLUTION_PRESETS) {
      expect(canvasSizeError(p.width, p.height), `${p.width}x${p.height}`).toBeNull();
    }
  });
});

describe("canvasSizeError", () => {
  it("accepts an even size inside the bounds", () => {
    expect(canvasSizeError(1920, 1080)).toBeNull();
    expect(canvasSizeError(CANVAS_MIN, CANVAS_MIN)).toBeNull();
  });

  it("names the range rule for an out-of-bounds side, in either dimension", () => {
    expect(canvasSizeError(CANVAS_MAX + 2, 1080)?.key).toBe("canvas.size_range");
    expect(canvasSizeError(1920, CANVAS_MIN - 2)?.key).toBe("canvas.size_range");
  });

  /// A fractional value belongs to the even/whole rule, not the range one:
  /// "1920.5 must be between 16 and 7680" reads as a lie.
  it("calls a fractional or odd side odd, not out of range", () => {
    expect(canvasSizeError(1921, 1080)?.key).toBe("canvas.size_odd");
    expect(canvasSizeError(1920.5, 1080)?.key).toBe("canvas.size_odd");
  });

  /// Both sides can be legal on their own and still cost more memory than the
  /// preview pipeline will spend — 7680 × 4320 is the area ceiling.
  it("rejects a legal-per-side pair that overruns the area ceiling", () => {
    expect(canvasSizeError(7680, 4320)).toBeNull();
    expect(canvasSizeError(7680, 4322)?.key).toBe("canvas.size_too_many_pixels");
  });

  it("carries the bounds as params so one message serves both surfaces", () => {
    expect(canvasSizeError(2, 2)?.params).toEqual({ min: CANVAS_MIN, max: CANVAS_MAX });
  });
});

/// The New Project dialog seeds both its dropdowns from this pair. If either half
/// were off its ladder the dialog would open reading "Custom" with the size fields
/// already showing — for the default nobody chose.
describe("DEFAULT_CANVAS", () => {
  it("sits on both ladders", () => {
    expect(
      RESOLUTION_PRESETS.some(
        (p) => p.width === DEFAULT_CANVAS.width && p.height === DEFAULT_CANVAS.height,
      ),
    ).toBe(true);
    expect(
      FPS_OPTIONS.some((f) => f.num === DEFAULT_CANVAS.fpsNum && f.den === DEFAULT_CANVAS.fpsDen),
    ).toBe(true);
  });
});
