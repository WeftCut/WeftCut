import { describe, expect, it } from "vitest";

import { wheelPixels, wheelScrollPlan, type WheelLike } from "./wheelScroll";

/// A pixel-mode wheel notch with no modifiers — Chromium's shape on this
/// machine, and the baseline every case below varies one field of.
const wheel = (over: Partial<WheelLike> = {}): WheelLike => ({
  deltaX: 0,
  deltaY: 100,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
});

describe("wheelPixels", () => {
  it("passes pixel mode through and scales lines and pages", () => {
    expect(wheelPixels(100, 0)).toBe(100);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(1, 2)).toBe(100);
    // Direction survives every mode: up is negative everywhere.
    expect(wheelPixels(-3, 1)).toBe(-48);
  });
});

describe("wheelScrollPlan in horizontal mode", () => {
  it("sends the bare wheel along time", () => {
    expect(wheelScrollPlan(wheel(), "horizontal")).toEqual({ dx: 100, dy: 0 });
    expect(wheelScrollPlan(wheel({ deltaY: -100 }), "horizontal")).toEqual({
      dx: -100,
      dy: 0,
    });
  });

  it("normalises a line-mode mouse before it moves anything", () => {
    expect(wheelScrollPlan(wheel({ deltaY: 3, deltaMode: 1 }), "horizontal"))
      .toEqual({ dx: 48, dy: 0 });
  });

  // The reason Shift can't simply fall through to the platform: Chromium's own
  // Shift rule scrolls horizontally, which is the axis the user just modified
  // away from.
  it("claims Shift for the vertical axis instead of letting Chromium have it", () => {
    expect(wheelScrollPlan(wheel({ shiftKey: true }), "horizontal")).toEqual({
      dx: 0,
      dy: 100,
    });
  });

  // Which delta field carries the amount under Shift is a platform detail, so
  // the mapping reads whichever one is populated.
  it("finds the Shift amount on deltaX when the platform puts it there", () => {
    expect(
      wheelScrollPlan(
        wheel({ deltaX: 100, deltaY: 0, shiftKey: true }),
        "horizontal",
      ),
    ).toEqual({ dx: 0, dy: 100 });
  });

  // A trackpad's sideways swipe is already moving along time; remapping deltaY
  // on top would double the travel and cost the gesture its momentum.
  it("leaves a gesture that already has a horizontal component alone", () => {
    expect(wheelScrollPlan(wheel({ deltaX: 40 }), "horizontal")).toBeNull();
    expect(wheelScrollPlan(wheel({ deltaX: 40, deltaY: 0 }), "horizontal")).toBeNull();
  });

  it("declines an empty event", () => {
    expect(wheelScrollPlan(wheel({ deltaY: 0 }), "horizontal")).toBeNull();
  });

  // Precedence is by modifier, not by listener order: the zoom gesture
  // (hooks/useTimelineView.ts) owns both of these.
  it("declines the zoom modifiers", () => {
    expect(wheelScrollPlan(wheel({ ctrlKey: true }), "horizontal")).toBeNull();
    expect(wheelScrollPlan(wheel({ altKey: true }), "horizontal")).toBeNull();
    expect(
      wheelScrollPlan(wheel({ ctrlKey: true, shiftKey: true }), "horizontal"),
    ).toBeNull();
  });
});

describe("wheelScrollPlan in vertical mode", () => {
  // Vertical mode IS Chromium's default mapping, so the honest implementation
  // claims nothing at all and keeps the platform's smoothing.
  it("hands every gesture back to the platform", () => {
    expect(wheelScrollPlan(wheel(), "vertical")).toBeNull();
    expect(wheelScrollPlan(wheel({ shiftKey: true }), "vertical")).toBeNull();
    expect(wheelScrollPlan(wheel({ deltaX: 40 }), "vertical")).toBeNull();
  });
});
