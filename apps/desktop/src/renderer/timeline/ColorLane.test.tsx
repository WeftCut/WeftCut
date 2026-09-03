// @vitest-environment jsdom
//
// The gradient strip's sampling, its layout, and what it paints. The sampling
// is a pure function so the x → time → colour mapping can be pinned without a
// canvas; the painting is checked through a stubbed 2d context (jsdom has none
// of its own), which is what makes "an armed gesture's preview wins over the
// committed track" observable rather than inferred.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AnimTrack, Keyframe, Rgba } from "../ipc";
import { clearTrackPreview, setTrackPreview } from "../keyframe/easingPreviewStore";
import {
  ColorLane,
  cssRgba,
  sampleStripColors,
  stripColumnCount,
  stripColumnTimeUs,
  type StripGeom,
} from "./ColorLane";

afterEach(() => {
  cleanup();
  clearTrackPreview();
});

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

const key = (id: string, tUs: number, value: Rgba): Keyframe<Rgba> => ({
  id, t_us: tUs, value,
  in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
  continuity: "Broken", segment: { kind: "Linear" },
});

type Keyed = Extract<AnimTrack<Rgba>, { mode: "Keyframed" }>;

/// Red → green across exactly one second.
const redToGreen: Keyed = {
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: [key("a", 0, RED), key("b", 1_000_000, GREEN)],
};

/// 100 px of strip covering that one second, one sample per CSS pixel.
const geom = (over: Partial<StripGeom> = {}): StripGeom =>
  ({ segmentStartPx: 0, segmentWidthPx: 100, pxPerSec: 100, dpr: 1, ...over });

describe("stripColumnTimeUs", () => {
  it("maps a column to the CENTRE of the time it covers", () => {
    // 100 px/s, dpr 1: column 0 covers [0, 10 ms) and reads 5 ms.
    expect(stripColumnTimeUs(0, geom())).toBeCloseTo(5_000, 6);
    expect(stripColumnTimeUs(49, geom())).toBeCloseTo(495_000, 6);
  });

  it("counts one sample per DEVICE column, so a 2x display samples twice as finely", () => {
    expect(stripColumnCount(geom({ dpr: 2 }))).toBe(200);
    expect(stripColumnTimeUs(0, geom({ dpr: 2 }))).toBeCloseTo(2_500, 6);
  });

  it("offsets by the segment's own left edge, so a later tile reads later time", () => {
    expect(stripColumnTimeUs(0, geom({ segmentStartPx: 100 }))).toBeCloseTo(1_005_000, 6);
  });

  it("a zoom change moves the same column to a different time", () => {
    expect(stripColumnTimeUs(10, geom({ pxPerSec: 50 }))).toBeCloseTo(210_000, 6);
  });

  it("never asks for fewer than one column, however narrow the segment", () => {
    expect(stripColumnCount(geom({ segmentWidthPx: 0.2, dpr: 1 }))).toBe(1);
  });
});

describe("sampleStripColors", () => {
  it("returns one colour per device column, running the track end to end", () => {
    const cols = sampleStripColors(redToGreen, RED, geom());
    expect(cols).toHaveLength(100);
    expect(cols[0]!.r).toBeGreaterThan(240);
    expect(cols[0]!.g).toBeLessThan(30);
    expect(cols[99]!.g).toBeGreaterThan(240);
    expect(cols[99]!.r).toBeLessThan(30);
  });

  it("mixes in OkLab, so the midpoint is not the channel-wise average", () => {
    const mid = sampleStripColors(redToGreen, RED, geom())[50]!;
    // The sRGB average would be (128, 128, 0).
    expect(mid.r).toBeGreaterThan(190);
    expect(mid.g).toBeGreaterThan(150);
    expect(mid.b).toBe(0);
  });

  it("clamps past the last key, so a strip wider than the keys holds the end colour", () => {
    const cols = sampleStripColors(redToGreen, RED, geom({ segmentWidthPx: 200 }));
    expect(cols).toHaveLength(200);
    expect(cols[199]).toEqual(GREEN);
  });

  it("a Hold segment steps rather than ramps", () => {
    const held: Keyed = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [{ ...key("a", 0, RED), segment: { kind: "Hold" } }, key("b", 1_000_000, GREEN)],
    };
    const cols = sampleStripColors(held, RED, geom());
    expect(cols[0]).toEqual(RED);
    expect(cols[98]).toEqual(RED);
  });
});

describe("cssRgba", () => {
  it("carries alpha through as a CSS alpha rather than compositing it away", () => {
    expect(cssRgba({ r: 1, g: 2, b: 3, a: 255 })).toBe("rgba(1, 2, 3, 1)");
    expect(cssRgba({ r: 0, g: 0, b: 0, a: 0 })).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("ColorLane layout and painting", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let fills: string[];

  beforeEach(() => {
    fills = [];
    const fake = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      set fillStyle(v: string) { fills.push(v); },
      get fillStyle() { return fills[fills.length - 1] ?? ""; },
    };
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = ((id: string) =>
      id === "2d" ? fake : null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  const renderLane = (over: Partial<Parameters<typeof ColorLane>[0]> = {}) =>
    render(
      <ColorLane
        track={redToGreen}
        layerId="L1"
        paramKey="color"
        fallback={RED}
        layerTStartUs={2_000_000}
        clipDurationUs={1_000_000}
        pxPerSec={100}
        height={24}
        {...over}
      />,
    );

  it("places the strip at the clip's own start and width, in ruler px", () => {
    renderLane();
    const lane = screen.getByTestId("kf-color-lane");
    expect(lane.style.left).toBe("200px");
    expect(lane.style.width).toBe("100px");
  });

  it("tiles a wide strip into several canvases instead of one enormous element", () => {
    renderLane({ clipDurationUs: 60_000_000 });
    // 60 s at 100 px/s is 6000 px — three 2048 px tiles.
    expect(screen.getAllByTestId("kf-color-strip")).toHaveLength(3);
  });

  it("takes no pointer events, so the row keeps its marquee and its diamonds", () => {
    renderLane();
    expect(screen.getByTestId("kf-color-lane").className).toContain("pointer-events-none");
  });

  it("paints one column per device pixel, left to right along the track", () => {
    renderLane();
    const want = sampleStripColors(redToGreen, RED, geom());
    expect(fills).toHaveLength(100);
    expect(fills).toEqual(want.map(cssRgba));
    // Column 99 samples the centre of the last pixel, 5 ms short of the second
    // key, so it is nearly green rather than exactly green.
    expect(want[99]!.g).toBeGreaterThan(240);
    expect(want[99]!.r).toBeLessThan(30);
  });

  it("draws an armed gesture's colour preview in place of the committed track", () => {
    const previewed: Keyed = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [key("a", 0, BLUE), key("b", 1_000_000, GREEN)],
    };
    setTrackPreview("L1", "color", previewed);
    renderLane();
    expect(fills[0]).toBe(cssRgba(sampleStripColors(previewed, RED, geom())[0]!));
    expect(fills[0]).not.toBe(cssRgba(sampleStripColors(redToGreen, RED, geom())[0]!));
  });

  it("ignores a NUMBER preview parked at the same address — a strip cannot draw one", () => {
    const numeric: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [
        { ...key("a", 0, RED), value: 0 } as unknown as Keyframe<number>,
        { ...key("b", 1_000_000, GREEN), value: 1 } as unknown as Keyframe<number>,
      ],
    };
    setTrackPreview("L1", "color", numeric);
    renderLane();
    // The committed colour track is what got painted.
    expect(fills).toEqual(sampleStripColors(redToGreen, RED, geom()).map(cssRgba));
  });
});
