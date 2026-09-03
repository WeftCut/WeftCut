// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, fireEvent, screen } from "@testing-library/react";
import "../i18n"; // initialize i18next so the procedural badge label resolves
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import { applySegmentEasing } from "../../shared/easing";
import { clearTrackPreview, setTrackPreview } from "../keyframe/easingPreviewStore";
import {
  clearKeyframeSelection,
  getSelectedKeyframes,
  setKeyframeSelection,
} from "../keyframe/selectionStore";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";

// jsdom 25 does not implement PointerEvent; polyfill it so fireEvent.pointerDown
// creates a MouseEvent-compatible object with a usable .button property.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

afterEach(() => {
  cleanup();
  clearTrackPreview();
  clearKeyframeSelection();
});

type Keyframed = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

const baseKeys: Keyframe<number>[] = [
  { id: "k0", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
  { id: "k1", t_us: 1_000_000, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
];

/// Same two keys with the k0 → k1 segment carrying `interp` — written the way a
/// commit writes it (class + leaving side on k0, arriving side on k1).
function trackWith(interp: Interpolation): Keyframed {
  const [k0, k1] = applySegmentEasing(baseKeys[0]!, baseKeys[1], interp);
  return { mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [k0, k1!] };
}

// The default track: a CSS ease-in-out Spline from k0 to k1.
const track = trackWith({ kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] });

function renderGraph(over: Partial<React.ComponentProps<typeof KeyframeCurveGraph>> = {}) {
  return render(
    <KeyframeCurveGraph
      track={track}
      layerId="L1"
      paramKey="opacity"
      layerTStartUs={0}
      clipDurationUs={1_000_000}
      pxPerSec={100}
      height={72}
      editable={true}
      isSelected={() => false}
      onFocusSeek={vi.fn()}
      onSetTangent={vi.fn()}
      onSetContinuity={vi.fn()}
      onOpenMenu={vi.fn()}
      {...over}
    />,
  );
}

const handles = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="kf-handle"]')];

describe("KeyframeCurveGraph", () => {
  it("renders one dot per keyframe with the e2e contract class + data-kf-id", () => {
    const { container } = renderGraph();
    const dots = container.querySelectorAll(".kf-sublane-diamond");
    expect(dots.length).toBe(2);
    expect(dots[0]!.getAttribute("data-kf-id")).toBe("k0");
  });
  it("renders a curve polyline", () => {
    const { container } = renderGraph();
    expect(container.querySelectorAll("polyline").length).toBeGreaterThanOrEqual(1);
  });
  it("shows tangent handles only when editable", () => {
    expect(handles(renderGraph({ editable: true }).container).length).toBeGreaterThan(0);
    cleanup();
    expect(handles(renderGraph({ editable: false }).container).length).toBe(0);
  });
  it("right-click on a dot opens the menu", () => {
    const onOpenMenu = vi.fn();
    const { container } = renderGraph({ onOpenMenu });
    fireEvent.contextMenu(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!, { clientX: 42, clientY: 17 });
    expect(onOpenMenu).toHaveBeenCalledWith(42, 17, "k0");
  });
  it("leaves a dot that is already selected alone, so the menu keeps the whole selection", () => {
    const onFocusSeek = vi.fn();
    const onOpenMenu = vi.fn();
    const { container } = renderGraph({ onFocusSeek, onOpenMenu, isSelected: () => true });
    fireEvent.contextMenu(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!, { clientX: 42, clientY: 17 });
    expect(onOpenMenu).toHaveBeenCalledWith(42, 17, "k0");
    // Re-running the click path would narrow the selection to this one key and
    // seek away from what the menu is about to edit.
    expect(onFocusSeek).not.toHaveBeenCalled();
  });
  it("pressing a dot selects it, then focuses and seeks to it", () => {
    const onFocusSeek = vi.fn();
    const { container } = renderGraph({ onFocusSeek });
    fireEvent.pointerDown(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!, { button: 0 });
    expect(onFocusSeek).toHaveBeenCalledWith("k0");
    // The selection is the DRAG's business now, not the callback's: pressing an
    // unselected key replaces the selection with it, and pressing one already in
    // a swept group leaves the group standing.
    expect(getSelectedKeyframes()).toEqual([
      { layerId: "L1", paramKey: "opacity", kfId: "k0" },
    ]);
  });
  it("keeps a swept group when the press lands on a key already in it", () => {
    const { container } = renderGraph({ isSelected: () => true });
    setKeyframeSelection([
      { layerId: "L1", paramKey: "opacity", kfId: "k0" },
      { layerId: "L1", paramKey: "opacity", kfId: "k1" },
    ]);
    fireEvent.pointerDown(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!, { button: 0 });
    expect(getSelectedKeyframes().map((k) => k.kfId)).toEqual(["k0", "k1"]);
  });
  it("marks every selected keyframe", () => {
    const { container } = renderGraph({ isSelected: (id) => id === "k1" });
    expect(container.querySelector('.kf-sublane-diamond[data-kf-id="k1"]')!.className)
      .toContain("is-selected");
    expect(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!.className)
      .not.toContain("is-selected");
    cleanup();
    const both = renderGraph({ isSelected: () => true }).container;
    expect(both.querySelectorAll(".kf-sublane-diamond.is-selected").length).toBe(2);
  });
  it("right-click on a segment opens the menu for that segment's owner keyframe", () => {
    const onOpenMenu = vi.fn();
    const { container } = renderGraph({ onOpenMenu });
    const hit = container.querySelector('[data-testid="kf-segment-hit"]')!;
    fireEvent.contextMenu(hit, { clientX: 5, clientY: 6 });
    // the test track has keys k0 (owns the only segment) -> k1
    expect(onOpenMenu).toHaveBeenCalledWith(5, 6, "k0");
  });
});

describe("KeyframeCurveGraph — tangent handles", () => {
  it("a Spline segment shows the left key's out handle and the right key's in handle", () => {
    const { container } = renderGraph();
    const hs = handles(container);
    expect(hs.map((h) => [h.getAttribute("data-kf-id"), h.getAttribute("data-side")]))
      .toEqual([["k0", "out"], ["k1", "in"]]);
  });

  it("commits a handle drag as ONE deferred onSetTangent naming the key and side (one undo step)", () => {
    const onSetTangent = vi.fn();
    const { container } = renderGraph({ onSetTangent });
    const [outHandle] = handles(container);
    fireEvent.pointerDown(outHandle!, { button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 35 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 25 });
    // No commit mid-drag.
    expect(onSetTangent).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onSetTangent).toHaveBeenCalledTimes(1);
    const [kfId, side, xy] = onSetTangent.mock.calls[0]! as [string, string, { x: number; y: number }];
    expect(kfId).toBe("k0");
    expect(side).toBe("out");
    expect(Number.isFinite(xy.x) && Number.isFinite(xy.y)).toBe(true);
    expect(xy.x).toBeGreaterThanOrEqual(0);
    expect(xy.x).toBeLessThanOrEqual(1);
  });

  it("dragging the right-hand handle writes the RIGHT key's in side", () => {
    const onSetTangent = vi.fn();
    const { container } = renderGraph({ onSetTangent });
    const [, inHandle] = handles(container);
    fireEvent.pointerDown(inHandle!, { button: 0, clientX: 70, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 30 });
    fireEvent.pointerUp(window);
    expect(onSetTangent).toHaveBeenCalledTimes(1);
    expect(onSetTangent.mock.calls[0]![0]).toBe("k1");
    expect(onSetTangent.mock.calls[0]![1]).toBe("in");
  });

  it("previews the dragged side live from setTangent before any commit", () => {
    // An Auto key: the grab converts it to Free on screen while the pointer is
    // still down, and nothing has reached the caller yet.
    const auto: Keyframed = {
      ...track,
      value: [
        { ...track.value[0]!, out: { ...track.value[0]!.out, mode: "Auto" } },
        track.value[1]!,
      ],
    };
    const onSetTangent = vi.fn();
    const { container } = renderGraph({ track: auto, onSetTangent });
    expect(handles(container)[0]!.getAttribute("class")).toContain("kf-handle-auto");
    fireEvent.pointerDown(handles(container)[0]!, { button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 35 });
    expect(handles(container)[0]!.getAttribute("data-mode")).toBe("Free");
    expect(handles(container)[0]!.getAttribute("class")).not.toContain("kf-handle-auto");
    expect(onSetTangent).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
  });

  it("greys an Auto side and leaves a Free side accented", () => {
    const auto: Keyframed = {
      ...track,
      value: [
        track.value[0]!,
        { ...track.value[1]!, in: { ...track.value[1]!.in, mode: "Auto" } },
      ],
    };
    const { container } = renderGraph({ track: auto });
    const [outHandle, inHandle] = handles(container);
    expect(outHandle!.getAttribute("class")).not.toContain("kf-handle-auto");
    expect(inHandle!.getAttribute("class")).toContain("kf-handle-auto");
    expect(inHandle!.getAttribute("data-mode")).toBe("Auto");
  });

  it("a key's stems read its continuity: Smooth as one through-line, Broken as two stems", () => {
    const smooth: Keyframed = {
      ...track,
      value: [{ ...track.value[0]!, continuity: "Smooth" }, track.value[1]!],
    };
    const { container } = renderGraph({ track: smooth });
    const stems = [...container.querySelectorAll(".kf-handle-stem")];
    expect(stems[0]!.getAttribute("class")).toContain("kf-handle-stem-smooth");
    expect(stems[1]!.getAttribute("class")).toContain("kf-handle-stem-broken");
  });

  it("right-click on a handle offers Smooth / Broken for that key and commits the pick", () => {
    const onSetContinuity = vi.fn();
    const { container } = renderGraph({ onSetContinuity });
    const [, inHandle] = handles(container);
    fireEvent.contextMenu(inHandle!, { clientX: 70, clientY: 20 });
    expect(screen.getByTestId("kf-continuity-menu")).toBeTruthy();
    // k1 is Broken: that row carries the check.
    expect(screen.getByTestId("kf-continuity-broken").querySelector(".app-menu-item-check svg")).not.toBeNull();
    expect(screen.getByTestId("kf-continuity-smooth").querySelector(".app-menu-item-check svg")).toBeNull();
    fireEvent.click(screen.getByTestId("kf-continuity-smooth"));
    expect(onSetContinuity).toHaveBeenCalledWith("k1", "Smooth");
    expect(screen.queryByTestId("kf-continuity-menu")).toBeNull();
  });
});

const ELASTIC: Interpolation = { kind: "Elastic", dir: "Out", amplitude: 1, period: 0.3 };
const BOUNCE: Interpolation = { kind: "Bounce", dir: "InOut" };

/// The visible curve strokes (each segment renders a transparent hit polyline
/// first, then the painted one).
function strokes(container: HTMLElement): string[] {
  return [...container.querySelectorAll("polyline")]
    .map((p) => p.getAttribute("stroke")!)
    .filter((s) => s !== "transparent");
}

describe("KeyframeCurveGraph — procedural segment class (Elastic/Bounce)", () => {
  it("shows no tangent handles on a procedural segment even when editable", () => {
    for (const interp of [ELASTIC, BOUNCE]) {
      const { container } = renderGraph({ track: trackWith(interp), editable: true });
      expect(handles(container).length).toBe(0);
      cleanup();
    }
  });
  it("tints a procedural curve with the --keyframe token; spline keeps --ring", () => {
    expect(strokes(renderGraph({ track: trackWith(ELASTIC) }).container))
      .toEqual(["var(--keyframe, #facc15)"]);
    cleanup();
    expect(strokes(renderGraph().container)).toEqual(["var(--ring, #9a9aff)"]);
  });
  it("badges a procedural segment in the expanded editor only", () => {
    const { container } = renderGraph({ track: trackWith(BOUNCE), editable: true });
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(1);
    cleanup();
    const collapsed = renderGraph({ track: trackWith(BOUNCE), editable: false });
    expect(collapsed.container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
  });
  it("never badges a spline (Bezier) segment", () => {
    const { container } = renderGraph({ editable: true });
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
  });
  it("redraws live from the preview stored under its own (layerId, paramKey)", () => {
    // Committed Linear; a menu row's preview swaps in an Elastic — the segment
    // must re-render as procedural without any commit.
    const { container } = renderGraph({ track: trackWith({ kind: "Linear" }), editable: true });
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
    act(() => setTrackPreview("L1", "opacity", trackWith(ELASTIC)));
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(1);
    expect(strokes(container)).toEqual(["var(--keyframe, #facc15)"]);
  });
  it("ignores a preview stored under another layer or param", () => {
    const { container } = renderGraph({ track: trackWith({ kind: "Linear" }), editable: true });
    act(() => setTrackPreview("L1", "x", trackWith(ELASTIC)));
    act(() => setTrackPreview("L2", "opacity", trackWith(ELASTIC)));
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
  });
});

describe("KeyframeCurveGraph — interp glyph coding on dots", () => {
  const dotClass = (container: HTMLElement, id: string) =>
    container.querySelector(`.kf-sublane-diamond[data-kf-id="${id}"]`)!.className;

  it("an eased keyframe renders as a circle (kf-interp-eased)", () => {
    // The default track's k0 leaves on a Spline — eased glyph; k1 is Linear — bare diamond.
    const { container } = renderGraph();
    expect(dotClass(container, "k0")).toContain("kf-interp-eased");
    expect(dotClass(container, "k1")).not.toContain("kf-interp-eased");
    expect(dotClass(container, "k1")).not.toContain("kf-interp-hold");
  });
  it("a Hold keyframe renders as a square (kf-interp-hold)", () => {
    const { container } = renderGraph({ track: trackWith({ kind: "Hold" }) });
    expect(dotClass(container, "k0")).toContain("kf-interp-hold");
  });
  it("procedural kinds carry the eased glyph too", () => {
    for (const interp of [ELASTIC, BOUNCE]) {
      const { container } = renderGraph({ track: trackWith(interp) });
      expect(dotClass(container, "k0")).toContain("kf-interp-eased");
      cleanup();
    }
  });
  it("the dots follow a previewed track's glyphs", () => {
    const { container } = renderGraph({ track: trackWith({ kind: "Linear" }) });
    expect(dotClass(container, "k0")).not.toContain("kf-interp-hold");
    act(() => setTrackPreview("L1", "opacity", trackWith({ kind: "Hold" })));
    expect(dotClass(container, "k0")).toContain("kf-interp-hold");
  });
});

describe("KeyframeCurveGraph — extrapolation", () => {
  const linear = trackWith({ kind: "Linear" });
  const loopAfter: Keyframed = { ...linear, extrapolate: { before: "Hold", after: "Loop" } };
  const tails = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="kf-curve-extrap"]')].map((p) => p.getAttribute("data-side"));
  const marks = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="kf-extrap"]')];

  it("draws nothing beyond the keys under Hold / Hold", () => {
    const { container } = renderGraph({ track: linear, clipDurationUs: 3_000_000 });
    expect(tails(container)).toEqual([]);
    expect(marks(container)).toEqual([]);
  });

  it("draws the after tail from the last key to the layer end, dashed, and a mark beside the last key", () => {
    const { container } = renderGraph({ track: loopAfter, clipDurationUs: 3_000_000 });
    expect(tails(container)).toEqual(["after"]);
    const tail = container.querySelector('[data-testid="kf-curve-extrap"]')!;
    expect(tail.getAttribute("class")).toContain("kf-curve-extrap");
    const pts = tail.getAttribute("points")!.split(" ").map((p) => p.split(",").map(Number));
    // Starts at the last key (t = 1 s → x = 100 px) and reaches the layer end (3 s → 300 px).
    expect(pts[0]![0]).toBeCloseTo(100, 6);
    expect(pts[pts.length - 1]![0]).toBeCloseTo(300, 6);
    // Loop returns to the first value at the period: at t = 2 s the value is 0
    // again, so that sample sits on the same y as k0 (the lane bottom band).
    const k0Y = Number((container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]') as HTMLElement).style.top.replace("px", ""));
    const at2s = pts.find((p) => Math.abs(p[0]! - 200) < 1e-6)!;
    expect(at2s[1]).toBeCloseTo(k0Y, 6);
    const [mark] = marks(container);
    expect(mark!.getAttribute("data-side")).toBe("after");
    expect(mark!.textContent).toBe("↻");
    expect(mark!.className).toContain("kf-extrap-loop");
    expect(mark!.getAttribute("title")).toBe("Loop");
    // 8 px right of the last diamond, no ghost diamonds past it.
    expect((mark as HTMLElement).style.left).toBe("108px");
    expect(container.querySelectorAll(".kf-sublane-diamond").length).toBe(2);
  });

  it("draws the before tail from the layer start to the first key when the first key sits inside the layer", () => {
    const shifted: Keyframed = {
      ...linear,
      extrapolate: { before: "PingPong", after: "Hold" },
      value: linear.value.map((k) => ({ ...k, t_us: k.t_us + 1_000_000 })),
    };
    const { container } = renderGraph({ track: shifted, clipDurationUs: 3_000_000 });
    expect(tails(container)).toEqual(["before"]);
    const [mark] = marks(container);
    expect(mark!.getAttribute("data-side")).toBe("before");
    expect(mark!.textContent).toBe("↔");
    expect((mark as HTMLElement).style.left).toBe("92px");
  });

  it("a lone key never extrapolates, so it gets no tail and no mark", () => {
    const lone: Keyframed = { ...loopAfter, value: [linear.value[0]!] };
    const { container } = renderGraph({ track: lone, clipDurationUs: 3_000_000 });
    expect(tails(container)).toEqual([]);
    expect(marks(container)).toEqual([]);
  });

  it("widens the value range to hold a Continue tail instead of drawing it off the lane", () => {
    // 0 → 1 over 1 s, Continue for 2 more seconds → the tail reaches 3.
    const cont: Keyframed = { ...linear, extrapolate: { before: "Hold", after: "Continue" } };
    const { container } = renderGraph({ track: cont, clipDurationUs: 3_000_000, height: 72 });
    const tail = container.querySelector('[data-testid="kf-curve-extrap"]')!;
    const ys = tail.getAttribute("points")!.split(" ").map((p) => Number(p.split(",")[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(72);
  });

  it("follows a previewed extrapolation live", () => {
    const { container } = renderGraph({ track: linear, clipDurationUs: 3_000_000 });
    expect(marks(container)).toEqual([]);
    act(() => setTrackPreview("L1", "opacity", { ...linear, extrapolate: { before: "Hold", after: "Offset" } }));
    expect(tails(container)).toEqual(["after"]);
    expect(marks(container)[0]!.textContent).toBe("⤴");
  });
});
