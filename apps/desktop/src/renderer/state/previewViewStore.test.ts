import { afterEach, describe, expect, it } from "vitest";
import {
  canStepPreviewZoom,
  clampPreviewPan,
  panAfterZoom,
  previewScale,
  resetPreviewView,
  setPreviewFit,
  setPreviewView,
  setPreviewZoom,
  stepPreviewZoom,
  usePreviewViewStore,
} from "./previewViewStore";

afterEach(() => usePreviewViewStore.setState({ zoom: "fit", pan: { x: 0, y: 0 }, fit: 1 }));

describe("preview view", () => {
  it("keeps Fit a mode, so a resized panel moves the scale and not the view", () => {
    expect(previewScale()).toBe(1);
    setPreviewFit(0.762);
    expect(usePreviewViewStore.getState().zoom).toBe("fit");
    expect(previewScale()).toBeCloseTo(0.762);
    // The same view, a narrower panel: Fit re-fits where a number captured at
    // fit time would have frozen.
    setPreviewFit(0.5);
    expect(previewScale()).toBe(0.5);
    setPreviewFit(0);
    expect(previewScale()).toBe(0.5);
  });

  it("steps onto the rungs either side of wherever Fit currently sits", () => {
    setPreviewFit(0.762);
    stepPreviewZoom(1);
    expect(usePreviewViewStore.getState().zoom).toBe(1);
    resetPreviewView();
    stepPreviewZoom(-1);
    expect(usePreviewViewStore.getState().zoom).toBe(0.75);
  });

  it("steps OFF a rung it is already standing on", () => {
    setPreviewView(1, { x: 0, y: 0 });
    stepPreviewZoom(1);
    expect(usePreviewViewStore.getState().zoom).toBe(1.5);
    stepPreviewZoom(-1);
    expect(usePreviewViewStore.getState().zoom).toBe(1);
  });

  it("walks bounded steps without wrapping", () => {
    setPreviewView(4, { x: 0, y: 0 });
    expect(canStepPreviewZoom(1)).toBe(false);
    stepPreviewZoom(1);
    expect(usePreviewViewStore.getState().zoom).toBe(4);
    setPreviewView(0.25, { x: 0, y: 0 });
    expect(canStepPreviewZoom(-1)).toBe(false);
    stepPreviewZoom(-1);
    expect(usePreviewViewStore.getState().zoom).toBe(0.25);
  });

  it("keeps the inspected point at the centre on a step, and recentres at Fit", () => {
    setPreviewView(2, { x: 80, y: -40 });
    stepPreviewZoom(1);
    expect(usePreviewViewStore.getState()).toMatchObject({
      zoom: 3,
      pan: { x: 120, y: -60 },
    });
    setPreviewZoom("fit");
    expect(usePreviewViewStore.getState()).toMatchObject({
      zoom: "fit",
      pan: { x: 0, y: 0 },
    });
  });

  // The wheel's whole point: what is under the pointer stays under it. A point
  // 100 px right of centre doubles to 200 px out on its own; anchoring there
  // pays that back exactly.
  it("holds the anchored point still across a scale change, both ways", () => {
    const zoomedIn = panAfterZoom({ x: 0, y: 0 }, 1, 2, { x: 100, y: 50 });
    expect(zoomedIn).toEqual({ x: -100, y: -50 });
    expect(panAfterZoom(zoomedIn, 2, 1, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
    // Anchoring on the centre is the same expression with a zero anchor, which
    // is what a keyboard/command step has to use — it has no pointer.
    expect(panAfterZoom({ x: 80, y: -40 }, 2, 3, { x: 0, y: 0 })).toEqual({ x: 120, y: -60 });
  });

  it("bounds the pan at the picture's edges and pins an axis that fits", () => {
    expect(clampPreviewPan(9999, 1920, 960)).toBe(480);
    expect(clampPreviewPan(-9999, 1920, 960)).toBe(-480);
    expect(clampPreviewPan(40, 1920, 960)).toBe(40);
    expect(clampPreviewPan(40, 500, 960)).toBe(0);
  });
});
