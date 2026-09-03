import { describe, expect, it } from "vitest";
import type { AnimTrack } from "../ipc";
import { fanOutEntries, twinTrackCopy } from "./fanOut";

type Keyframed = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

// A Spline a→b with hand-set tangents, a Smooth key and a non-Hold extrapolation:
// every field the twin copy has to carry.
const kfTrack: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 0.3, y: 0, mode: "Free" }, continuity: "Broken", segment: { kind: "Spline" } },
    { id: "b", t_us: 1_000_000, value: 2, in: { x: 0.7, y: 1, mode: "Auto" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Smooth", segment: { kind: "Elastic", dir: "Out", amplitude: 1.5, period: 0.45 } },
  ],
  extrapolate: { before: "Loop", after: "PingPong" },
};

describe("twinTrackCopy", () => {
  it("copies (t_us, value, in, out, continuity, segment) and extrapolate exactly but mints fresh ids", () => {
    const copy = twinTrackCopy(kfTrack);
    expect(copy.mode).toBe("Keyframed");
    const src = (kfTrack as Keyframed).value;
    const dst = (copy as Keyframed).value;
    const shape = (k: Keyframed["value"][number]) => [k.t_us, k.value, k.in, k.out, k.continuity, k.segment];
    expect(dst.map(shape)).toEqual(src.map(shape));
    expect((copy as Keyframed).extrapolate).toEqual({ before: "Loop", after: "PingPong" });
    expect(dst.map((k) => k.id)).not.toContain("a");
    expect(dst.map((k) => k.id)).not.toContain("b");
  });
  it("shares no mutable state with the source (tangents, segment and extrapolation are re-created)", () => {
    const copy = twinTrackCopy(kfTrack) as Keyframed;
    const src = (kfTrack as Keyframed).value;
    expect(copy.value[0]!.out).not.toBe(src[0]!.out);
    expect(copy.value[1]!.in).not.toBe(src[1]!.in);
    expect(copy.value[1]!.segment).not.toBe(src[1]!.segment);
    expect(copy.extrapolate).not.toBe((kfTrack as Keyframed).extrapolate);
  });
  it("Static passes through as a fresh Static", () => {
    const s: AnimTrack<number> = { mode: "Static", value: 2 };
    const copy = twinTrackCopy(s);
    expect(copy).toEqual(s);
    expect(copy).not.toBe(s);
  });
});

describe("fanOutEntries", () => {
  it("authored track under the first key, twins under the rest", () => {
    const entries = fanOutEntries(["scale_x", "scale_y"], kfTrack);
    expect(entries.map(([k]) => k)).toEqual(["scale_x", "scale_y"]);
    expect(entries[0]![1]).toBe(kfTrack); // authored ids preserved for the read side
    const twin = entries[1]![1] as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    expect(twin.value.map((k) => [k.t_us, k.value])).toEqual([[0, 1], [1_000_000, 2]]);
    expect(twin.value.map((k) => k.id)).not.toContain("a");
  });
});
