// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  foreignCompositionAtPoint,
  registerTimelineSurface,
} from "./timelineSurfaces";

const ROOT = "comp-root";
const GROUP = "comp-group";
const releases: Array<() => void> = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()!();
});

/// jsdom lays nothing out, so every surface is given the box it would occupy.
function surface(
  compositionId: string,
  box: { left: number; right: number; top: number; bottom: number },
): HTMLElement {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...box,
    width: box.right - box.left,
    height: box.bottom - box.top,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect);
  releases.push(registerTimelineSurface(compositionId, el));
  return el;
}

/// Side by side, sharing every row — the arrangement that makes a lane
/// hit-test's `clientY` band unable to tell the two Panels apart.
function twoPanels(): void {
  surface(ROOT, { left: 0, right: 500, top: 0, bottom: 200 });
  surface(GROUP, { left: 500, right: 1000, top: 0, bottom: 200 });
}

describe("timeline surfaces", () => {
  it("names the OTHER Panel a point is inside, and stays quiet over the host", () => {
    twoPanels();

    expect(foreignCompositionAtPoint(ROOT, 700, 40)).toBe(GROUP);
    expect(foreignCompositionAtPoint(GROUP, 100, 40)).toBe(ROOT);
    // Inside the host, and below both — neither is a crossing.
    expect(foreignCompositionAtPoint(ROOT, 100, 40)).toBeNull();
    expect(foreignCompositionAtPoint(ROOT, 700, 400)).toBeNull();
  });

  it("treats the right edge as belonging to the next Panel", () => {
    twoPanels();

    // Half-open, so the seam has exactly one owner rather than two answers.
    expect(foreignCompositionAtPoint(ROOT, 500, 40)).toBe(GROUP);
    expect(foreignCompositionAtPoint(ROOT, 499, 40)).toBeNull();
  });

  it("measures nothing while one timeline stands alone", () => {
    const only = surface(ROOT, { left: 0, right: 500, top: 0, bottom: 200 });
    const measure = vi.spyOn(only, "getBoundingClientRect");
    measure.mockClear();

    expect(foreignCompositionAtPoint(ROOT, 100, 40)).toBeNull();
    // The unbound row has no composition to be foreign to either.
    expect(foreignCompositionAtPoint(null, 100, 40)).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it("forgets a Panel that unregisters, and keeps a remount's entry", () => {
    surface(GROUP, { left: 0, right: 500, top: 0, bottom: 200 });
    const stale = releases.pop()!;
    surface(GROUP, { left: 600, right: 900, top: 0, bottom: 200 });
    surface(ROOT, { left: 0, right: 500, top: 0, bottom: 200 });
    // A stale cleanup arriving after the remount must not drop the live entry.
    stale();
    expect(foreignCompositionAtPoint(ROOT, 700, 40)).toBe(GROUP);
  });
});
