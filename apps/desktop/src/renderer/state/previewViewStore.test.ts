import { afterEach, describe, expect, it } from "vitest";
import { canStepPreviewZoom, resetPreviewView, stepPreviewZoom, usePreviewViewStore } from "./previewViewStore";

afterEach(resetPreviewView);

describe("preview view", () => {
  it("walks bounded zoom steps without wrapping and resets the panned view to Fit", () => {
    for (let i = 0; i < 20; i++) stepPreviewZoom(1);
    expect(usePreviewViewStore.getState().zoom).toBe(4);
    expect(canStepPreviewZoom(1)).toBe(false);
    usePreviewViewStore.setState({ pan: { x: 50, y: -20 } });
    resetPreviewView();
    expect(usePreviewViewStore.getState()).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
    for (let i = 0; i < 20; i++) stepPreviewZoom(-1);
    expect(usePreviewViewStore.getState().zoom).toBe(0.25);
    expect(canStepPreviewZoom(-1)).toBe(false);
  });

  it("keeps the inspected point at the centre on zoom and recentres at Fit", () => {
    usePreviewViewStore.setState({ zoom: 2, pan: { x: 80, y: -40 } });
    stepPreviewZoom(1);
    expect(usePreviewViewStore.getState()).toEqual({ zoom: 3, pan: { x: 120, y: -60 } });
    stepPreviewZoom(-1);
    stepPreviewZoom(-1);
    stepPreviewZoom(-1);
    expect(usePreviewViewStore.getState()).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
  });
});
