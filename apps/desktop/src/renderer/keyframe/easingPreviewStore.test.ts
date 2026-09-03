import { afterEach, describe, expect, it } from "vitest";
import type { AnimTrack, Rgba } from "../ipc";
import {
  clearTrackPreview,
  getTrackPreview,
  isNumberTrack,
  previewKey,
  setTrackPreview,
  setTrackPreviews,
  useTrackPreviewStore,
} from "./easingPreviewStore";

afterEach(() => clearTrackPreview());

const num: AnimTrack<number> = {
  mode: "Keyframed",
  extrapolate: { before: "Hold", after: "Hold" },
  value: [{ id: "a", t_us: 0, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
};
const red: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const colour: AnimTrack<Rgba> = {
  mode: "Keyframed",
  extrapolate: { before: "Hold", after: "Hold" },
  value: [{ id: "c", t_us: 0, value: red, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
};

describe("track preview store", () => {
  it("stores a preview under (layerId, paramKey) and hands back the same reference", () => {
    setTrackPreview("L1", "opacity", num);
    expect(getTrackPreview("L1", "opacity")).toBe(num);
    expect(getTrackPreview("L1", "x")).toBeNull();
    expect(getTrackPreview("L2", "opacity")).toBeNull();
  });

  it("the key uses the selection store's separator, so a layer and a param never run together", () => {
    expect(previewKey("L1", "opacity")).toBe("L1|opacity");
  });

  it("a batch write lands every group in ONE store update", () => {
    let notified = 0;
    const unsub = useTrackPreviewStore.subscribe(() => notified++);
    setTrackPreviews([["L1", "opacity", num], ["L2", "opacity", num], ["L1", "x", colour]]);
    unsub();
    expect(notified).toBe(1);
    expect(getTrackPreview("L2", "opacity")).toBe(num);
    expect(getTrackPreview("L1", "x")).toBe(colour);
  });

  it("an empty batch writes nothing", () => {
    const before = useTrackPreviewStore.getState().previews;
    setTrackPreviews([]);
    expect(useTrackPreviewStore.getState().previews).toBe(before);
  });

  it("clears by exact address without touching a neighbour's preview", () => {
    setTrackPreviews([["L1", "opacity", num], ["L1", "x", num], ["L2", "opacity", num]]);
    clearTrackPreview("L1", "opacity");
    expect(getTrackPreview("L1", "opacity")).toBeNull();
    expect(getTrackPreview("L1", "x")).toBe(num);
    expect(getTrackPreview("L2", "opacity")).toBe(num);
  });

  it("clears a whole layer by layerId alone, and everything with no arguments", () => {
    setTrackPreviews([["L1", "opacity", num], ["L1", "x", num], ["L2", "opacity", num]]);
    clearTrackPreview("L1");
    expect(getTrackPreview("L1", "opacity")).toBeNull();
    expect(getTrackPreview("L1", "x")).toBeNull();
    expect(getTrackPreview("L2", "opacity")).toBe(num);
    clearTrackPreview();
    expect(getTrackPreview("L2", "opacity")).toBeNull();
  });

  it("clearing what is not there writes nothing, so idle surfaces are not re-rendered", () => {
    setTrackPreview("L1", "opacity", num);
    const before = useTrackPreviewStore.getState().previews;
    clearTrackPreview("L9", "opacity");
    expect(useTrackPreviewStore.getState().previews).toBe(before);
    clearTrackPreview();
    const empty = useTrackPreviewStore.getState().previews;
    clearTrackPreview();
    expect(useTrackPreviewStore.getState().previews).toBe(empty);
  });

  it("a later write for the same address replaces the earlier one", () => {
    setTrackPreview("L1", "opacity", num);
    setTrackPreview("L1", "opacity", colour);
    expect(getTrackPreview("L1", "opacity")).toBe(colour);
  });
});

describe("isNumberTrack", () => {
  it("tells a number track from a colour track by its values, Static or Keyframed", () => {
    expect(isNumberTrack(num)).toBe(true);
    expect(isNumberTrack(colour)).toBe(false);
    expect(isNumberTrack({ mode: "Static", value: 3 })).toBe(true);
    expect(isNumberTrack({ mode: "Static", value: red })).toBe(false);
  });
  it("reads an empty keyframed track as a number track (nothing contradicts it)", () => {
    expect(isNumberTrack({ mode: "Keyframed", value: [], extrapolate: { before: "Hold", after: "Hold" } })).toBe(true);
  });
});
