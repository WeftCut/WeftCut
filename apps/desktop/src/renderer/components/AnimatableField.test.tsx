// @vitest-environment jsdom
//
// The stopwatch itself, independent of the control it wraps. It is generic over
// the value the param carries, so the two things worth pinning are that the
// toggle is symmetric for BOTH value types — lifting takes the value that was on
// screen, collapsing freezes what the engine resolved at the playhead — and
// that the collapse goes through the caller's own engine, not a shared one.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack, Keyframe, Rgba } from "../ipc";
import { collapseToStatic, collapseToStaticRgba } from "../keyframe/edits";
import { AnimatableField, displayValue } from "./AnimatableField";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };

const key = <T,>(id: string, tUs: number, value: T): Keyframe<T> => ({
  id, t_us: tUs, value,
  in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
  continuity: "Broken", segment: { kind: "Linear" },
});

const keyed = <T,>(...values: [id: string, tUs: number, value: T][]): AnimTrack<T> => ({
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: values.map(([id, tUs, v]) => key(id, tUs, v)),
});

/// The field renders exactly one button — the stopwatch; the wrapped control
/// is whatever the caller passed as children.
const stopwatch = () => screen.getByRole("button") as HTMLButtonElement;

function renderColor(track: AnimTrack<Rgba>, tInLayerUs: number, playheadInSpan = true) {
  const commitTrack = vi.fn();
  render(
    <AnimatableField
      layerId="L1"
      paramKey="color"
      label="Color"
      track={track}
      fallback={RED}
      collapse={collapseToStaticRgba}
      tInLayerUs={tInLayerUs}
      playheadInSpan={playheadInSpan}
      onMutated={vi.fn().mockResolvedValue(undefined)}
      commitTrack={commitTrack}
    >
      <span data-testid="control" />
    </AnimatableField>,
  );
  return commitTrack;
}

describe("displayValue", () => {
  it("returns a Static track's value without consulting the engine", () => {
    const resolve = vi.fn();
    expect(displayValue({ mode: "Static", value: 0.25 }, 999, 1, resolve)).toBe(0.25);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("routes a keyframed track through the resolver it was given", () => {
    const track = keyed<number>(["a", 0, 0], ["b", 1_000_000, 1]);
    const resolve = vi.fn().mockReturnValue(0.42);
    expect(displayValue(track, 500_000, 0, resolve)).toBe(0.42);
    expect(resolve).toHaveBeenCalledWith(track, 500_000, 0);
  });
});

describe("the stopwatch on a colour param", () => {
  it("is lit for a keyframed track and unlit for a static one", () => {
    renderColor({ mode: "Static", value: RED }, 0);
    expect(stopwatch().getAttribute("aria-pressed")).toBe("false");
    cleanup();
    renderColor(keyed<Rgba>(["a", 0, RED]), 0);
    expect(stopwatch().getAttribute("aria-pressed")).toBe("true");
  });

  it("lifts a static colour to a one-key track holding that colour", async () => {
    const commitTrack = renderColor({ mode: "Static", value: GREEN }, 500_000);
    await userEvent.click(stopwatch());
    expect(commitTrack).toHaveBeenCalledTimes(1);
    const [paramKey, next] = commitTrack.mock.calls[0]!;
    expect(paramKey).toBe("color");
    expect(next.mode).toBe("Keyframed");
    expect(next.value).toEqual([expect.objectContaining({ t_us: 500_000, value: GREEN })]);
  });

  it("collapses a keyed colour to the colour the engine resolves at the playhead", async () => {
    const track = keyed<Rgba>(["a", 0, RED], ["b", 1_000_000, GREEN]);
    const commitTrack = renderColor(track, 500_000);
    await userEvent.click(stopwatch());
    const [, next] = commitTrack.mock.calls[0]!;
    // The OkLab midpoint, not either endpoint and not the sRGB average: the
    // frozen colour has to be the one that was on screen.
    expect(next).toEqual(collapseToStaticRgba(track, 500_000, RED));
    expect(next.mode).toBe("Static");
    expect(next.value.r).toBeGreaterThan(190);
    expect(next.value.g).toBeGreaterThan(150);
  });

  it("cannot start animating off the clip, but can still turn animation off", () => {
    renderColor({ mode: "Static", value: RED }, -1, false);
    expect(stopwatch().disabled).toBe(true);
    cleanup();
    renderColor(keyed<Rgba>(["a", 0, RED]), -1, false);
    expect(stopwatch().disabled).toBe(false);
  });
});

describe("the stopwatch on a numeric param", () => {
  it("collapses through the scalar engine, so the two value kinds share one toggle", async () => {
    const track = keyed<number>(["a", 0, 0], ["b", 1_000_000, 1]);
    const commitTrack = vi.fn();
    render(
      <AnimatableField
        layerId="L1"
        paramKey="opacity"
        label="Opacity"
        track={track}
        fallback={1}
        collapse={collapseToStatic}
        tInLayerUs={500_000}
        playheadInSpan
        onMutated={vi.fn().mockResolvedValue(undefined)}
        commitTrack={commitTrack}
      >
        <span data-testid="control" />
      </AnimatableField>,
    );
    await userEvent.click(stopwatch());
    const [, next] = commitTrack.mock.calls[0]!;
    expect(next.mode).toBe("Static");
    expect(next.value).toBeCloseTo(0.5, 6);
  });
});
