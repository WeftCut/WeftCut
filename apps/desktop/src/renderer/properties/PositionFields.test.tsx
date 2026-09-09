// @vitest-environment jsdom
//
// The mode switcher is the only entry to changing representation, so what
// matters is that it never leaves the user without a route: it branches on
// what the data allows and shows the consequence, instead of disabling itself
// while a second control elsewhere is the real way through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

const { setPosition } = vi.hoisted(() => ({ setPosition: vi.fn(async () => {}) }));
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  setPosition,
}));
// Isolate from the keyframe field stack: this file is about the mode choice
// and the node controls, not about how a value row renders.
vi.mock("./InspectorAnimField", () => ({
  InspectorAnimField: ({ desc }: { desc: { paramKey: string } }) => (
    <div data-testid={`field-${desc.paramKey}`} />
  ),
}));

import { PositionFields } from "./PositionFields";
import type { AnimTrack, LayerSummary } from "../ipc";
import { usePathEditingStore } from "../state/pathEditingStore";
import type { PathNode, PositionAnimation } from "../../shared/position";
import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY } from "../../shared/keyframe";

const staticTrack = (value: number): AnimTrack<number> => ({ mode: "Static", value });

const keyedTrack = (a: number, b: number): AnimTrack<number> => ({
  mode: "Keyframed",
  extrapolate: HOLD_EXTRAPOLATION,
  value: [a, b].map((value, i) => ({
    id: `k${i}`, t_us: i * 1_000_000, value,
    in: { ...IN_IDENTITY, mode: "Free" }, out: { ...OUT_IDENTITY, mode: "Free" },
    continuity: "Broken", segment: { kind: "Linear" },
  })),
});

const node = (id: string, x: number): PathNode => ({
  id, tangentMode: "Corner", point: { x, y: 100 },
  inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: "Line",
});

const pathOf = (...nodes: PathNode[]): PositionAnimation => ({
  mode: "Path",
  path: { nodes },
  progress: { mode: "Static", value: 0 },
});

const onMutated = vi.fn(async () => {});

function renderFields(position: PositionAnimation) {
  render(
    <PositionFields
      layer={{
        id: "L1",
        kind: "Text",
        t_start_us: 0,
        t_end_us: 2_000_000,
        params: { kind: "Text", x: staticTrack(0), y: staticTrack(0), position },
      } as unknown as LayerSummary}
      tInLayerUs={0}
      playheadInSpan
      onMutated={onMutated}
    />,
  );
}

const segment = (name: RegExp) => screen.getByRole("button", { name });
const conversion = () => screen.queryByTestId("position-conversion");

/// Put the canvas' selection in place BEFORE rendering — the store is the
/// canvas' channel into this panel, and a post-render write is a React update
/// outside `act`.
const selectNode = (id: string) => {
  usePathEditingStore.getState().setLayer("L1");
  usePathEditingStore.getState().setNode(id);
};

beforeEach(() => usePathEditingStore.getState().setLayer(null));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the position mode switcher", () => {
  it("builds a path outright when X and Y are static", async () => {
    renderFields({ mode: "XY", x: staticTrack(640), y: staticTrack(360) });
    await userEvent.click(segment(/^Path$/));

    expect(setPosition).toHaveBeenCalledTimes(1);
    const [layerId, next] = setPosition.mock.calls[0]! as unknown as [string, PositionAnimation];
    expect(layerId).toBe("L1");
    expect(next.mode).toBe("Path");
    // Through where the layer already is, and progress spans the layer.
    if (next.mode !== "Path") throw new Error("not a path");
    expect(next.path.nodes[0]!.point).toEqual({ x: 640, y: 360 });
    expect(next.progress.mode).toBe("Keyframed");
    // Nothing to fit, so nothing to fill in.
    expect(conversion()).toBeNull();
  });

  it("opens the fitted conversion instead when X or Y is animated", async () => {
    renderFields({ mode: "XY", x: keyedTrack(0, 600), y: staticTrack(360) });
    await userEvent.click(segment(/^Path$/));

    // Fitting is measured and applied by the well, never by the switcher.
    expect(setPosition).not.toHaveBeenCalled();
    expect(conversion()).toBeTruthy();
    expect(screen.getByText("Convert XY to path…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply conversion" })).toHaveProperty("disabled", true);
  });

  it("always bakes on the way out of path mode", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    await userEvent.click(segment(/^XY$/));

    expect(setPosition).not.toHaveBeenCalled();
    expect(screen.getByText("Bake to XY…")).toBeTruthy();
  });

  it("hides the node controls while a conversion is in flight", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    expect(screen.getByRole("button", { name: "Edit path" })).toBeTruthy();
    await userEvent.click(segment(/^XY$/));
    // Two open wells would be two focal points, and a conversion that has not
    // been applied has no nodes to edit yet.
    expect(screen.queryByRole("button", { name: "Edit path" })).toBeNull();
  });

  // `MotionPathOverlay` returns null for an unedited XY position, so this
  // toggle is the only way to see an XY trajectory — and it is meaningless in
  // path mode, where the trajectory is always drawn.
  it("carries the trajectory toggle in XY mode only", async () => {
    renderFields({ mode: "XY", x: keyedTrack(0, 600), y: staticTrack(360) });
    const eye = screen.getByRole("button", { name: "Show trajectory" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(eye);
    expect(screen.getByRole("button", { name: "Show trajectory" }).getAttribute("aria-pressed")).toBe("true");
    expect(setPosition, "asking to see the motion is not an edit").not.toHaveBeenCalled();

    cleanup();
    renderFields(pathOf(node("a", 0), node("b", 200)));
    expect(screen.queryByRole("button", { name: "Show trajectory" })).toBeNull();
  });

  it("does nothing when the active mode is chosen again", async () => {
    renderFields({ mode: "XY", x: staticTrack(640), y: staticTrack(360) });
    await userEvent.click(segment(/^XY$/));
    expect(setPosition).not.toHaveBeenCalled();
    expect(conversion()).toBeNull();
  });
});

describe("the path node well", () => {
  it("offers no node actions until the path is being edited", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    // The well says what it holds and how much of it, so the count is legible
    // without counting handles on the canvas.
    expect(document.querySelector(".prop-well-title")?.textContent).toBe("Path · 2 points");
    expect(screen.queryByRole("button", { name: "Add point" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit path" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add point" })).toBeTruthy();
  });

  it("asks for a selection rather than showing dead per-node actions", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    await userEvent.click(screen.getByRole("button", { name: "Edit path" }));

    expect(screen.getByText("Select a point on the path to edit it")).toBeTruthy();
    // Appending needs no selection, so it stands. The per-node actions are
    // absent rather than greyed: four dead controls read as a broken panel,
    // where the line above already says what to do.
    expect(screen.getByRole("button", { name: "Add point" })).toHaveProperty("disabled", false);
    for (const action of ["Insert after point", "Line / curve", "Remove point"]) {
      expect(screen.queryByRole("button", { name: action }), action).toBeNull();
    }
    expect(screen.queryByRole("group", { name: "Spatial node" })).toBeNull();
  });

  it("names the selected node and offers its tangent modes", async () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 200), node("c", 400)));

    // Which node, not just that one is selected: the canvas is where it was
    // picked, and the caption is what confirms the panel followed.
    expect(screen.getByText("Point 2 / 3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Smooth" }));

    expect(setPosition).toHaveBeenCalledTimes(1);
    const [, next] = setPosition.mock.calls[0]! as unknown as [string, PositionAnimation];
    if (next.mode !== "Path") throw new Error("not a path");
    expect(next.path.nodes[1]!.tangentMode).toBe("Smooth");
  });

  it("refuses a span action on the last node, which has no span after it", () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 200)));
    expect(screen.getByRole("button", { name: "Insert after point" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Line / curve" })).toHaveProperty("disabled", true);
    // Removing it is still fine — it is a node, just not a span start.
    expect(screen.getByRole("button", { name: "Remove point" })).toHaveProperty("disabled", false);
  });
});
