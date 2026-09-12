import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bufferFor,
  displayFit,
  fittedCanvasBox,
  playbackRenderResolution,
  playbackScaleDiv,
  previewRenderResolution,
  roomFrom,
} from "./playbackResolution";

describe("zoomed preview", () => {
  const composition = { width: 1920, height: 1080 };
  const available = { width: 960, height: 540 };

  it("raises raster density with zoom, bounded by source size and the quality knob", () => {
    expect(previewRenderResolution("full", composition, available, 0.5)).toBe(0.25);
    expect(previewRenderResolution("full", composition, available, 1.5)).toBe(0.75);
    expect(previewRenderResolution("full", composition, available, 4)).toBe(1);
    expect(previewRenderResolution("half", composition, available, 4)).toBe(0.5);
    expect(previewRenderResolution("quarter", composition, available, 4)).toBe(0.25);
    // Multiply the uncapped display scale: a large panel zoomed out can still
    // be above source resolution. Capping Fit before multiplying loses detail.
    expect(previewRenderResolution("full", { width: 480, height: 270 }, available, 0.75)).toBe(1);
  });

  it("zooms beyond the host and clamps pan so the picture cannot get lost", () => {
    const box = fittedCanvasBox({ composition, available, hostOrigin: { x: 0, y: 0 },
      devicePixelRatio: 1, view: { zoom: 2, pan: { x: 9999, y: -9999 } } })!;
    expect(box.css).toEqual({ left: 0, top: -540, width: 1920, height: 1080 });
  });

  it("centres each axis that fits and preserves device-grid alignment at fractional DPR", () => {
    const box = fittedCanvasBox({ composition, available: { width: 1000, height: 1000 },
      hostOrigin: { x: 0.3, y: 0.7 }, devicePixelRatio: 1.25,
      view: { zoom: 1.5, pan: { x: 9999, y: 9999 } } })!;
    expect(box.css.width * 1.25).toBe(1500);
    expect(box.css.height * 1.25).toBe(844);
    expect(box.css.top * 1.25).toBeCloseTo(78.3);
    expect(box.css.left * 1.25 + 0.3).toBeCloseTo(0);
  });
});

describe("playbackScaleDiv", () => {
  it("maps each fraction to the native ship-stage divisor", () => {
    expect(playbackScaleDiv("full")).toBe(1);
    expect(playbackScaleDiv("half")).toBe(2);
    expect(playbackScaleDiv("quarter")).toBe(4);
  });

  it("resolves an absent setting to full resolution", () => {
    // An additive field loads as `undefined` from a settings file written
    // before it existed; full res (divisor 1) is byte-identical to today.
    expect(playbackScaleDiv(undefined)).toBe(1);
  });

  it("resolves an unrecognized value to full resolution", () => {
    // Hand-edited app_settings.json. Never throw, never ship a fraction the
    // user didn't ask for.
    expect(playbackScaleDiv("eighth" as never)).toBe(1);
  });
});

describe("playbackRenderResolution", () => {
  it("maps each fraction to the Pixi renderer resolution", () => {
    expect(playbackRenderResolution("full")).toBe(1);
    expect(playbackRenderResolution("half")).toBe(0.5);
    expect(playbackRenderResolution("quarter")).toBe(0.25);
  });

  it("stays the exact reciprocal of the ship-stage divisor", () => {
    // The two halves of one user-facing control: a preview whose raster and
    // decode fractions disagreed would resample every frame for nothing.
    for (const r of ["full", "half", "quarter", undefined] as const) {
      expect(playbackRenderResolution(r) * playbackScaleDiv(r)).toBe(1);
    }
  });

  it("resolves an absent or unrecognized setting to 1", () => {
    // Exactly 1 is the contract that keeps a default-settings canvas
    // byte-identical to no throttle at all.
    expect(playbackRenderResolution(undefined)).toBe(1);
    expect(playbackRenderResolution("eighth" as never)).toBe(1);
  });
});

describe("export ignores the playback-resolution setting", () => {
  // A silently half-resolution export would be a data-loss bug, so pin the
  // absence rather than trusting convention: the export Worker builds its own
  // Application at output resolution and must never read this preference.
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("the export Worker never reads it", () => {
    const src = read("../worker/exportWorker.ts");
    expect(src).not.toContain("playback_resolution");
    expect(src).not.toContain("playbackResolution");
    expect(src).not.toContain("playbackScaleDiv");
  });

  it("neither does the export launcher", () => {
    const src = read("../worker/runExport.ts");
    expect(src).not.toContain("playback_resolution");
    expect(src).not.toContain("playbackResolution");
    expect(src).not.toContain("playbackScaleDiv");
  });
});

describe("roomFrom", () => {
  it("floors the fractional device box rather than rounding it", () => {
    // 748.82 CSS px at DPR 1.1 is 823.7 device px: a buffer 824 tall would be
    // clamped to the box and squeezed on the blit, so the room is 823.
    expect(roomFrom(613.4, 748.8181, 1.1)).toEqual({ width: 674, height: 823 });
  });

  it("keeps an exact product whole", () => {
    // 630 × 1.1 lands a hair under 693 in floating point; the room is 693.
    expect(roomFrom(630, 354.375, 1.100000023841858)).toEqual({ width: 693, height: 389 });
    expect(roomFrom(600, 240, 1)).toEqual({ width: 600, height: 240 });
  });
});

const hd = { width: 1920, height: 1080 };
const uhd = { width: 3840, height: 2160 };

describe("displayFit", () => {
  it("is exactly 1 without a box, or with room for the whole composition", () => {
    // Both are the pre-fit path — the contract every gate whose panel outgrows
    // its composition relies on for byte-identical pixels.
    expect(displayFit(hd, null)).toBe(1);
    expect(displayFit(hd, { width: 1920, height: 1080 })).toBe(1);
    expect(displayFit(hd, { width: 2560, height: 1440 })).toBe(1);
    expect(displayFit({ width: 640, height: 360 }, { width: 900, height: 506 })).toBe(1);
  });

  it("treats an empty or degenerate box as unknown", () => {
    // A hidden dock tab lays the host out at 0×0; the last good fit must
    // survive that, so this reads as "no box" rather than as a zero buffer.
    expect(displayFit(hd, { width: 0, height: 0 })).toBe(1);
    expect(displayFit(hd, { width: 675, height: 0 })).toBe(1);
    expect(displayFit({ width: 0, height: 0 }, { width: 675, height: 380 })).toBe(1);
  });

  it("is the limiting axis, so the buffer never exceeds the room on either", () => {
    // A 16:9 composition in a wider-than-16:9 host is height-limited, in a
    // taller one width-limited.
    expect(displayFit(hd, { width: 1000, height: 390 })).toBe(390 / 1080);
    expect(displayFit(hd, { width: 693, height: 1000 })).toBe(693 / 1920);
    for (const room of [
      { width: 693, height: 389 },
      { width: 613, height: 345 },
      { width: 100, height: 1000 },
      { width: 1000, height: 100 },
    ]) {
      const b = bufferFor(hd, displayFit(hd, room));
      expect(b.width).toBeLessThanOrEqual(room.width);
      expect(b.height).toBeLessThanOrEqual(room.height);
    }
  });

  it("never exceeds 1, whichever side of the composition the room lands", () => {
    expect(displayFit(hd, { width: 1920, height: 1079 })).toBeLessThan(1);
    expect(displayFit(hd, { width: 1921, height: 1081 })).toBe(1);
  });
});

describe("previewRenderResolution", () => {
  const room = { width: 693, height: 389 };

  it("is the smaller of the fit and the knob", () => {
    // A 1080p composition in a 693 px panel fits at 0.36: 1/2 would only trim
    // pixels the panel never shows, so it stays at the fit; 1/4 goes below it.
    const fit = displayFit(hd, room);
    expect(fit).toBeLessThan(0.5);
    expect(fit).toBeGreaterThan(0.25);
    expect(previewRenderResolution("full", hd, room)).toBe(fit);
    expect(previewRenderResolution("half", hd, room)).toBe(fit);
    expect(previewRenderResolution("quarter", hd, room)).toBe(0.25);
  });

  it("is the knob alone when the panel has room for the whole composition", () => {
    // The pre-fit numbers: a large panel at 1/2 renders 960×540 as it always did.
    const wide = { width: 2560, height: 1440 };
    expect(previewRenderResolution("full", hd, wide)).toBe(1);
    expect(previewRenderResolution("half", hd, wide)).toBe(0.5);
    expect(previewRenderResolution("quarter", hd, wide)).toBe(0.25);
  });

  it("is the knob alone without a box", () => {
    // Exactly the pre-fit numbers, so a host that has not been laid out yet
    // draws what it always did.
    expect(previewRenderResolution("full", hd, null)).toBe(1);
    expect(previewRenderResolution("half", hd, null)).toBe(0.5);
    expect(previewRenderResolution(undefined, hd, null)).toBe(1);
  });
});

describe("fittedCanvasBox", () => {
  const dpr = 1.100000023841858;
  const hostOrigin = { x: 560.98, y: 141.09 };

  it("is null at a fit of 1, leaving the box to CSS", () => {
    expect(
      fittedCanvasBox({ composition: hd, available: hd, hostOrigin, devicePixelRatio: dpr }),
    ).toBeNull();
    expect(
      fittedCanvasBox({
        composition: { width: 640, height: 360 },
        available: { width: 900, height: 506 },
        hostOrigin,
        devicePixelRatio: 1,
      }),
    ).toBeNull();
  });

  it("covers exactly the buffer's device pixels and starts on the device grid", () => {
    // The two conditions for a 1:1 blit, at a fractional DPR and a fractional
    // host origin — the case CSS alone cannot meet.
    for (const [composition, available] of [
      [hd, { width: 693, height: 389 }],
      [hd, { width: 1464, height: 824 }],
      [uhd, { width: 613, height: 345 }],
      [{ width: 1080, height: 1920 }, { width: 500, height: 800 }],
    ] as const) {
      const box = fittedCanvasBox({ composition, available, hostOrigin, devicePixelRatio: dpr });
      expect(box).not.toBeNull();
      const { buffer, css } = box!;
      expect(buffer).toEqual(bufferFor(composition, displayFit(composition, available)));
      expect(css.width * dpr).toBeCloseTo(buffer.width, 9);
      expect(css.height * dpr).toBeCloseTo(buffer.height, 9);
      const absX = hostOrigin.x + css.left * dpr;
      const absY = hostOrigin.y + css.top * dpr;
      expect(absX).toBeCloseTo(Math.round(absX), 9);
      expect(absY).toBeCloseTo(Math.round(absY), 9);
    }
  });

  it("stays inside the room and within a device pixel of centred", () => {
    for (const available of [
      { width: 693, height: 389 },
      { width: 600, height: 240 },
      { width: 240, height: 500 },
    ]) {
      const { buffer, css } = fittedCanvasBox({
        composition: { width: 1600, height: 900 },
        available,
        hostOrigin,
        devicePixelRatio: dpr,
      })!;
      const left = css.left * dpr, top = css.top * dpr;
      expect(left).toBeGreaterThanOrEqual(-0.5);
      expect(top).toBeGreaterThanOrEqual(-0.5);
      expect(left + buffer.width).toBeLessThanOrEqual(available.width + 0.5);
      expect(top + buffer.height).toBeLessThanOrEqual(available.height + 0.5);
      expect(Math.abs(left + buffer.width / 2 - available.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(top + buffer.height / 2 - available.height / 2)).toBeLessThanOrEqual(1);
    }
  });

  it("at DPR 1 with an integer host origin reproduces the contain box to the pixel", () => {
    // The E2E layout gate's case: 1600×900 in a 600×240 surface is
    // height-limited, so the height is exact and the width rounds to 427.
    const { buffer, css } = fittedCanvasBox({
      composition: { width: 1600, height: 900 },
      available: { width: 600, height: 240 },
      hostOrigin: { x: 0, y: 0 },
      devicePixelRatio: 1,
    })!;
    expect(buffer).toEqual({ width: 427, height: 240 });
    expect(css).toEqual({ left: 87, top: 0, width: 427, height: 240 });
  });
});
