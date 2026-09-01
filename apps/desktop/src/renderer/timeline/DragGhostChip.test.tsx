// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n"; // the refusal badge reads t(...)
import {
  DragGhostChip,
  dragGhostBand,
  GHOST_HEAD_CAP_PX,
} from "./DragGhostChip";
import {
  DEFAULT_TRACK_HEIGHT,
  DROP_STRIP_HEIGHT_PX,
  MIN_TRACK_HEIGHT,
  layerSliceRect,
} from "./geometry";
import { SPAWN_TRACK_ID, type PlacementValidity } from "./placement";

afterEach(cleanup);

/// One ghost on a given band. Both surfaces render exactly this — the drop strip
/// against its own row, the destination Panel against `timeline-canvas` — so what
/// a case here pins holds for both of them.
function mountChip(
  band: { top: number; height: number },
  validity: PlacementValidity = "spawn",
) {
  const view = render(
    <DragGhostChip
      testId="ghost"
      layerId="l-1"
      trackId={band.height === DROP_STRIP_HEIGHT_PX ? SPAWN_TRACK_ID : "t-1"}
      name="Beach"
      kind="VideoClip"
      tStartUs={1_000_000}
      tEndUs={2_000_000}
      validity={validity}
      pxPerSec={80}
      fpsNum={30}
      fpsDen={1}
      {...band}
    />,
  );
  return view.getByTestId("ghost");
}

describe("dragGhostBand", () => {
  it("gives the drop strip the whole row and a lane its chip band", () => {
    // The strip is not a lane and has no interior: 14 px less two 4 px pads is
    // under `layerSliceRect`'s own floor, so asking it for a chip band there
    // answers a box that overflows the padding it was meant to respect.
    expect(dragGhostBand(DROP_STRIP_HEIGHT_PX, SPAWN_TRACK_ID)).toEqual({
      top: 0,
      height: DROP_STRIP_HEIGHT_PX,
    });
    expect(dragGhostBand(DEFAULT_TRACK_HEIGHT, "t-1")).toEqual(
      layerSliceRect(DEFAULT_TRACK_HEIGHT, "full"),
    );
  });

  it("labels every lane band and no strip band, with no height in between", () => {
    // The threshold is derived from `MIN_TRACK_HEIGHT`, so the split falls
    // exactly on lane-versus-strip: there is no row height at which the two
    // surfaces could disagree about whether a ghost carries text.
    const smallestLane = mountChip(dragGhostBand(MIN_TRACK_HEIGHT, "t-1"));
    expect(smallestLane.textContent).toContain("Beach");
    cleanup();

    const strip = mountChip(dragGhostBand(DROP_STRIP_HEIGHT_PX, SPAWN_TRACK_ID));
    // Bare — the row's own hint carries the message there, and 10 px type in a
    // 14 px box would only be clipped. The name survives on the tooltip.
    expect(strip.textContent).toBe("");
    expect(strip.title).toBe("Beach: 00:00:01:00 → 00:00:02:00");
  });

  it("wears the refusal a lane wears, and drops the badge with the label", () => {
    const lane = mountChip(
      dragGhostBand(DEFAULT_TRACK_HEIGHT, "t-1"),
      "collision",
    );
    expect(lane.textContent).toContain("Overlap");
    expect(lane.style.outline).toBe("2px solid rgb(248 113 113)");
    cleanup();

    // Same red, no room for the word. `data-validity` is what a test reads at
    // this height, and the row's chrome says it in full.
    const strip = mountChip(
      dragGhostBand(DROP_STRIP_HEIGHT_PX, SPAWN_TRACK_ID),
      "collision",
    );
    expect(strip.textContent).toBe("");
    expect(strip.dataset.validity).toBe("collision");
    expect(strip.style.outline).toBe("2px solid rgb(248 113 113)");
  });

  it("draws no refusal chrome for a spawn — a lane being created is not one", () => {
    const strip = mountChip(dragGhostBand(DROP_STRIP_HEIGHT_PX, SPAWN_TRACK_ID));
    expect(strip.style.outline).toBe("");
    // The head cap is the one border side that is always painted, so `borderColor`
    // is never blank; the other three are the class's `border-white/25`.
    expect(strip.style.borderRightColor).toBe("");
    expect(strip.style.borderLeftColor).toBe("rgba(255, 255, 255, 0.92)");
  });

  it("marks the head, at the landing itself and through a refusal", () => {
    // The head is the number a drop SENDS; every other edge is derived from it.
    // A uniformly bordered box says none of that, which is why the cap exists.
    const lane = mountChip(dragGhostBand(DEFAULT_TRACK_HEIGHT, "t-1"));
    expect(lane.style.borderLeftWidth).toBe(`${GHOST_HEAD_CAP_PX}px`);
    // `border-box`, so the cap grows inward and its OUTER edge is still the
    // landing time — 1 s at 80 px/s. A cap that pushed the box right would put
    // the marker two pixels after the frame it names.
    expect(lane.style.left).toBe("80px");
    cleanup();

    // The refusal repaints three sides and leaves the head alone. `borderColor`
    // is a shorthand, so it has to be assigned ABOVE the cap's longhands — below
    // them, this assertion is what fails.
    const refused = mountChip(
      dragGhostBand(DEFAULT_TRACK_HEIGHT, "t-1"),
      "collision",
    );
    expect(refused.style.borderLeftColor).toBe("rgba(255, 255, 255, 0.92)");
    expect(refused.style.borderTopColor).toBe("rgb(252, 165, 165)");
  });

  it("fades the FILL, never the element", () => {
    // `opacity` on the box would take 15 % off the head cap, the refusal outline
    // and the label too — every part of a ghost that has to read as a crisp line
    // over a dark lane. This is the assertion that a fix for "the edge is hard to
    // see" cannot be undone by reaching for `opacity` again.
    const lane = mountChip(dragGhostBand(DEFAULT_TRACK_HEIGHT, "t-1"));
    expect(lane.style.opacity).toBe("");
    expect(lane.style.backgroundColor).toContain("color-mix");
  });
});
