import { describe, it, expect } from "vitest";
import type { AnimTrack, Keyframe, Rgba } from "../ipc";
import { autoKeyTrack, resolveParamTrack } from "./autoKey";

/// A Linear key with identity sides — the shape every fixture below starts from.
const key = <T,>(id: string, tUs: number, value: T): Keyframe<T> => ({
  id, t_us: tUs, value,
  in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
  continuity: "Broken", segment: { kind: "Linear" },
});

describe("autoKeyTrack", () => {
  it("upserts a new key at tInLayerUs on a Keyframed track", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [{ id: "a", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
    };
    const next = autoKeyTrack(track, 500_000, 0.5);
    expect(next.mode).toBe("Keyframed");
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value.some((k) => k.t_us === 500_000 && k.value === 0.5)).toBe(true);
    expect(next.value).toHaveLength(2);
  });

  it("updates the value of an existing key at the same time in place", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [{ id: "a", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
    };
    const next = autoKeyTrack(track, 0, 0.9);
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value).toHaveLength(1);
    expect(next.value[0]).toMatchObject({ id: "a", t_us: 0, value: 0.9 });
  });

  it("writes a Static value when the track is Static", () => {
    const track: AnimTrack<number> = { mode: "Static", value: 1 };
    const next = autoKeyTrack(track, 123, 0.25);
    expect(next).toEqual({ mode: "Static", value: 0.25 });
  });

  it("applies the same rule to a colour track, keying an Rgba at the playhead", () => {
    const red: Rgba = { r: 255, g: 0, b: 0, a: 255 };
    const green: Rgba = { r: 0, g: 255, b: 0, a: 255 };
    const track: AnimTrack<Rgba> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [key("a", 0, red)],
    };
    const next = autoKeyTrack(track, 500_000, green);
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value.map((k) => k.value)).toEqual([red, green]);
    expect(autoKeyTrack({ mode: "Static", value: red } as AnimTrack<Rgba>, 0, green))
      .toEqual({ mode: "Static", value: green });
  });
});

describe("resolveParamTrack", () => {
  const red: Rgba = { r: 255, g: 0, b: 0, a: 255 };
  const green: Rgba = { r: 0, g: 255, b: 0, a: 255 };

  it("reads a number track through the scalar engine", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [key("a", 0, 0), key("b", 1_000_000, 1)],
    };
    expect(resolveParamTrack(track, 500_000, 0)).toBeCloseTo(0.5, 6);
  });

  it("reads a colour track through the OkLab leaf, not a channel-wise average", () => {
    const track: AnimTrack<Rgba> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [key("a", 0, red), key("b", 1_000_000, green)],
    };
    const mid = resolveParamTrack(track, 500_000, red) as Rgba;
    // The sRGB average of red and green is (128, 128, 0); the OkLab mix the
    // engine returns is markedly lighter and warmer than that.
    expect(mid.r).toBeGreaterThan(190);
    expect(mid.g).toBeGreaterThan(150);
    expect(mid.b).toBe(0);
  });

  it("the fallback decides which engine reads the track, so a Static value passes straight through", () => {
    expect(resolveParamTrack({ mode: "Static", value: green } as AnimTrack<Rgba>, 0, red)).toEqual(green);
    expect(resolveParamTrack({ mode: "Static", value: 0.25 } as AnimTrack<number>, 0, 1)).toBe(0.25);
  });
});
